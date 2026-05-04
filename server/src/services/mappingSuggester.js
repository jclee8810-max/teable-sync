// Smart field mapping suggester
// Provides intelligent column→field matching with confidence + type compatibility

import { normalizeSqlType, suggestTeableType, isTypeCompatible } from './typeConverter.js';

/**
 * Normalize a column name for fuzzy matching.
 * - lowercased
 * - underscores removed for comparison
 * - common prefixes/suffixes stripped
 */
function normalizeForMatch(name) {
  return (name || '').toLowerCase().trim();
}

/**
 * Convert snake_case to camelCase
 */
function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Convert camelCase to snake_case
 */
function camelToSnake(str) {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Compute similarity between two names (0-1 range)
 */
function nameSimilarity(a, b) {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);

  if (na === nb) return 1.0;

  // snake_case ↔ camelCase
  const camelA = snakeToCamel(na);
  const camelB = snakeToCamel(nb);
  if (camelA === camelB) return 0.95;
  if (camelA === nb || na === camelB) return 0.92;

  // Remove underscores and compare
  const flatA = na.replace(/_/g, '');
  const flatB = nb.replace(/_/g, '');
  if (flatA === flatB) return 0.88;

  // Trim common suffixes like _id, _name, _code, _time, _date, _count, _num, _status
  const suffixes = ['_id', '_name', '_code', '_time', '_date', '_count', '_num', '_status', '_type', '_key', '_value', '_desc', '_description', 'id', 'name', 'code', 'time', 'date', 'count', 'num', 'type', 'key'];
  for (const s of suffixes) {
    if (na.endsWith(s) && nb.endsWith(s)) {
      const baseA = na.slice(0, -s.length);
      const baseB = nb.slice(0, -s.length);
      if (baseA && baseA === baseB) return 0.75;
    }
  }

  // Check if one is prefix of the other (e.g., "name" ↔ "user_name")
  if (na.startsWith(nb) || nb.startsWith(na)) return 0.65;
  if (flatA.startsWith(flatB) || flatB.startsWith(flatA)) return 0.6;

  return 0;
}

/**
 * Determine match confidence level from similarity score
 */
function confidenceLevel(similarity) {
  if (similarity >= 1.0) return { level: 'exact', confidence: 100, label: '完全匹配' };
  if (similarity >= 0.9) return { level: 'high', confidence: 90, label: '驼峰/大小写匹配' };
  if (similarity >= 0.8) return { level: 'medium', confidence: 80, label: '格式转换匹配' };
  if (similarity >= 0.65) return { level: 'low', confidence: 65, label: '部分匹配' };
  return { level: 'none', confidence: 0, label: '不匹配' };
}

/**
 * Score a potential mapping between source column and target field.
 * Returns { confidence, typeCompat, recommended }
 */
function scoreMapping(srcCol, tgtField) {
  const sim = nameSimilarity(srcCol.name, tgtField.name);
  const conf = confidenceLevel(sim);
  const compat = isTypeCompatible(srcCol.type, tgtField.type);

  // Recommendation: match only if name similarity > 0.6 AND type is compatible
  const recommended = conf.confidence >= 65 && compat.safe;

  return {
    sourceColumn: srcCol.name,
    sourceType: srcCol.type,
    targetField: tgtField.name,
    targetType: tgtField.type,
    similarity: Math.round(sim * 100),
    confidence: conf.confidence,
    confidenceLevel: conf.level,
    confidenceLabel: conf.label,
    typeSafe: compat.safe,
    typeWarning: compat.warning,
    recommended,
  };
}

/**
 * Generate smart mapping suggestions.
 *
 * @param {Array<{name, type}>} sourceColumns - Source SQL columns
 * @param {Array<{name, type}>} targetFields  - Target Teable fields
 * @returns {{
 *   mappings: Array<{
 *     sourceColumn, sourceType, targetField, targetType,
 *     similarity, confidence, confidenceLevel, confidenceLabel,
 *     typeSafe, typeWarning, recommended, action
 *   }>,
 *   unmatchedSource: Array<{name, type, suggestedTeableType}>,
 *   unmatchedTarget: Array<{name, type}>
 * }}
 */
export function suggestMappings(sourceColumns, targetFields) {
  const tgtFieldNames = new Set(targetFields.map(f => f.name));
  const srcColNames = new Set(sourceColumns.map(c => c.name));

  // Score all possible mappings
  const allScores = [];
  for (const srcCol of sourceColumns) {
    for (const tgtField of targetFields) {
      const score = scoreMapping(srcCol, tgtField);
      if (score.confidence >= 65) { // Only include potential matches
        allScores.push(score);
      }
    }
  }

  // Greedy assignment: pick highest confidence first, each source/target used once
  const usedSrc = new Set();
  const usedTgt = new Set();
  const mappings = [];

  allScores.sort((a, b) => {
    // Recommended first, then by confidence, then type-safe first
    if (a.recommended !== b.recommended) return b.recommended - a.recommended;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.typeSafe !== b.typeSafe) return b.typeSafe - a.typeSafe;
    return b.similarity - a.similarity;
  });

  for (const score of allScores) {
    if (usedSrc.has(score.sourceColumn) || usedTgt.has(score.targetField)) continue;
    usedSrc.add(score.sourceColumn);
    usedTgt.add(score.targetField);
    score.action = 'map'; // will be sent to target field
    mappings.push(score);
  }

  // Unmatched source columns → suggest creating new fields
  const unmatchedSource = [];
  for (const srcCol of sourceColumns) {
    if (usedSrc.has(srcCol.name)) continue;
    const suggestion = suggestTeableType(srcCol.type);
    unmatchedSource.push({
      name: srcCol.name,
      type: srcCol.type,
      suggestedTeableType: suggestion.type,
      suggestedOptions: suggestion.options,
      suggestionSafe: suggestion.safe,
      suggestionWarning: suggestion.warning,
      action: 'create',
    });
  }

  // Unmatched target fields
  const unmatchedTarget = [];
  for (const tgtField of targetFields) {
    if (usedTgt.has(tgtField.name)) continue;
    unmatchedTarget.push({
      name: tgtField.name,
      type: tgtField.type,
      action: 'unmapped',
    });
  }

  return { mappings, unmatchedSource, unmatchedTarget };
}

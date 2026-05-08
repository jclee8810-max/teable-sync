import { query, getTableSchema } from './dbService.js';
import { getTeableFields, getTeableRecords, normalizeTeableRecordsResponse, teableFieldToSourceColumn } from './teableService.js';
import { convertValue } from './typeConverter.js';
import { detectWatermarkCandidates } from './syncEngine.js';

const DEFAULT_LIMIT = 10000;
const DEFAULT_SAMPLE_LIMIT = 100;
const PAGE_SIZE = 1000;
const DEFAULT_DATE_TIME_ZONE = process.env.RECONCILE_DATE_TIME_ZONE || 'Asia/Shanghai';

function quoteIdentifier(type, name) {
  if (!/^[a-zA-Z0-9_.]+$/.test(name)) throw new Error(`非法标识符: ${name}`);
  const parts = name.split('.');
  if (type === 'mssql') return parts.map((p) => `[${p.replace(/]/g, ']]')}]`).join('.');
  if (type === 'mysql') return parts.map((p) => `\`${p.replace(/`/g, '``')}\``).join('.');
  if (type === 'pg') return parts.map((p) => `"${p.replace(/"/g, '""')}"`).join('.');
  throw new Error(`Unsupported database type: ${type}`);
}

function placeholder(type, index) {
  return type === 'pg' ? `$${index + 1}` : '?';
}

function isSqlDateType(type) {
  return ['date', 'datetime', 'datetime2', 'smalldatetime', 'timestamp', 'timestamp without time zone', 'timestamp with time zone'].includes(String(type || '').toLowerCase());
}

function datePartsInTimeZone(value, timeZone = DEFAULT_DATE_TIME_ZONE) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function normalizeDateOnlyValue(value, timeZone = DEFAULT_DATE_TIME_ZONE) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return datePartsInTimeZone(value, timeZone);
  if (typeof value === 'string') {
    const direct = value.match(/^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/);
    if (direct && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return direct[1];
  }
  return datePartsInTimeZone(value, timeZone);
}

function normalizeDateTimeValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function comparisonValue(value, srcType, tgtField) {
  if ((value === null || value === undefined || value === '')) return null;
  const targetType = String(tgtField?.type || '').toLowerCase();
  const targetDateOptions = tgtField?.options?.formatting || tgtField?.options || {};
  const timeZone = targetDateOptions.timeZone || DEFAULT_DATE_TIME_ZONE;
  const targetHasTime = targetDateOptions.time && String(targetDateOptions.time).toLowerCase() !== 'none';

  if (targetType === 'date') {
    if (targetHasTime) return normalizeDateTimeValue(value);
    return normalizeDateOnlyValue(value, timeZone);
  }
  if (isSqlDateType(srcType)) {
    return normalizeDateTimeValue(value) || normalizeDateOnlyValue(value, timeZone);
  }
  return value;
}

function valuesEqual(a, b, srcType, tgtField) {
  if (a === b) return true;
  if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) return true;
  const left = comparisonValue(a, srcType, tgtField);
  const right = comparisonValue(b, srcType, tgtField);
  if (left === right) return true;
  return String(left) === String(right);
}

function normalizeSourceRow(row, mapping, srcTypeMap, tgtTypeMap) {
  const fields = {};
  for (const [srcCol, tgtField] of Object.entries(mapping)) {
    let value = row[srcCol];
    if (value === undefined || value === null) {
      fields[tgtField] = null;
      continue;
    }
    if (srcTypeMap[srcCol] && tgtTypeMap[tgtField]) value = convertValue(value, srcTypeMap[srcCol], tgtTypeMap[tgtField]);
    else if (value instanceof Date) value = value.toISOString();
    else if (Buffer.isBuffer(value)) value = null;
    fields[tgtField] = value;
  }
  return fields;
}

function isTeableSource(conn) {
  return conn?.type === 'teable';
}

function normalizeSourceType(type, sourceKind) {
  return sourceKind === 'teable' ? 'teable:' + type : type;
}

async function loadSourceRows(task, srcConn, srcTypeMap, tgtTypeMap, mapping, pkCol, limit) {
  const rows = [];
  if (isTeableSource(srcConn)) {
    let skip = 0;
    while (rows.length < limit) {
      const take = Math.min(PAGE_SIZE, limit - rows.length);
      const result = await getTeableRecords(srcConn, task.sourceTable, { skip, take });
      const page = normalizeTeableRecordsResponse(result);
      if (page.length === 0) break;
      for (const rec of page) {
        const source = rec.fields || rec;
        const pk = source[pkCol];
        if (pk !== undefined && pk !== null) {
          rows.push({
            pk: String(pk),
            fields: normalizeSourceRow(source, mapping, srcTypeMap, tgtTypeMap),
          });
        }
      }
      if (page.length < take) break;
      skip += take;
    }
    return rows;
  }

  const db = task.sourceDatabase || null;
  const table = quoteIdentifier(srcConn.type, task.sourceTable);
  const pkIdentifier = quoteIdentifier(srcConn.type, pkCol);
  let cursor = null;
  while (rows.length < limit) {
    const params = [];
    let sql = `SELECT * FROM ${table}`;
    if (cursor !== null && cursor !== undefined) {
      sql += ` WHERE ${pkIdentifier} > ${placeholder(srcConn.type, 0)}`;
      params.push(cursor);
    }
    const take = Math.min(PAGE_SIZE, limit - rows.length);
    if (srcConn.type === 'mssql') {
      sql += ` ORDER BY ${pkIdentifier} ASC OFFSET 0 ROWS FETCH NEXT ${placeholder(srcConn.type, params.length)} ROWS ONLY`;
    } else {
      sql += ` ORDER BY ${pkIdentifier} ASC LIMIT ${placeholder(srcConn.type, params.length)}`;
    }
    params.push(take);
    const page = await query(srcConn, sql, params, db);
    if (page.length === 0) break;
    for (const row of page) {
      rows.push({
        pk: String(row[pkCol]),
        fields: normalizeSourceRow(row, mapping, srcTypeMap, tgtTypeMap),
      });
    }
    cursor = page[page.length - 1][pkCol];
    if (page.length < take) break;
  }
  return rows;
}

async function loadTargetRows(tgtConn, tableId, pkFieldName, limit) {
  const rows = [];
  let skip = 0;
  while (rows.length < limit) {
    const take = Math.min(PAGE_SIZE, limit - rows.length);
    const result = await getTeableRecords(tgtConn, tableId, { skip, take });
    let page;
    if (Array.isArray(result)) page = result;
    else if (result?.records) page = result.records;
    else if (result?.data) page = result.data.records || result.data;
    else page = [];
    if (page.length === 0) break;
    for (const rec of page) {
      const fields = rec.fields || rec;
      const pk = fields[pkFieldName];
      if (pk !== undefined && pk !== null) rows.push({ pk: String(pk), id: rec.id || rec.recordId, fields });
    }
    if (page.length < take) break;
    skip += take;
  }
  return rows;
}

export async function reconcileTask(task, srcConn, tgtConn, options = {}) {
  const limit = Math.min(Number(options.limit || DEFAULT_LIMIT), 50000);
  const sampleLimit = Math.min(Number(options.sampleLimit || DEFAULT_SAMPLE_LIMIT), 500);
  const sourceKind = isTeableSource(srcConn) ? 'teable' : 'sql';
  const sourceSchema = sourceKind === 'teable'
    ? (await getTeableFields(srcConn, task.sourceTable)).map(teableFieldToSourceColumn)
    : await getTableSchema(srcConn, task.sourceTable, task.sourceDatabase || null);
  const targetFields = await getTeableFields(tgtConn, task.targetTableId);
  const mapping = task.columnMapping || {};
  const { pkCol: detectedPkCol } = await detectWatermarkCandidates(srcConn, task.sourceTable, task.sourceDatabase || null);
  const pkCol = task.sourcePrimaryKey || detectedPkCol;
  if (!pkCol) throw new Error('一致性校验无法自动检测主键列，请先在任务中配置主键列');
  const effectiveMapping = Object.keys(mapping).length > 0
    ? mapping
    : Object.fromEntries(sourceSchema.map((col) => [col.name, col.name]));
  const pkFieldName = effectiveMapping[pkCol] || pkCol;
  const srcTypeMap = Object.fromEntries(sourceSchema.map((col) => [col.name, normalizeSourceType(col.type, sourceKind)]));
  const tgtTypeMap = Object.fromEntries(targetFields.map((field) => [field.name, field.type]));
  const targetFieldMap = Object.fromEntries(targetFields.map((field) => [field.name, field]));
  const sourceFieldByTarget = Object.fromEntries(Object.entries(effectiveMapping).map(([src, tgt]) => [tgt, src]));

  const sourceRows = await loadSourceRows(task, srcConn, srcTypeMap, tgtTypeMap, effectiveMapping, pkCol, limit);
  const targetRows = await loadTargetRows(tgtConn, task.targetTableId, pkFieldName, limit);
  const sourceMap = new Map(sourceRows.map((row) => [row.pk, row]));
  const targetMap = new Map(targetRows.map((row) => [row.pk, row]));

  const missingInTarget = [];
  const extraInTarget = [];
  const mismatched = [];

  for (const [pk, source] of sourceMap.entries()) {
    const target = targetMap.get(pk);
    if (!target) {
      if (missingInTarget.length < sampleLimit) missingInTarget.push({ pk });
      continue;
    }
    const diffs = [];
    for (const field of Object.values(effectiveMapping)) {
      const srcCol = sourceFieldByTarget[field];
      if (!valuesEqual(source.fields[field], target.fields[field], srcTypeMap[srcCol], targetFieldMap[field])) {
        diffs.push({ field, source: source.fields[field], target: target.fields[field] });
      }
    }
    if (diffs.length > 0 && mismatched.length < sampleLimit) mismatched.push({ pk, diffs: diffs.slice(0, 5) });
  }

  for (const pk of targetMap.keys()) {
    if (!sourceMap.has(pk) && extraInTarget.length < sampleLimit) extraInTarget.push({ pk });
  }

  const missingCount = [...sourceMap.keys()].filter((pk) => !targetMap.has(pk)).length;
  const extraCount = [...targetMap.keys()].filter((pk) => !sourceMap.has(pk)).length;
  let mismatchCount = 0;
  for (const [pk, source] of sourceMap.entries()) {
    const target = targetMap.get(pk);
    if (!target) continue;
    if (Object.values(effectiveMapping).some((field) => {
      const srcCol = sourceFieldByTarget[field];
      return !valuesEqual(source.fields[field], target.fields[field], srcTypeMap[srcCol], targetFieldMap[field]);
    })) mismatchCount++;
  }

  return {
    checkedAt: new Date().toISOString(),
    limited: sourceRows.length >= limit || targetRows.length >= limit,
    limit,
    sourceRows: sourceRows.length,
    targetRows: targetRows.length,
    missingInTarget: missingCount,
    extraInTarget: extraCount,
    mismatched: mismatchCount,
    samples: { missingInTarget, extraInTarget, mismatched },
  };
}

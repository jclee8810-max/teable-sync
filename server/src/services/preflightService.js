import { getTableSchema, query } from './dbService.js';
import { getTeableFields, getTeableRecords, normalizeTeableRecordsResponse, teableFieldToSourceColumn } from './teableService.js';
import { detectWatermarkCandidates } from './syncEngine.js';
import { isTypeCompatible } from './typeConverter.js';

const SAMPLE_LIMIT = 50;
const TEABLE_MAX_BATCH_SIZE = 1000;

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

function sourceType(type, conn) {
  return conn.type === 'teable' ? `teable:${type}` : type;
}

function fieldOptions(field) {
  const candidates = [
    field?.options?.choices,
    field?.options?.choice,
    field?.options?.options,
    field?.options?.items,
    field?.options?.selectOptions,
  ];
  const raw = candidates.find((value) => Array.isArray(value)) || [];
  return raw.map((item) => typeof item === 'string' ? item : item?.name || item?.label || item?.value).filter(Boolean);
}

function isSelectField(field) {
  return ['singleSelect', 'multipleSelect'].includes(field?.type);
}

async function getSourceSchema(srcConn, task) {
  if (srcConn.type === 'teable') {
    return (await getTeableFields(srcConn, task.sourceTable)).map(teableFieldToSourceColumn);
  }
  return getTableSchema(srcConn, task.sourceTable, task.sourceDatabase || null);
}

async function sampleRows(srcConn, task, limit = SAMPLE_LIMIT) {
  if (srcConn.type === 'teable') {
    const result = await getTeableRecords(srcConn, task.sourceTable, { skip: 0, take: limit });
    return normalizeTeableRecordsResponse(result).map((rec) => rec.fields || rec);
  }
  const schema = await getTableSchema(srcConn, task.sourceTable, task.sourceDatabase || null);
  const tableName = quoteIdentifier(srcConn.type, task.sourceTable);
  const columns = schema.map((col) => quoteIdentifier(srcConn.type, col.name)).join(', ');
  if (!columns) return [];
  const sql = srcConn.type === 'mssql'
    ? `SELECT TOP (${placeholder(srcConn.type, 0)}) ${columns} FROM ${tableName}`
    : `SELECT ${columns} FROM ${tableName} LIMIT ${placeholder(srcConn.type, 0)}`;
  return query(srcConn, sql, [limit], task.sourceDatabase || null);
}

function addIssue(issues, level, code, message, detail = {}) {
  issues.push({ level, code, message, ...detail });
}

function normalizeMapping(mapping = {}) {
  if (Array.isArray(mapping)) {
    return Object.fromEntries(mapping.filter((row) => row?.source && row?.target).map((row) => [row.source, row.target]));
  }
  return mapping || {};
}

function mappedTargetNames(mapping) {
  return new Set(Object.values(mapping).filter(Boolean));
}

function requiredFieldsForTask(task) {
  const missing = [];
  if (!task.name) missing.push('任务名称');
  if (!task.sourceConnectionId && !task.sourceId) missing.push('源连接');
  if (!task.sourceTable) missing.push('源表');
  if (!task.targetConnectionId && !task.targetId) missing.push('目标连接');
  if (!task.targetTableId) missing.push('目标表');
  return missing;
}

function checkTaskSettings(task, srcConn, issues) {
  const missing = requiredFieldsForTask(task);
  if (missing.length) addIssue(issues, 'error', 'task.requiredMissing', `缺少必要配置: ${missing.join(', ')}`);
  const pageSize = Number(task.pageSize || 1000);
  const batchSize = Number(task.batchSize || 500);
  const retryCount = Number(task.retryCount || 3);
  if (!Number.isFinite(pageSize) || pageSize < 100 || pageSize > 5000) {
    addIssue(issues, 'error', 'settings.pageSizeInvalid', '源分页大小必须在 100-5000 之间');
  } else if (pageSize > 3000) {
    addIssue(issues, 'warn', 'settings.pageSizeLarge', '源分页大小较大，可能增加单次查询压力');
  }
  if (!Number.isFinite(batchSize) || batchSize < 10 || batchSize > TEABLE_MAX_BATCH_SIZE) {
    addIssue(issues, 'error', 'settings.batchSizeInvalid', `Teable 写入批量必须在 10-${TEABLE_MAX_BATCH_SIZE} 之间`);
  } else if (batchSize > 500) {
    addIssue(issues, 'warn', 'settings.batchSizeLarge', 'Teable 写入批量较大，遇到限流时单批重试成本更高');
  }
  if (!Number.isFinite(retryCount) || retryCount < 1 || retryCount > 8) {
    addIssue(issues, 'error', 'settings.retryCountInvalid', '失败重试次数必须在 1-8 之间');
  }
  if (task.syncMode === 'realtime' && Number(task.syncInterval || 300) < 30) {
    addIssue(issues, 'error', 'settings.realtimeIntervalInvalid', '准实时轮询间隔不能小于 30 秒');
  }
  if (task.syncDirection === 'bidirectional' && (srcConn.type !== 'teable')) {
    addIssue(issues, 'error', 'direction.bidirectionalSourceInvalid', '双向同步仅支持 Teable 作为源端');
  }
  if (task.syncDirection === 'bidirectional' && task.deletionMode && task.deletionMode !== 'ignore') {
    addIssue(issues, 'warn', 'direction.bidirectionalDeletionIgnored', '双向同步暂不执行删除同步，删除策略会被忽略');
  }
  if (task.deletionMode && task.deletionMode !== 'ignore' && task.watermarkType !== 'full_scan') {
    addIssue(issues, 'warn', 'deletion.fullScanRequired', '删除检测需要全量扫描；当前增量策略下会跳过删除同步');
  }
  if (task.deletionMode === 'soft_delete' && !/^[a-zA-Z0-9_]+$/.test(task.softDeleteField || '')) {
    addIssue(issues, 'error', 'deletion.softDeleteFieldInvalid', '软删除字段名只能包含字母、数字和下划线');
  }
}

function checkMappingCoverage({ mapping, sourceSchema, targetFields, issues }) {
  const sourceMapped = new Set(Object.keys(mapping));
  const targetMapped = mappedTargetNames(mapping);
  const unmappedSource = sourceSchema.filter((col) => !sourceMapped.has(col.name));
  const unmappedTarget = targetFields.filter((field) => !targetMapped.has(field.name));
  if (unmappedSource.length > 0) {
    addIssue(issues, 'warn', 'mapping.sourceUnmapped', `有 ${unmappedSource.length} 个源字段未映射`, {
      fields: unmappedSource.slice(0, 12).map((col) => col.name),
    });
  }
  if (unmappedTarget.length > 0) {
    addIssue(issues, 'info', 'mapping.targetUnmapped', `有 ${unmappedTarget.length} 个目标字段不会被写入`, {
      fields: unmappedTarget.slice(0, 12).map((field) => field.name),
    });
  }
}

function sampleConversionRisks({ samples, mapping, sourceMap, targetMap, srcConn, issues }) {
  const invalidNumbers = {};
  const invalidDates = {};
  for (const [src, tgt] of Object.entries(mapping)) {
    const srcCol = sourceMap[src];
    const targetField = targetMap[tgt];
    if (!srcCol || !targetField) continue;
    const targetType = String(targetField.type || '').toLowerCase();
    for (const row of samples) {
      const value = row[src];
      if (value === undefined || value === null || value === '') continue;
      if (targetType === 'number' && !Number.isFinite(Number(value))) {
        invalidNumbers[src] = (invalidNumbers[src] || 0) + 1;
      }
      if (targetType === 'date' && Number.isNaN(new Date(value).getTime())) {
        invalidDates[src] = (invalidDates[src] || 0) + 1;
      }
    }
    const compat = isTypeCompatible(sourceType(srcCol.type, srcConn), targetField.type);
    if (compat.safe && invalidNumbers[src]) {
      addIssue(issues, 'error', 'sample.numberInvalid', `${src} -> ${tgt}: 样本中有 ${invalidNumbers[src]} 个值无法转换为数字`, { source: src, target: tgt });
    }
    if (compat.safe && invalidDates[src]) {
      addIssue(issues, 'error', 'sample.dateInvalid', `${src} -> ${tgt}: 样本中有 ${invalidDates[src]} 个值无法转换为日期`, { source: src, target: tgt });
    }
  }
}

export async function runTaskPreflight(task, srcConn, tgtConn) {
  const issues = [];
  checkTaskSettings(task, srcConn, issues);
  const sourceSchema = await getSourceSchema(srcConn, task);
  const targetFields = await getTeableFields(tgtConn, task.targetTableId);
  const sourceMap = Object.fromEntries(sourceSchema.map((col) => [col.name, col]));
  const targetMap = Object.fromEntries(targetFields.map((field) => [field.name, field]));
  const mapping = normalizeMapping(task.columnMapping || task.fieldMapping || {});

  if (!Object.keys(mapping).length) {
    addIssue(issues, 'warn', 'mapping.empty', '未配置字段映射，将依赖同名字段或自动字段处理');
  } else {
    checkMappingCoverage({ mapping, sourceSchema, targetFields, issues });
  }

  let pkCol = task.sourcePrimaryKey;
  if (!pkCol) {
    const detected = await detectWatermarkCandidates(srcConn, task.sourceTable, task.sourceDatabase || null);
    pkCol = detected.pkCol;
  }
  if (!pkCol) addIssue(issues, 'error', 'primaryKey.missing', '未配置主键列，且无法自动检测');
  else if (!sourceMap[pkCol]) addIssue(issues, 'error', 'primaryKey.notFound', `主键列不存在: ${pkCol}`);

  for (const [src, tgt] of Object.entries(mapping)) {
    const srcCol = sourceMap[src];
    const tgtField = targetMap[tgt];
    if (!srcCol) {
      addIssue(issues, 'error', 'mapping.sourceMissing', `源字段不存在: ${src}`, { source: src, target: tgt });
      continue;
    }
    if (!tgtField) {
      addIssue(issues, 'warn', 'mapping.targetMissing', `目标字段不存在，将尝试自动创建: ${tgt}`, { source: src, target: tgt });
      continue;
    }
    const compat = isTypeCompatible(sourceType(srcCol.type, srcConn), tgtField.type);
    if (!compat.safe) addIssue(issues, 'warn', 'mapping.typeRisk', `${src} -> ${tgt}: ${compat.warning || '类型可能不兼容'}`, { source: src, target: tgt });
  }

  const pkFieldName = mapping[pkCol] || pkCol;
  if (!targetMap[pkFieldName]) addIssue(issues, 'warn', 'primaryKey.targetMissing', `目标主键字段不存在，将尝试自动创建: ${pkFieldName}`);

  const samples = await sampleRows(srcConn, task);
  const emptyPk = samples.filter((row) => pkCol && (row[pkCol] === undefined || row[pkCol] === null || row[pkCol] === '')).length;
  if (emptyPk > 0) addIssue(issues, 'warn', 'primaryKey.emptySamples', `样本中有 ${emptyPk} 条主键为空，运行时会跳过`);
  sampleConversionRisks({ samples, mapping, sourceMap, targetMap, srcConn, issues });

  for (const [src, tgt] of Object.entries(mapping)) {
    const targetField = targetMap[tgt];
    if (!isSelectField(targetField)) continue;
    const allowed = fieldOptions(targetField);
    if (allowed.length === 0) continue;
    const invalid = new Set();
    for (const row of samples) {
      const value = row[src];
      if (value === undefined || value === null || value === '') continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        const normalized = typeof item === 'object' ? item?.name || item?.label || item?.value : item;
        if (normalized != null && !allowed.includes(String(normalized))) invalid.add(String(normalized));
      }
    }
    if (invalid.size > 0) {
      addIssue(issues, 'error', 'target.selectOptionsMissing', `${src} -> ${tgt}: 目标选项缺少 ${[...invalid].slice(0, 8).join(', ')}`, { source: src, target: tgt, invalidValues: [...invalid] });
    }
  }

  const errorCount = issues.filter((issue) => issue.level === 'error').length;
  const warnCount = issues.filter((issue) => issue.level === 'warn').length;
  const infoCount = issues.filter((issue) => issue.level === 'info').length;
  const checksTotal = 10;
  return {
    ok: errorCount === 0,
    status: errorCount ? 'fail' : warnCount ? 'warn' : 'pass',
    summary: { error: errorCount, warn: warnCount, info: infoCount, pass: Math.max(0, checksTotal - errorCount - warnCount - infoCount) },
    checkedAt: new Date().toISOString(),
    sourceFields: sourceSchema.length,
    targetFields: targetFields.length,
    sampleRows: samples.length,
    issues,
  };
}

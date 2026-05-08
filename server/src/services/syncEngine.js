// Sync engine - incremental sync with conflict detection
// Supports 4 watermark strategies:
//   timestamp  — use a datetime/timestamp column (WHERE col > lastSyncAt)
//   rowversion — use MSSQL rowversion column (any UPDATE auto-increments it)
//   auto_pk    — use auto-incrementing PK as high-water mark (only catches new inserts)
//   full_scan  — always pull all records (no watermark, most reliable)
//
// Strategy is read from task.watermarkType, auto-detected if not set:
//   1. If task has explicit watermarkType → use it
//   2. Auto-detect: rowversion (MSSQL) → timestamp → auto_pk → full_scan

import { query, getTableSchema } from './dbService.js';
import { getTeableFields, getTeableRecords, createTeableRecords, updateTeableRecords, deleteTeableRecords, createTeableField, ensureTeableFields, normalizeTeableRecordsResponse, teableFieldToSourceColumn } from './teableService.js';
import { createSyncHistory, updateSyncHistory } from './syncHistory.js';
import { addSyncFailure, clearSyncFailures } from './syncFailures.js';
import { convertValue } from './typeConverter.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(dirname(dirname(__dirname)), 'data', 'sync-state');
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

// P1-1: Task-level sync lock to prevent concurrent runs of the same task
const syncLocks = new Set();

function quoteIdentifier(type, name) {
  if (!/^[a-zA-Z0-9_.]+$/.test(name)) {
    throw new Error(`非法标识符: ${name}`);
  }
  const parts = name.split('.');
  if (type === 'mssql') return parts.map((p) => `[${p.replace(/]/g, ']]')}]`).join('.');
  if (type === 'mysql') return parts.map((p) => `\`${p.replace(/`/g, '``')}\``).join('.');
  if (type === 'pg') return parts.map((p) => `"${p.replace(/"/g, '""')}"`).join('.');
  throw new Error(`Unsupported database type: ${type}`);
}

function placeholder(type, index) {
  return type === 'pg' ? `$${index + 1}` : '?';
}

function toPositiveInt(value, fallback, max = 5000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function isSafeIdentifier(name) {
  return /^[a-zA-Z0-9_]+$/.test(name || '');
}

function isTeableSource(conn) {
  return conn?.type === 'teable';
}

function normalizeSourceType(type, sourceKind) {
  return sourceKind === 'teable' ? 'teable:' + type : type;
}

function unwrapTeableRecord(rec) {
  return rec?.fields || rec || {};
}

function isTimestampLike(value) {
  return value instanceof Date || typeof value === 'string' || typeof value === 'number';
}

export function normalizeTimestampWatermark(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString();
}

export function compareWatermarkValues(a, b) {
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (isTimestampLike(a) || isTimestampLike(b)) {
    const ta = new Date(a).getTime();
    const tb = new Date(b).getTime();
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  }
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}

function buildPagedSql(type, baseSql, orderBy, limit, offset, paramStart) {
  if (type === 'mssql') {
    return {
      sql: baseSql + ' ORDER BY ' + orderBy + ' OFFSET ' + placeholder(type, paramStart) + ' ROWS FETCH NEXT ' + placeholder(type, paramStart + 1) + ' ROWS ONLY',
      params: [offset, limit],
    };
  }
  return {
    sql: baseSql + ' ORDER BY ' + orderBy + ' LIMIT ' + placeholder(type, paramStart) + ' OFFSET ' + placeholder(type, paramStart + 1),
    params: [limit, offset],
  };
}

function buildKeysetSql(type, baseSql, orderIdentifier, cursor, limit, paramStart) {
  const hasWhere = /\swhere\s/i.test(baseSql);
  let sql = baseSql;
  const params = [];
  if (cursor !== undefined && cursor !== null) {
    sql += (hasWhere ? ' AND ' : ' WHERE ') + orderIdentifier + ' > ' + placeholder(type, paramStart);
    params.push(cursor);
  }
  if (type === 'mssql') {
    sql += ' ORDER BY ' + orderIdentifier + ' ASC OFFSET 0 ROWS FETCH NEXT ' + placeholder(type, paramStart + params.length) + ' ROWS ONLY';
  } else {
    sql += ' ORDER BY ' + orderIdentifier + ' ASC LIMIT ' + placeholder(type, paramStart + params.length);
  }
  params.push(limit);
  return { sql, params };
}

async function withRetry(fn, attempts, log, label) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts) break;
      const waitMs = 500 * 2 ** (attempt - 1);
      log('warn', '  重试 ' + label + ' (' + attempt + '/' + attempts + '): ' + err.message);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastErr;
}

function createRecordFields(row, mapping, srcTypeMap, tgtTypeMap, log) {
  const recordFields = {};
  for (const [srcCol, tgtField] of Object.entries(mapping)) {
    let val = row[srcCol];
    if (val === undefined || val === null) {
      recordFields[tgtField] = null;
      continue;
    }
    const sqlType = srcTypeMap[srcCol];
    const teableType = tgtTypeMap[tgtField];
    if (sqlType && teableType) {
      val = convertValue(val, sqlType, teableType);
    } else {
      if (val instanceof Date) val = val.toISOString();
      if (Buffer.isBuffer(val)) {
        log('warn', '  字段 ' + srcCol + ' 含二进制数据,已跳过');
        val = null;
      }
    }
    recordFields[tgtField] = val;
  }
  return recordFields;
}

function extractBatchPrimaryKeys(records, pkFieldName) {
  return records.map((rec) => rec.fields?.[pkFieldName]).filter((v) => v !== undefined && v !== null).map(String);
}

function isBidirectionalTask(task) {
  return task?.syncDirection === 'bidirectional' || task?.direction === 'bidirectional';
}

function normalizeBidirectionalStrategy(strategy) {
  if (strategy === 'target_wins' || strategy === 'latest_wins' || strategy === 'skip_conflict') return strategy;
  if (strategy === 'skip' || strategy === 'insert_only') return 'skip_conflict';
  return 'source_wins';
}

function getTeableModifiedTime(record) {
  const fields = record?.fields || {};
  const value = record?.lastModifiedTime || record?.modifiedTime || record?.updatedTime || record?.createdTime
    || fields.lastModifiedTime || fields.modifiedTime || fields.updatedTime || fields.createdTime;
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function stableValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = stableValue(value[key]);
    return sorted;
  }
  return value;
}

function valuesEqual(a, b) {
  return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}

function fieldsDiffer(candidateFields, existingFields) {
  for (const [field, value] of Object.entries(candidateFields)) {
    if (!valuesEqual(value, existingFields?.[field])) return true;
  }
  return false;
}

function isWritableTeableField(field) {
  const type = String(field?.type || '').toLowerCase();
  return !['autonumber', 'formula', 'rollup', 'lookup', 'createdtime', 'lastmodifiedtime', 'createdby', 'lastmodifiedby'].includes(type);
}

function indexFieldsByName(fields) {
  const map = new Map();
  for (const field of fields || []) map.set(field.name, field);
  return map;
}

async function loadAllTeableRecords(conn, tableId, pageSize, retryCount, log, label, checkCancelled, report) {
  const records = [];
  let offset = 0;
  while (true) {
    checkCancelled();
    if (report) report(records.length);
    const result = await withRetry(() => getTeableRecords(conn, tableId, { skip: offset, take: pageSize }), retryCount, log, label);
    const page = normalizeTeableRecordsResponse(result);
    records.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return records;
}

async function flushBidirectionalWrites({
  task,
  conn,
  tableId,
  inserts,
  updates,
  batchSize,
  retryCount,
  log,
  pkFieldName,
  operationLabel,
}) {
  let inserted = 0;
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < inserts.length; i += batchSize) {
    const batch = inserts.slice(i, i + batchSize);
    try {
      await withRetry(() => createTeableRecords(conn, tableId, batch), retryCount, log, operationLabel + '新增');
      inserted += batch.length;
    } catch (err) {
      failed += batch.length;
      addSyncFailure({
        task,
        operation: 'insert',
        tableId,
        records: batch,
        primaryKeys: extractBatchPrimaryKeys(batch, pkFieldName),
        error: err,
      });
      log('warn', operationLabel + '新增失败: ' + err.message);
    }
  }

  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates.slice(i, i + batchSize);
    try {
      await withRetry(() => updateTeableRecords(conn, tableId, batch), retryCount, log, operationLabel + '更新');
      updated += batch.length;
    } catch (err) {
      failed += batch.length;
      addSyncFailure({
        task,
        operation: 'update',
        tableId,
        records: batch,
        primaryKeys: extractBatchPrimaryKeys(batch, pkFieldName),
        error: err,
      });
      log('warn', operationLabel + '更新失败: ' + err.message);
    }
  }

  return { inserted, updated, failed };
}

async function runBidirectionalTeableSync(task, srcConn, tgtConn, context) {
  const { taskId, startTime, pageSize, batchSize, retryCount, log, report, checkCancelled } = context;
  if (!isTeableSource(srcConn) || !isTeableSource(tgtConn)) {
    throw new Error('双向同步仅支持 Teable ↔ Teable 任务');
  }

  const strategy = normalizeBidirectionalStrategy(task.conflictStrategy);
  const historyRec = createSyncHistory(taskId, task.name, task.sourceTable, task.targetTableId);
  historyRec.mode = 'bidirectional';
  log('info', '双向同步模式: Teable ↔ Teable | 冲突策略: ' + strategy + ' | 分页: ' + pageSize + '/页 | 写入批量: ' + batchSize);
  report({ phase: 'preparing', mode: 'bidirectional', pageSize, batchSize, processedRows: 0 });

  const [srcFields, tgtFields] = await Promise.all([
    getTeableFields(srcConn, task.sourceTable),
    getTeableFields(tgtConn, task.targetTableId),
  ]);
  const srcFieldMap = indexFieldsByName(srcFields);
  const tgtFieldMap = indexFieldsByName(tgtFields);
  const sourceSchema = srcFields.map(teableFieldToSourceColumn);
  const columnMapping = task.columnMapping || {};
  const { mapping: autoMapping, createdFields } = await ensureTeableFields(tgtConn, task.targetTableId, sourceSchema, columnMapping, tgtFields, log);
  const mapping = { ...autoMapping, ...columnMapping };

  for (const [srcCol, tgtField] of Object.entries(columnMapping)) {
    const created = createdFields.find(f => f.col === srcCol);
    if (created) {
      mapping[srcCol] = created.fieldName;
    } else if (!tgtFieldMap.has(tgtField)) {
      log('warn', '用户映射 ' + srcCol + '->' + tgtField + '，但目标字段不存在，已忽略此映射');
      delete mapping[srcCol];
    }
  }

  for (const [srcCol, tgtField] of Object.entries({ ...mapping })) {
    const srcField = srcFieldMap.get(srcCol);
    const tgtFieldMeta = tgtFieldMap.get(tgtField) || createdFields.find(f => f.fieldName === tgtField);
    if (!srcField || !tgtFieldMeta) {
      delete mapping[srcCol];
      continue;
    }
    if (!isWritableTeableField(srcField) || !isWritableTeableField(tgtFieldMeta)) {
      log('warn', '跳过不可写字段映射: ' + srcCol + '->' + tgtField);
      delete mapping[srcCol];
    }
  }

  const { pkCol: autoPkCol } = await detectWatermarkCandidates(srcConn, task.sourceTable);
  const pkCol = task.sourcePrimaryKey || autoPkCol;
  if (!pkCol) throw new Error('无法检测到主键列,请手动配置 sourcePrimaryKey');
  const pkFieldName = mapping[pkCol] || pkCol;
  if (!mapping[pkCol]) mapping[pkCol] = pkFieldName;
  if (!srcFieldMap.has(pkCol)) throw new Error('源主键字段不存在: ' + pkCol);
  if (!tgtFieldMap.has(pkFieldName) && !createdFields.find(f => f.fieldName === pkFieldName)) throw new Error('目标主键字段不存在: ' + pkFieldName);

  const reverseMapping = {};
  for (const [srcCol, tgtField] of Object.entries(mapping)) reverseMapping[tgtField] = srcCol;

  const srcTypeMap = {};
  for (const field of srcFields) srcTypeMap[field.name] = normalizeSourceType(field.type, 'teable');
  const tgtTypeMap = {};
  for (const field of tgtFields) tgtTypeMap[field.name] = field.type;
  for (const cf of createdFields) tgtTypeMap[cf.fieldName] = cf.type;

  log('info', '字段映射: ' + Object.entries(mapping).map(([k, v]) => k + '↔' + v).join(', '));
  report({ phase: 'loading_source', processedRows: 0 });
  const sourceRecords = await loadAllTeableRecords(srcConn, task.sourceTable, pageSize, retryCount, log, '读取源 Teable 记录', checkCancelled, (count) => {
    report({ phase: 'loading_source', processedRows: count });
  });
  report({ phase: 'loading_target', processedRows: sourceRecords.length, targetRows: 0 });
  const targetRecords = await loadAllTeableRecords(tgtConn, task.targetTableId, pageSize, retryCount, log, '读取目标 Teable 记录', checkCancelled, (count) => {
    report({ phase: 'loading_target', processedRows: sourceRecords.length, targetRows: count });
  });

  const sourceMap = new Map();
  for (const rec of sourceRecords) {
    const fields = rec.fields || {};
    const pkVal = fields[pkCol];
    if (pkVal !== undefined && pkVal !== null && pkVal !== '') sourceMap.set(String(pkVal), { id: rec.id || rec.recordId, fields, record: rec });
  }
  const targetMap = new Map();
  for (const rec of targetRecords) {
    const fields = rec.fields || {};
    const pkVal = fields[pkFieldName];
    if (pkVal !== undefined && pkVal !== null && pkVal !== '') targetMap.set(String(pkVal), { id: rec.id || rec.recordId, fields, record: rec });
  }

  const keys = new Set([...sourceMap.keys(), ...targetMap.keys()]);
  const targetInserts = [];
  const targetUpdates = [];
  const sourceInserts = [];
  const sourceUpdates = [];
  let skipCount = 0;
  let conflictCount = 0;

  for (const key of keys) {
    checkCancelled();
    const source = sourceMap.get(key);
    const target = targetMap.get(key);
    if (source && !target) {
      const fields = createRecordFields(source.fields, mapping, srcTypeMap, tgtTypeMap, log);
      targetInserts.push({ fields });
      continue;
    }
    if (!source && target) {
      const fields = createRecordFields(target.fields, reverseMapping, tgtTypeMap, srcTypeMap, log);
      sourceInserts.push({ fields });
      continue;
    }
    if (!source || !target) continue;

    const targetCandidate = createRecordFields(source.fields, mapping, srcTypeMap, tgtTypeMap, log);
    const sourceCandidate = createRecordFields(target.fields, reverseMapping, tgtTypeMap, srcTypeMap, log);
    const targetDiffers = fieldsDiffer(targetCandidate, target.fields);
    const sourceDiffers = fieldsDiffer(sourceCandidate, source.fields);
    if (!targetDiffers && !sourceDiffers) {
      skipCount++;
      continue;
    }

    conflictCount++;
    let winner = strategy;
    if (strategy === 'latest_wins') {
      const sourceTs = getTeableModifiedTime(source.record);
      const targetTs = getTeableModifiedTime(target.record);
      if (sourceTs === null || targetTs === null || sourceTs === targetTs) winner = 'skip_conflict';
      else winner = sourceTs > targetTs ? 'source_wins' : 'target_wins';
    }

    if (winner === 'source_wins') {
      if (targetDiffers) targetUpdates.push({ id: target.id, fields: targetCandidate });
      else skipCount++;
    } else if (winner === 'target_wins') {
      if (sourceDiffers) sourceUpdates.push({ id: source.id, fields: sourceCandidate });
      else skipCount++;
    } else {
      skipCount++;
    }
  }

  report({ phase: 'syncing_source', processedRows: sourceRecords.length, targetRows: targetRecords.length, skipped: skipCount });
  const targetResult = await flushBidirectionalWrites({
    task,
    conn: tgtConn,
    tableId: task.targetTableId,
    inserts: targetInserts,
    updates: targetUpdates,
    batchSize,
    retryCount,
    log,
    pkFieldName,
    operationLabel: '写入目标 Teable ',
  });
  const sourceResult = await flushBidirectionalWrites({
    task,
    conn: srcConn,
    tableId: task.sourceTable,
    inserts: sourceInserts,
    updates: sourceUpdates,
    batchSize,
    retryCount,
    log,
    pkFieldName: pkCol,
    operationLabel: '写回源 Teable ',
  });

  const insertCount = targetResult.inserted + sourceResult.inserted;
  const updateCount = targetResult.updated + sourceResult.updated;
  const errorCount = targetResult.failed + sourceResult.failed;
  if (errorCount > 0) throw new Error('双向同步存在 ' + errorCount + ' 条失败记录');

  saveSyncState(taskId, {
    ...getSyncState(taskId),
    lastRunAt: new Date().toISOString(),
    lastSyncAt: new Date().toISOString(),
    mode: 'bidirectional',
    conflictStrategy: strategy,
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log('info', '双向同步完成: 源 ' + sourceRecords.length + ', 目标 ' + targetRecords.length + ', 新增 ' + insertCount + ', 更新 ' + updateCount + ', 冲突 ' + conflictCount + ', 跳过 ' + skipCount + ', 失败 ' + errorCount + ' | 耗时 ' + elapsed + 's');
  report({
    status: 'success',
    phase: 'completed',
    mode: 'bidirectional',
    processedRows: sourceRecords.length,
    targetRows: targetRecords.length,
    inserted: insertCount,
    updated: updateCount,
    skipped: skipCount,
    failed: errorCount,
    conflicts: conflictCount,
  });
  updateSyncHistory(historyRec.id, {
    status: 'success',
    mode: 'bidirectional',
    sourceRows: sourceRecords.length,
    inserted: insertCount,
    updated: updateCount,
    skipped: skipCount,
    failed: errorCount,
    durationMs: Date.now() - startTime,
  });
  clearSyncFailures(taskId);
  return {
    status: 'success',
    mode: 'bidirectional',
    sourceRows: sourceRecords.length,
    targetRows: targetRecords.length,
    inserted: insertCount,
    updated: updateCount,
    skipped: skipCount,
    failed: errorCount,
    conflicts: conflictCount,
    durationMs: Date.now() - startTime,
  };
}

function validateTaskConfig(task, pkCol, watermark) {
  if (!task?.id) throw new Error('任务缺少 id');
  if (!task.sourceTable) throw new Error('任务缺少源表 sourceTable');
  if (!task.targetTableId) throw new Error('任务缺少目标表 targetTableId');
  if (!pkCol) throw new Error('无法检测到主键列,请手动配置 sourcePrimaryKey');
  if (!isSafeIdentifier(pkCol)) throw new Error('非法列名: pkCol=' + pkCol);
  if (watermark.col && !isSafeIdentifier(watermark.col)) throw new Error('非法列名: watermark=' + watermark.col);
  if (task.deletionMode && task.deletionMode !== 'ignore' && watermark.type !== 'full_scan') {
    return { deletionSkipped: true };
  }
  return { deletionSkipped: false };
}

function getSyncState(taskId) {
  const file = join(STATE_DIR, `${taskId}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
  return { lastSyncAt: null, watermark: null, syncedIds: [] };
}

function saveSyncState(taskId, state) {
  const file = join(STATE_DIR, `${taskId}.json`);
  const tmpFile = `${file}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(state), 'utf-8');
  renameSync(tmpFile, file);
}

/**
 * Detect watermark candidates from source table schema.
 * Returns { pkCol, candidates: { timestamp: [], rowversion: [], auto_pk: [] } }
 */
export async function detectWatermarkCandidates(srcConn, tableName, database = null) {
  if (isTeableSource(srcConn)) {
    const fields = await getTeableFields(srcConn, tableName);
    const names = fields.map((field) => field.name).filter(Boolean);
    const dateFields = fields.filter((field) => ['date', 'createdTime', 'lastModifiedTime'].includes(field.type)).map((field) => field.name);
    const preferredPk = names.find((name) => /^(id|ID|编号|编码|code|key|name|名称)$/i.test(name)) || names[0] || null;
    return {
      pkCol: preferredPk,
      candidates: {
        timestamp: dateFields,
        rowversion: [],
        auto_pk: names,
      },
    };
  }

  const db = database;
  let pkCol = null;
  const candidates = { timestamp: [], rowversion: [], auto_pk: [] };

  if (srcConn.type === 'mssql') {
    // PK
    const pkRows = await query(srcConn,
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_NAME = ? AND CONSTRAINT_NAME LIKE 'PK%'`,
      [tableName], db);
    if (pkRows.length > 0) pkCol = pkRows[0].COLUMN_NAME;

    // Timestamp (datetime) columns — explicitly EXCLUDE rowversion (DATA_TYPE='timestamp' in MSSQL)
    const tsRows = await query(srcConn,
      `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND (DATA_TYPE LIKE '%datetime%' OR DATA_TYPE LIKE '%date%' OR COLUMN_NAME IN ('updated_at', 'created_at', 'update_time', 'modify_time', 'modified_at', 'create_time')) AND DATA_TYPE <> 'timestamp' ORDER BY ORDINAL_POSITION`,
      [tableName], db);
    candidates.timestamp = tsRows.map(r => r.COLUMN_NAME);

    // Rowversion columns (MSSQL DATA_TYPE = 'timestamp' is actually rowversion)
    const rvRows = await query(srcConn,
      `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND DATA_TYPE = 'timestamp' ORDER BY ORDINAL_POSITION`,
      [tableName], db);
    candidates.rowversion = rvRows.map(r => r.COLUMN_NAME);

    // Auto-increment (IDENTITY) columns
    const aiRows = await query(srcConn,
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_NAME = ?
         AND COLUMNPROPERTY(OBJECT_ID(TABLE_SCHEMA + '.' + TABLE_NAME), COLUMN_NAME, 'IsIdentity') = 1
       ORDER BY ORDINAL_POSITION`,
      [tableName], db);
    candidates.auto_pk = aiRows.map(r => r.COLUMN_NAME);

  } else if (srcConn.type === 'mysql') {
    // PK
    const pkRows = await query(srcConn,
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'`,
      [tableName], db);
    if (pkRows.length > 0) pkCol = pkRows[0].COLUMN_NAME;

    // Timestamp / datetime columns
    const tsRows = await query(srcConn,
      `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND DATA_TYPE IN ('datetime', 'timestamp', 'date') ORDER BY ORDINAL_POSITION`,
      [tableName], db);
    candidates.timestamp = tsRows.map(r => r.COLUMN_NAME);

    // Auto-increment columns
    const aiRows = await query(srcConn,
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND EXTRA LIKE '%auto_increment%' ORDER BY ORDINAL_POSITION`,
      [tableName], db);
    candidates.auto_pk = aiRows.map(r => r.COLUMN_NAME);

  } else if (srcConn.type === 'pg') {
    // PK
    const pkRows = await query(srcConn,
      `SELECT a.attname as column_name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [tableName], db);
    if (pkRows.length > 0) pkCol = pkRows[0].column_name;

    // Timestamp / datetime columns
    const tsRows = await query(srcConn,
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND data_type IN ('timestamp without time zone', 'timestamp with time zone', 'date') ORDER BY ordinal_position`,
      [tableName], db);
    candidates.timestamp = tsRows.map(r => r.column_name);

    // Auto-increment (serial / identity) columns
    const aiRows = await query(srcConn,
      `SELECT column_name, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND (column_default LIKE 'nextval%' OR is_identity = 'YES') ORDER BY ordinal_position`,
      [tableName], db);
    candidates.auto_pk = aiRows.map(r => r.column_name);
  }

  return { pkCol, candidates };
}

/**
 * Resolve effective watermark strategy + column for a task.
 * Priority: explicit task config → auto-detect
 */
export function resolveWatermark(task, pkCol, candidates) {
  const explicit = task.watermarkType; // 'timestamp' | 'rowversion' | 'auto_pk' | 'full_scan'
  const explicitCol = task.watermarkColumn || task.sourceTimestampColumn; // override the auto-selected column

  // Legacy compat: if sourceTimestampColumn is set but watermarkType isn't, use timestamp
  if (!explicit && explicitCol) {
    return { type: 'timestamp', col: explicitCol, description: `时间戳增量 (${explicitCol})` };
  }

  // Auto-detect order: rowversion → timestamp → auto_pk → full_scan
  let type = 'full_scan';
  let col = null;

  if (candidates.rowversion.length > 0) {
    type = 'rowversion';
    col = candidates.rowversion[0];
  } else if (candidates.timestamp.length > 0) {
    type = 'timestamp';
    // Prefer update/modify named columns
    const updateCol = candidates.timestamp.find(c => /update|modify|modified/i.test(c));
    col = updateCol || candidates.timestamp[0];
  } else if (candidates.auto_pk.length > 0) {
    type = 'auto_pk';
    col = candidates.auto_pk[0];
  }

  // Override with explicit task config
  if (explicit === 'full_scan') {
    return { type: 'full_scan', col: null, description: '全量扫描（每次拉取所有记录）' };
  }
  if (explicit === 'timestamp') {
    col = explicitCol || candidates.timestamp[0] || null;
    if (!col) return { type: 'full_scan', col: null, description: '无可用的 timestamp 列，降级为全量扫描' };
    return { type: 'timestamp', col, description: `时间戳增量 (${col})` };
  }
  if (explicit === 'rowversion') {
    col = explicitCol || candidates.rowversion[0] || null;
    if (!col) return { type: 'full_scan', col: null, description: '无可用的 rowversion 列，降级为全量扫描' };
    return { type: 'rowversion', col, description: `Rowversion 增量 (${col})` };
  }
  if (explicit === 'auto_pk') {
    col = explicitCol || candidates.auto_pk[0] || pkCol || null;
    if (!col) return { type: 'full_scan', col: null, description: '无可用的自增主键，降级为全量扫描' };
    return { type: 'auto_pk', col, description: `自增主键增量 (${col})` };
  }

  // Auto-detected
  const descriptions = {
    timestamp: `时间戳增量 (${col})`,
    rowversion: `Rowversion 增量 (${col})`,
    auto_pk: `自增主键增量 (${col})`,
    full_scan: '全量扫描（无增量列可用）',
  };
  return { type, col, description: descriptions[type] };
}


export async function runSync(task, srcConn, tgtConn, broadcastLog) {
  return runSyncWithControl(task, srcConn, tgtConn, broadcastLog);
}

export async function runSyncWithControl(task, srcConn, tgtConn, broadcastLog, control = {}) {
  const taskId = task.id;
  const startTime = Date.now();
  const db = task.sourceDatabase || null;
  const pageSize = toPositiveInt(task.pageSize, 1000, 5000);
  const batchSize = toPositiveInt(task.batchSize, 500, 1000);
  const retryCount = toPositiveInt(task.retryCount, 3, 8);
  const deletionMode = task.deletionMode || 'ignore';
  const softDeleteField = task.softDeleteField || 'deleted';

  const log = (level, msg) => {
    const entry = { taskId, level, message: msg, ts: new Date().toISOString() };
    broadcastLog(entry);
  };
  const report = (patch) => {
    if (typeof control.onProgress === 'function') {
      control.onProgress({
        taskId,
        taskName: task.name,
        startedAt: new Date(startTime).toISOString(),
        updatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startTime,
        ...patch,
      });
    }
  };
  const checkCancelled = () => {
    if (control.signal?.aborted || control.isCancelled?.()) {
      const err = new Error('同步已取消');
      err.code = 'SYNC_CANCELLED';
      throw err;
    }
  };

  if (syncLocks.has(taskId)) {
    log('warn', '任务正在执行中，忽略本次请求');
    return { status: 'skipped', reason: 'already_running' };
  }
  syncLocks.add(taskId);
  log('info', '开始同步任务: ' + task.name);
  report({ status: 'running', phase: 'starting', processedRows: 0, inserted: 0, updated: 0, skipped: 0, deleted: 0, softDeleted: 0, failed: 0 });

  let historyRec = null;
  try {
    checkCancelled();
    if (isBidirectionalTask(task)) {
      return await runBidirectionalTeableSync(task, srcConn, tgtConn, {
        taskId,
        startTime,
        pageSize,
        batchSize,
        retryCount,
        log,
        report,
        checkCancelled,
      });
    }

    const { pkCol: autoPkCol, candidates } = await detectWatermarkCandidates(srcConn, task.sourceTable, db);
    const pkCol = task.sourcePrimaryKey || autoPkCol;
    const watermark = resolveWatermark(task, pkCol, candidates);
    validateTaskConfig(task, pkCol, watermark);
    const state = getSyncState(taskId);
    const sourceKind = isTeableSource(srcConn) ? 'teable' : 'sql';
    const table = sourceKind === 'sql' ? quoteIdentifier(srcConn.type, task.sourceTable) : null;
    const pkIdentifier = sourceKind === 'sql' ? quoteIdentifier(srcConn.type, pkCol) : null;
    const orderIdentifier = sourceKind === 'sql'
      ? (watermark.type === 'rowversion' && watermark.col ? quoteIdentifier(srcConn.type, watermark.col) : pkIdentifier)
      : null;

    let baseSql = table ? 'SELECT * FROM ' + table : '';
    const baseParams = [];
    let isIncremental = false;

    if (sourceKind === 'teable' && watermark.type !== 'full_scan') {
      log('warn', 'Teable 源端 MVP 暂仅支持全量扫描，已自动降级为全量扫描');
      watermark.type = 'full_scan';
      watermark.col = null;
      watermark.description = 'Teable 全量扫描';
    }

    if (sourceKind === 'sql' && watermark.type === 'timestamp') {
      const tsCol = watermark.col;
      if (state.lastSyncAt) {
        baseSql += ' WHERE ' + quoteIdentifier(srcConn.type, tsCol) + ' > ' + placeholder(srcConn.type, baseParams.length);
        baseParams.push(state.lastSyncAt);
        isIncremental = true;
      }
    } else if (sourceKind === 'sql' && watermark.type === 'rowversion') {
      const rvCol = watermark.col;
      if (srcConn.type !== 'mssql') throw new Error('rowversion 策略仅支持 MSSQL');
      if (state.watermarkValue) {
        baseSql += ' WHERE ' + quoteIdentifier(srcConn.type, rvCol) + ' > CONVERT(varbinary(8), ' + placeholder(srcConn.type, baseParams.length) + ', 1)';
        baseParams.push(state.watermarkValue);
        isIncremental = true;
      }
    } else if (sourceKind === 'sql' && watermark.type === 'auto_pk') {
      if (state.watermarkPkValue !== undefined && state.watermarkPkValue !== null) {
        baseSql += ' WHERE ' + pkIdentifier + ' > ' + placeholder(srcConn.type, baseParams.length);
        baseParams.push(state.watermarkPkValue);
        isIncremental = true;
      }
    }

    const mode = isIncremental ? 'incremental' : 'full';
    historyRec = createSyncHistory(taskId, task.name, task.sourceTable, task.targetTableId);
    historyRec.mode = mode;
    log('info', '主键列: ' + pkCol + ' | 增量策略: ' + watermark.description + ' | 分页: ' + pageSize + '/页 | 写入批量: ' + batchSize);
    report({ phase: 'preparing', mode, pageSize, batchSize, watermark: watermark.type, processedRows: 0 });

    checkCancelled();
    const fields = await getTeableFields(tgtConn, task.targetTableId);
    const columnMapping = task.columnMapping || {};
    const sourceSchema = sourceKind === 'teable'
      ? (await getTeableFields(srcConn, task.sourceTable)).map(teableFieldToSourceColumn)
      : await getTableSchema(srcConn, task.sourceTable, db);
    const { mapping: autoMapping, createdFields } = await ensureTeableFields(tgtConn, task.targetTableId, sourceSchema, columnMapping, fields, log);
    const mapping = { ...autoMapping, ...columnMapping };

    const srcTypeMap = {};
    for (const col of sourceSchema) srcTypeMap[col.name] = normalizeSourceType(col.type, sourceKind);
    const tgtTypeMap = {};
    for (const f of fields) tgtTypeMap[f.name] = f.type;
    for (const cf of createdFields) tgtTypeMap[cf.fieldName] = cf.type;

    for (const [srcCol, tgtField] of Object.entries(columnMapping)) {
      const created = createdFields.find(f => f.col === srcCol);
      if (created) {
        mapping[srcCol] = created.fieldName;
      } else if (!fields.find(f => f.name === tgtField)) {
        log('warn', '用户映射 ' + srcCol + '->' + tgtField + '，但目标字段不存在，已忽略此映射');
        delete mapping[srcCol];
      }
    }
    if (deletionMode === 'soft_delete' && !fields.find(f => f.name === softDeleteField) && !createdFields.find(f => f.fieldName === softDeleteField)) {
      try {
        const created = await createTeableField(tgtConn, task.targetTableId, softDeleteField, 'boolean');
        tgtTypeMap[created.name] = created.type || 'checkbox';
        log('info', '  自动创建软删除字段: ' + created.name);
      } catch (err) {
        throw new Error('软删除字段不存在且自动创建失败: ' + err.message);
      }
    }
    const pkFieldName = mapping[pkCol] || pkCol;
    log('info', '字段映射: ' + Object.entries(mapping).map(([k, v]) => k + '->' + v).join(', '));

    let sourceRowsCount = 0, insertCount = 0, updateCount = 0, skipCount = 0, deleteCount = 0, softDeleteCount = 0, errorCount = 0;
    const existingRecords = [];
    let targetOffset = 0;
    const targetPageSize = 1000;
    while (true) {
      checkCancelled();
      report({ phase: 'loading_target', targetRows: existingRecords.length, processedRows: sourceRowsCount || 0 });
      const result = await withRetry(() => getTeableRecords(tgtConn, task.targetTableId, { skip: targetOffset, take: targetPageSize }), retryCount, log, '读取 Teable 记录');
      let page;
      if (Array.isArray(result)) page = result;
      else if (result?.records) page = result.records;
      else if (result?.data) page = result.data.records || result.data;
      else page = [];
      existingRecords.push(...page);
      if (page.length < targetPageSize) break;
      targetOffset += targetPageSize;
    }
    log('info', '目标表已有 ' + existingRecords.length + ' 条记录');
    report({ phase: 'syncing_source', targetRows: existingRecords.length, processedRows: 0 });

    const existingMap = new Map();
    for (const rec of existingRecords) {
      const recFields = rec.fields || rec;
      const pkVal = recFields[pkFieldName];
      if (pkVal !== undefined && pkVal !== null) existingMap.set(String(pkVal), { id: rec.id || rec.recordId, fields: recFields });
    }

    const seenSourcePks = new Set();
    const rowversionValues = [];
    const pkValues = [];
    const timestampValues = [];

    async function flushWrites(toInsert, toUpdate) {
      for (let i = 0; i < toInsert.length; i += batchSize) {
        const batch = toInsert.slice(i, i + batchSize);
        try {
          await withRetry(() => createTeableRecords(tgtConn, task.targetTableId, batch), retryCount, log, '批量插入');
          insertCount += batch.length;
        } catch (err) {
          errorCount += batch.length;
          addSyncFailure({
            task,
            operation: 'insert',
            tableId: task.targetTableId,
            records: batch,
            primaryKeys: extractBatchPrimaryKeys(batch, pkFieldName),
            error: err,
          });
          log('warn', '批量插入失败: ' + err.message);
        }
      }
      for (let i = 0; i < toUpdate.length; i += batchSize) {
        const batch = toUpdate.slice(i, i + batchSize);
        try {
          await withRetry(() => updateTeableRecords(tgtConn, task.targetTableId, batch), retryCount, log, '批量更新');
          updateCount += batch.length;
        } catch (err) {
          errorCount += batch.length;
          addSyncFailure({
            task,
            operation: 'update',
            tableId: task.targetTableId,
            records: batch,
            primaryKeys: extractBatchPrimaryKeys(batch, pkFieldName),
            error: err,
          });
          log('warn', '批量更新失败: ' + err.message);
        }
      }
    }

    let sourceOffset = 0;
    let sourceCursor = null;
    const useKeysetPaging = sourceKind === 'sql' && watermark.type !== 'rowversion';
    while (true) {
      checkCancelled();
      let sourceRows;
      if (sourceKind === 'teable') {
        const result = await withRetry(() => getTeableRecords(srcConn, task.sourceTable, { skip: sourceOffset, take: pageSize }), retryCount, log, '读取 Teable 源记录');
        sourceRows = normalizeTeableRecordsResponse(result).map(unwrapTeableRecord);
      } else {
        const { sql: pageSql, params: pageParams } = useKeysetPaging
          ? buildKeysetSql(srcConn.type, baseSql, orderIdentifier, sourceCursor, pageSize, baseParams.length)
          : buildPagedSql(srcConn.type, baseSql, orderIdentifier + ' ASC', pageSize, sourceOffset, baseParams.length);
        sourceRows = await query(srcConn, pageSql, [...baseParams, ...pageParams], db);
      }
      if (sourceRows.length === 0) break;

      sourceRowsCount += sourceRows.length;
      const toInsert = [];
      const toUpdate = [];
      for (const row of sourceRows) {
        checkCancelled();
        try {
          const pkValRaw = row[pkCol];
          if (pkValRaw === undefined || pkValRaw === null || pkValRaw === '') {
            skipCount++;
            log('warn', '跳过主键为空的源记录');
            continue;
          }
          const pkVal = String(pkValRaw);
          seenSourcePks.add(pkVal);
          pkValues.push(pkValRaw);
          if (watermark.type === 'timestamp' && watermark.col && row[watermark.col] !== undefined && row[watermark.col] !== null) {
            timestampValues.push(row[watermark.col]);
          }
          if (watermark.type === 'rowversion' && watermark.col && row[watermark.col]) rowversionValues.push(row[watermark.col]);
          const existing = existingMap.get(pkVal);
          const recordFields = createRecordFields(row, mapping, srcTypeMap, tgtTypeMap, log);
          if (deletionMode === 'soft_delete' && softDeleteField) recordFields[softDeleteField] = false;
          if (existing?.id) {
            if (task.conflictStrategy === 'skip' || task.conflictStrategy === 'insert_only') {
              skipCount++;
              continue;
            }
            toUpdate.push({ id: existing.id, fields: recordFields });
          } else {
            toInsert.push({ fields: recordFields });
          }
        } catch (err) {
          errorCount++;
          log('warn', '行处理失败 (PK=' + row[pkCol] + '): ' + err.message);
        }
      }
      await flushWrites(toInsert, toUpdate);
      log('info', '已处理源数据 ' + sourceRowsCount + ' 行');
      report({
        phase: 'syncing_source',
        processedRows: sourceRowsCount,
        inserted: insertCount,
        updated: updateCount,
        skipped: skipCount,
        deleted: deleteCount,
        softDeleted: softDeleteCount,
        failed: errorCount,
        targetRows: existingRecords.length,
      });
      if (sourceRows.length < pageSize) break;
      if (sourceKind === 'teable') sourceOffset += pageSize;
      else if (useKeysetPaging) sourceCursor = sourceRows[sourceRows.length - 1][pkCol];
      else sourceOffset += pageSize;
    }

    if (sourceRowsCount === 0) log('info', '没有需要同步的记录');

    if (deletionMode !== 'ignore' && watermark.type === 'full_scan' && errorCount === 0) {
      report({ phase: 'detecting_deletes', processedRows: sourceRowsCount, targetRows: existingRecords.length });
      const missing = [];
      for (const [pkVal, existing] of existingMap.entries()) {
        if (!seenSourcePks.has(pkVal) && existing.id) missing.push(existing);
      }
      if (missing.length > 0) log('info', '检测到目标表 ' + missing.length + ' 条记录源端已不存在，删除策略: ' + deletionMode);
      if (deletionMode === 'soft_delete') {
        for (let i = 0; i < missing.length; i += batchSize) {
          checkCancelled();
          const batch = missing.slice(i, i + batchSize).map((rec) => ({ id: rec.id, fields: { [softDeleteField]: true } }));
          try {
            await withRetry(() => updateTeableRecords(tgtConn, task.targetTableId, batch), retryCount, log, '软删除标记');
            softDeleteCount += batch.length;
            report({ phase: 'applying_deletes', processedRows: sourceRowsCount, softDeleted: softDeleteCount, deleted: deleteCount, failed: errorCount });
          } catch (err) {
            errorCount += batch.length;
            addSyncFailure({
              task,
              operation: 'soft_delete',
              tableId: task.targetTableId,
              records: batch,
              error: err,
            });
            log('warn', '软删除标记失败: ' + err.message);
          }
        }
      } else if (deletionMode === 'hard_delete') {
        for (let i = 0; i < missing.length; i += batchSize) {
          checkCancelled();
          const ids = missing.slice(i, i + batchSize).map((rec) => rec.id);
          try {
            await withRetry(() => deleteTeableRecords(tgtConn, task.targetTableId, ids), retryCount, log, '物理删除');
            deleteCount += ids.length;
            report({ phase: 'applying_deletes', processedRows: sourceRowsCount, softDeleted: softDeleteCount, deleted: deleteCount, failed: errorCount });
          } catch (err) {
            errorCount += ids.length;
            addSyncFailure({
              task,
              operation: 'hard_delete',
              tableId: task.targetTableId,
              recordIds: ids,
              error: err,
            });
            log('warn', '物理删除失败: ' + err.message);
          }
        }
      }
    } else if (deletionMode !== 'ignore' && watermark.type !== 'full_scan') {
      log('warn', '删除同步仅在全量扫描策略下执行，当前增量策略已跳过删除检测');
    }

    if (errorCount > 0) throw new Error('同步存在 ' + errorCount + ' 条失败记录，未推进增量水位');

    const newState = { ...state, lastRunAt: new Date().toISOString(), watermarkType: watermark.type, watermarkColumn: watermark.col };
    if (watermark.type === 'timestamp' && timestampValues.length > 0) {
      const maxTs = timestampValues.reduce((max, value) => (compareWatermarkValues(value, max) > 0 ? value : max), timestampValues[0]);
      newState.lastSyncAt = normalizeTimestampWatermark(maxTs);
    } else if (watermark.type === 'rowversion' && rowversionValues.length > 0) {
      const maxRv = rowversionValues.reduce((max, rv) => {
        const rawHex = Buffer.isBuffer(rv) ? rv.toString('hex') : String(rv).replace(/^0x/i, '');
        const hex = '0x' + rawHex;
        return hex > max ? hex : max;
      }, state.watermarkValue || '0x0');
      newState.watermarkValue = maxRv;
    } else if (watermark.type === 'auto_pk' && pkValues.length > 0) {
      const maxPk = pkValues.reduce((a, b) => (a > b ? a : b));
      if (newState.watermarkPkValue === undefined || newState.watermarkPkValue === null || maxPk > newState.watermarkPkValue) newState.watermarkPkValue = maxPk;
    } else if (watermark.type === 'full_scan') {
      newState.lastSyncAt = newState.lastRunAt;
    }
    saveSyncState(taskId, newState);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('info', '同步完成: 源 ' + sourceRowsCount + ', 新增 ' + insertCount + ', 更新 ' + updateCount + ', 跳过 ' + skipCount + ', 软删 ' + softDeleteCount + ', 删除 ' + deleteCount + ', 失败 ' + errorCount + ' | 耗时 ' + elapsed + 's');
    report({
      status: 'success',
      phase: 'completed',
      processedRows: sourceRowsCount,
      inserted: insertCount,
      updated: updateCount,
      skipped: skipCount,
      deleted: deleteCount,
      softDeleted: softDeleteCount,
      failed: errorCount,
    });
    updateSyncHistory(historyRec.id, {
      status: 'success', mode, sourceRows: sourceRowsCount, inserted: insertCount, updated: updateCount,
      skipped: skipCount, deleted: deleteCount, softDeleted: softDeleteCount, failed: errorCount, durationMs: Date.now() - startTime,
    });
    clearSyncFailures(taskId);
    return {
      status: 'success',
      mode,
      sourceRows: sourceRowsCount,
      inserted: insertCount,
      updated: updateCount,
      skipped: skipCount,
      deleted: deleteCount,
      softDeleted: softDeleteCount,
      failed: errorCount,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const cancelled = err.code === 'SYNC_CANCELLED';
    log(cancelled ? 'warn' : 'error', cancelled ? '同步已取消' : '同步失败: ' + err.message);
    console.error(err);
    if (historyRec) updateSyncHistory(historyRec.id, { status: cancelled ? 'cancelled' : 'failed', errorMessage: err.message, durationMs: Date.now() - startTime });
    report({ status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? 'cancelled' : 'failed', errorMessage: err.message });
    throw err;
  } finally {
    syncLocks.delete(taskId);
  }
}

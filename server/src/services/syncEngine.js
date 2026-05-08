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
import { getTeableFields, getTeableRecords, createTeableRecords, updateTeableRecords, deleteTeableRecords, createTeableField, ensureTeableFields } from './teableService.js';
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
    const { pkCol: autoPkCol, candidates } = await detectWatermarkCandidates(srcConn, task.sourceTable, db);
    const pkCol = task.sourcePrimaryKey || autoPkCol;
    const watermark = resolveWatermark(task, pkCol, candidates);
    validateTaskConfig(task, pkCol, watermark);
    const state = getSyncState(taskId);
    const table = quoteIdentifier(srcConn.type, task.sourceTable);
    const pkIdentifier = quoteIdentifier(srcConn.type, pkCol);
    const orderIdentifier = watermark.type === 'rowversion' && watermark.col
      ? quoteIdentifier(srcConn.type, watermark.col)
      : pkIdentifier;

    let baseSql = 'SELECT * FROM ' + table;
    const baseParams = [];
    let isIncremental = false;

    if (watermark.type === 'timestamp') {
      const tsCol = watermark.col;
      if (state.lastSyncAt) {
        baseSql += ' WHERE ' + quoteIdentifier(srcConn.type, tsCol) + ' > ' + placeholder(srcConn.type, baseParams.length);
        baseParams.push(state.lastSyncAt);
        isIncremental = true;
      }
    } else if (watermark.type === 'rowversion') {
      const rvCol = watermark.col;
      if (srcConn.type !== 'mssql') throw new Error('rowversion 策略仅支持 MSSQL');
      if (state.watermarkValue) {
        baseSql += ' WHERE ' + quoteIdentifier(srcConn.type, rvCol) + ' > CONVERT(varbinary(8), ' + placeholder(srcConn.type, baseParams.length) + ', 1)';
        baseParams.push(state.watermarkValue);
        isIncremental = true;
      }
    } else if (watermark.type === 'auto_pk') {
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
    const sourceSchema = await getTableSchema(srcConn, task.sourceTable, db);
    const { mapping: autoMapping, createdFields } = await ensureTeableFields(tgtConn, task.targetTableId, sourceSchema, columnMapping, fields, log);
    const mapping = { ...autoMapping, ...columnMapping };

    const srcTypeMap = {};
    for (const col of sourceSchema) srcTypeMap[col.name] = col.type;
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
    const useKeysetPaging = watermark.type !== 'rowversion';
    while (true) {
      checkCancelled();
      const { sql: pageSql, params: pageParams } = useKeysetPaging
        ? buildKeysetSql(srcConn.type, baseSql, orderIdentifier, sourceCursor, pageSize, baseParams.length)
        : buildPagedSql(srcConn.type, baseSql, orderIdentifier + ' ASC', pageSize, sourceOffset, baseParams.length);
      const sourceRows = await query(srcConn, pageSql, [...baseParams, ...pageParams], db);
      if (sourceRows.length === 0) break;

      sourceRowsCount += sourceRows.length;
      const toInsert = [];
      const toUpdate = [];
      for (const row of sourceRows) {
        checkCancelled();
        try {
          const pkValRaw = row[pkCol];
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
      if (useKeysetPaging) sourceCursor = sourceRows[sourceRows.length - 1][pkCol];
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

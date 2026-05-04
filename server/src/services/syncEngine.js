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
import { getTeableFields, getTeableRecords, createTeableRecords, updateTeableRecords, ensureTeableFields } from './teableService.js';
import { createSyncHistory, updateSyncHistory } from './syncHistory.js';
import { convertValue, normalizeSqlType } from './typeConverter.js';
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
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND IS_IDENTITY = 'YES' ORDER BY ORDINAL_POSITION`,
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
function resolveWatermark(task, pkCol, candidates) {
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
  const taskId = task.id;
  const startTime = Date.now();
  const db = task.sourceDatabase || null; // database override

  const log = (level, msg) => {
    const entry = { taskId, level, message: msg, ts: new Date().toISOString() };
    broadcastLog(entry);
  };

  // P1-1: Prevent concurrent runs of the same task
  if (syncLocks.has(taskId)) {
    log('warn', '⏳ 任务正在执行中，忽略本次请求');
    return;
  }
  syncLocks.add(taskId);

  // Create history record
  log('info', `🔄 开始同步任务: ${task.name}`);

  try {
    let historyRec = null;

    // 1. Detect PK + watermark candidates
    const { pkCol: autoPkCol, candidates } = await detectWatermarkCandidates(srcConn, task.sourceTable, db);
    let pkCol = task.sourcePrimaryKey || autoPkCol;

    if (!pkCol) {
      log('error', '❌ 无法检测到主键列,请手动配置 sourcePrimaryKey');
      return;
    }

    // Resolve watermark strategy
    const watermark = resolveWatermark(task, pkCol, candidates);
    log('info', `📌 主键列: ${pkCol} | 增量策略: ${watermark.description}`);

    // 2. Load sync state for incremental
    const state = getSyncState(taskId);

    // 3. Fetch source data (strategy-aware)
    const table = quoteIdentifier(srcConn.type, task.sourceTable);
    let fetchSql = `SELECT * FROM ${table}`;
    let fetchParams = [];
    let isIncremental = false;

    // 列名安全校验
    const safeId = (name) => /^[a-zA-Z0-9_]+$/.test(name);
    if (pkCol && !safeId(pkCol)) {
      throw new Error(`非法列名: pkCol=${pkCol}`);
    }

    if (watermark.type === 'timestamp') {
      // --- timestamp strategy ---
      const tsCol = watermark.col;
      if (!safeId(tsCol)) throw new Error(`非法列名: tsCol=${tsCol}`);
      const tsIdentifier = quoteIdentifier(srcConn.type, tsCol);
      if (state.lastSyncAt) {
        fetchSql += ` WHERE ${tsIdentifier} > ${placeholder(srcConn.type, fetchParams.length)}`;
        fetchParams.push(state.lastSyncAt);
        isIncremental = true;
      }
    } else if (watermark.type === 'rowversion') {
      // --- rowversion strategy ---
      // MSSQL rowversion is a binary(8) that auto-increments on any UPDATE.
      // We store the max rowversion value as hex string in state.watermarkValue
      const rvCol = watermark.col;
      if (!safeId(rvCol)) throw new Error(`非法列名: rvCol=${rvCol}`);
      const rvIdentifier = quoteIdentifier(srcConn.type, rvCol);
      if (state.watermarkValue) {
        // Convert stored hex to varbinary for comparison
        fetchSql += ` WHERE ${rvIdentifier} > CONVERT(varbinary(8), ${placeholder(srcConn.type, fetchParams.length)}, 1)`;
        fetchParams.push(state.watermarkValue);
        isIncremental = true;
      }
    } else if (watermark.type === 'auto_pk') {
      // --- auto_pk strategy ---
      // Use MAX(pk) from Teable target as watermark → only catches new inserts
      const pkIdentifier = quoteIdentifier(srcConn.type, pkCol);
      if (state.watermarkPkValue !== undefined && state.watermarkPkValue !== null) {
        fetchSql += ` WHERE ${pkIdentifier} > ${placeholder(srcConn.type, fetchParams.length)}`;
        fetchParams.push(state.watermarkPkValue);
        isIncremental = true;
      }
    }
    // full_scan: no WHERE clause, always pull everything

    const sourceRows = await query(srcConn, fetchSql, fetchParams, db);
    const mode = isIncremental ? 'incremental' : 'full';
    historyRec = createSyncHistory(taskId, task.name, task.sourceTable, task.targetTableId);
    historyRec.mode = mode;

    log('info', `📥 ${mode === 'incremental' ? '增量' : '全量'}拉取 ${sourceRows.length} 条记录`);

    if (sourceRows.length === 0) {
      log('info', '✅ 没有需要同步的记录');
      return;
    }

    // 4. Auto-create missing target fields + build column mapping
    const fields = await getTeableFields(tgtConn, task.targetTableId);
    const columnMapping = task.columnMapping || {};
    const sourceSchema = await getTableSchema(srcConn, task.sourceTable, db);
    const { mapping: autoMapping, createdFields, skippedAttachmentCols } = await ensureTeableFields(
      tgtConn, task.targetTableId, sourceSchema, columnMapping, fields, log
    );
    // User mapping takes priority over auto-created mapping
    const mapping = { ...autoMapping, ...columnMapping };

    // Build type maps for value conversion
    // srcTypeMap: sourceColumnName → normalized SQL type
    // tgtTypeMap: targetFieldName → Teable field type
    const srcTypeMap = {};
    for (const col of sourceSchema) {
      srcTypeMap[col.name] = col.type;
    }
    const tgtTypeMap = {};
    for (const f of fields) {
      tgtTypeMap[f.name] = f.type;
    }
    // Also include auto-created fields
    for (const cf of createdFields) {
      tgtTypeMap[cf.fieldName] = cf.type;
    }

    // P1-2: Validate user-specified column mappings point to existing target fields
    for (const [srcCol, tgtField] of Object.entries(columnMapping)) {
      if (!fields.find(f => f.name === tgtField)) {
        log('warn', `⚠️ 用户映射 ${srcCol}→${tgtField}，但目标字段不存在，已忽略此映射`);
        delete mapping[srcCol];
      }
    }
    if (createdFields.length > 0) {
      log('info', `🔗 字段映射: ${Object.keys(mapping).map(k => `${k}→${mapping[k]}`).join(', ')}`);
    } else {
      log('info', `🔗 字段映射: ${Object.entries(mapping).map(([k,v]) => `${k}→${v}`).join(', ')}`);
    }

    // 5. Get existing records from Teable for conflict detection (分页获取)
    let existingRecords = [];
    try {
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const result = await getTeableRecords(tgtConn, task.targetTableId, { skip: offset, take: pageSize });
        let page;
        if (Array.isArray(result)) page = result;
        else if (result.records) page = result.records;
        else if (result.data) page = result.data.records || result.data;
        else page = [];
        existingRecords.push(...page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }
      if (existingRecords.length > 0) {
        log('info', `📊 目标表已有 ${existingRecords.length} 条记录(分页获取完成)`);
      }
    } catch (e) {
      log('error', `❌ 获取现有记录失败，同步终止: ${e.message}`);
      return;
    }

    // Build index by PK
    const pkFieldName = mapping[pkCol] || pkCol;
    const existingMap = new Map();
    for (const rec of existingRecords) {
      const recFields = rec.fields || rec;
      const pkVal = recFields[pkFieldName];
      if (pkVal !== undefined && pkVal !== null) {
        existingMap.set(String(pkVal), rec.id || rec.recordId);
      }
    }

    // 6. Process rows
    let insertCount = 0, updateCount = 0, skipCount = 0, errorCount = 0;
    const toInsert = [];
    const toUpdate = [];

    for (const row of sourceRows) {
      try {
        const pkVal = String(row[pkCol]);
        const existingId = existingMap.get(pkVal);
        const recordFields = {};

        for (const [srcCol, tgtField] of Object.entries(mapping)) {
          let val = row[srcCol];
          if (val === undefined || val === null) {
            recordFields[tgtField] = null;
            continue;
          }
          // Use type converter for safe SQL → Teable value transformation
          const sqlType = srcTypeMap[srcCol];
          const teableType = tgtTypeMap[tgtField];
          if (sqlType && teableType) {
            val = convertValue(val, sqlType, teableType);
          } else {
            // Fallback: basic type handling
            if (val instanceof Date) val = val.toISOString();
            if (Buffer.isBuffer(val)) {
              log('warn', `⚠️ 字段 ${srcCol} 含二进制数据,已跳过`);
              val = null;
            }
          }
          recordFields[tgtField] = val;
        }

        if (existingId) {
          if (task.conflictStrategy === 'skip') {
            skipCount++;
            continue;
          }
          toUpdate.push({ id: existingId, fields: recordFields });
        } else {
          toInsert.push({ fields: recordFields });
        }
      } catch (err) {
        errorCount++;
        log('warn', `⚠️ 行处理失败 (PK=${row[pkCol]}): ${err.message}`);
      }
    }

    // 7. Batch write to Teable
    // P2-2: Increase batch size — Teable supports up to 1000 records per request
    const BATCH_SIZE = 500;

    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      try {
        await createTeableRecords(tgtConn, task.targetTableId, batch);
        insertCount += batch.length;
      } catch (err) {
        errorCount += batch.length;
        log('warn', `⚠️ 批量插入失败: ${err.message}`);
      }
    }

    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
      const batch = toUpdate.slice(i, i + BATCH_SIZE);
      try {
        await updateTeableRecords(tgtConn, task.targetTableId, batch);
        updateCount += batch.length;
      } catch (err) {
        errorCount += batch.length;
        log('warn', `⚠️ 批量更新失败: ${err.message}`);
      }
    }

    // 8. Update sync state (strategy-aware)
    if (errorCount > 0) {
      throw new Error(`同步存在 ${errorCount} 条失败记录，未推进增量水位`);
    }
    const newState = { ...state, lastSyncAt: new Date().toISOString() };

    if (watermark.type === 'rowversion' && sourceRows.length > 0) {
      // Store max rowversion as hex string for next incremental
      const rvCol = watermark.col;
      const maxRv = sourceRows.reduce((max, row) => {
        const rv = row[rvCol];
        if (!rv) return max;
        // Buffer → hex string
        const rawHex = Buffer.isBuffer(rv) ? rv.toString('hex') : String(rv).replace(/^0x/i, '');
        const hex = `0x${rawHex}`;
        return hex > max ? hex : max;
      }, state.watermarkValue || '0x0');
      newState.watermarkValue = maxRv;
    } else if (watermark.type === 'auto_pk' && sourceRows.length > 0) {
      // Store max PK value for next incremental
      const pkVals = sourceRows.map(r => r[pkCol]).filter(v => v !== null && v !== undefined);
      if (pkVals.length > 0) {
        // Use the max value (works for both numeric and string PKs)
        const maxPk = pkVals.reduce((a, b) => (a > b ? a : b));
        // Only advance if we got a higher value
        if (newState.watermarkPkValue === undefined || newState.watermarkPkValue === null || maxPk > newState.watermarkPkValue) {
          newState.watermarkPkValue = maxPk;
        }
      }
    }

    saveSyncState(taskId, newState);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('info', `✅ 同步完成: 新增 ${insertCount}, 更新 ${updateCount}, 跳过 ${skipCount}, 失败 ${errorCount} | 耗时 ${elapsed}s`);

    // Update history record
    const durationMs = Date.now() - startTime;
    updateSyncHistory(historyRec.id, {
      status: 'success',
      mode,
      sourceRows: sourceRows.length,
      inserted: insertCount,
      updated: updateCount,
      skipped: skipCount,
      failed: errorCount,
      durationMs
    });

  } catch (err) {
    log('error', `❌ 同步失败: ${err.message}`);
    console.error(err);

    // Update history record with error
    if (historyRec) {
      updateSyncHistory(historyRec.id, {
        status: 'failed',
        errorMessage: err.message,
        durationMs: Date.now() - startTime
      });
    }

    throw err;
  } finally {
    // P1-1: Always release the lock
    syncLocks.delete(taskId);
  }
}

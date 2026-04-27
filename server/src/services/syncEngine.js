// Sync engine - incremental sync with conflict detection

import { query, getTableSchema } from './dbService.js';
import { getTeableFields, getTeableRecords, createTeableRecords, updateTeableRecords, ensureTeableFields } from './teableService.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(dirname(dirname(__dirname)), 'data', 'sync-state');
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

function getSyncState(taskId) {
  const file = join(STATE_DIR, `${taskId}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf-8'));
  return { lastSyncAt: null, watermark: null, syncedIds: [] };
}

function saveSyncState(taskId, state) {
  const file = join(STATE_DIR, `${taskId}.json`);
  writeFileSync(file, JSON.stringify(state), 'utf-8');
}

export async function runSync(task, srcConn, tgtConn, broadcastLog) {
  const taskId = task.id;
  const startTime = Date.now();
  const db = task.sourceDatabase || null; // database override

  const log = (level, msg) => {
    const entry = { taskId, level, message: msg, ts: new Date().toISOString() };
    broadcastLog(entry);
  };

  log('info', `🔄 开始同步任务: ${task.name}`);

  try {
    // 1. Detect PK and timestamp columns from source table schema
    let pkCol = null;
    let tsCol = null;

    // For mssql, detect PK
    if (srcConn.type === 'mssql') {
      const pkRows = await query(srcConn,
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_NAME = ? AND CONSTRAINT_NAME LIKE 'PK%'`,
        [task.sourceTable], db);
      if (pkRows.length > 0) pkCol = pkRows[0].COLUMN_NAME;

      const tsRows = await query(srcConn,
        `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = ? AND (DATA_TYPE LIKE '%timestamp%' OR DATA_TYPE LIKE '%datetime%' OR COLUMN_NAME IN ('updated_at', 'created_at', 'update_time', 'modify_time', 'modified_at')) ORDER BY ORDINAL_POSITION`,
        [task.sourceTable], db);
      const updateCol = tsRows.find(c => /update|modify|modified/i.test(c.COLUMN_NAME));
      tsCol = updateCol ? updateCol.COLUMN_NAME : (tsRows.length > 0 ? tsRows[0].COLUMN_NAME : null);
    } else if (srcConn.type === 'mysql') {
      const pkRows = await query(srcConn,
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'`,
        [task.sourceTable], db);
      if (pkRows.length > 0) pkCol = pkRows[0].COLUMN_NAME;
    } else if (srcConn.type === 'pg') {
      const pkRows = await query(srcConn,
        `SELECT a.attname as column_name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1::regclass AND i.indisprimary`,
        [task.sourceTable], db);
      if (pkRows.length > 0) pkCol = pkRows[0].column_name;
    }

    // Override with task config if specified
    pkCol = task.sourcePrimaryKey || pkCol;
    tsCol = task.sourceTimestampColumn || tsCol;

    if (!pkCol) {
      log('error', '❌ 无法检测到主键列,请手动配置 sourcePrimaryKey');
      return;
    }

    log('info', `📌 主键列: ${pkCol}, 时间戳列: ${tsCol || '无（首次同步所有数据）'}`);

    // 2. Load sync state for incremental
    const state = getSyncState(taskId);
    const prevSyncAt = state.lastSyncAt;

    // 3. Fetch source data
    const table = task.sourceTable.replace(/]/g, ']]');
    // SQL 注入防护：表名只允许安全字符
    if (!/^[a-zA-Z0-9_\[\].]+$/.test(task.sourceTable)) {
      throw new Error(`非法表名: ${task.sourceTable}`);
    }
    let fetchSql, fetchParams = [];

    if (srcConn.type === 'mssql') {
      fetchSql = `SELECT * FROM [${table}]`;
    } else {
      fetchSql = `SELECT * FROM "${task.sourceTable}"`;
    }

    // 列名安全校验
    const safeId = (name) => /^[a-zA-Z0-9_]+$/.test(name);
    if ((tsCol && !safeId(tsCol)) || (pkCol && !safeId(pkCol))) {
      throw new Error(`非法列名: tsCol=${tsCol}, pkCol=${pkCol}`);
    }

    if (tsCol && prevSyncAt) {
      fetchSql += srcConn.type === 'mssql'
        ? ` WHERE [${tsCol}] > ?`
        : ` WHERE "${tsCol}" > ?`;
      fetchParams.push(prevSyncAt);
    }

    const sourceRows = await query(srcConn, fetchSql, fetchParams, db);
    const mode = (tsCol && prevSyncAt) ? '增量' : '全量';
    log('info', `📥 ${mode}拉取 ${sourceRows.length} 条记录`);

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
      log('warn', `⚠️ 获取现有记录失败(将全部插入): ${e.message}`);
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
          // Convert Date objects to ISO strings for Teable
          if (val instanceof Date) {
            val = val.toISOString();
          }
          // Convert Buffer to null (binary/attachment data not supported)
          if (Buffer.isBuffer(val)) {
            log('warn', `⚠️ 字段 ${srcCol} 含二进制数据,已跳过(附件字段暂不支持同步)`);
            val = null;
          }
          // MSSQL bit → boolean
          if (srcConn.type === 'mssql' && val !== null && val !== undefined && (val === true || val === false)) {
            // already boolean, pass through
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
    const BATCH_SIZE = 100; // Teable API rate limit (max 1000 per request, use 100 for balance)

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

    // 8. Update sync state
    const newState = { ...state, lastSyncAt: new Date().toISOString() };
    saveSyncState(taskId, newState);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log('info', `✅ 同步完成: 新增 ${insertCount}, 更新 ${updateCount}, 跳过 ${skipCount}, 失败 ${errorCount} | 耗时 ${elapsed}s`);

  } catch (err) {
    log('error', `❌ 同步失败: ${err.message}`);
    console.error(err);
  }
}

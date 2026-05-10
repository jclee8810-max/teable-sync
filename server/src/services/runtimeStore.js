import { existsSync, mkdirSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || process.env.RUNTIME_STORE_DATA_DIR || join(__dirname, '..', '..', 'data');
const DB_FILE = process.env.RUNTIME_SQLITE_FILE || join(DATA_DIR, 'runtime.sqlite');
const STORE_MODE = String(process.env.TEABLE_SYNC_RUNTIME_STORE || process.env.RUNTIME_STORE || 'json').toLowerCase();
const SQLITE_ENABLED = STORE_MODE === 'sqlite';
const MAX_HISTORY_RECORDS = 2000;
const MAX_FAILURES = 2000;
const MAX_AUDIT_LOGS = 2000;

let sqliteBin = null;
let initialized = false;
let initFailed = false;

function findSqlite() {
  const candidates = [process.env.SQLITE_BIN, 'sqlite3', '/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3'].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (result.status === 0) return candidate;
  }
  return null;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function jsonString(value) {
  return sqlString(JSON.stringify(value ?? null));
}

function execSql(sql) {
  ensureRuntimeStore();
  if (!sqliteBin) throw new Error('SQLite runtime store is unavailable');
  const result = spawnSync(sqliteBin, [DB_FILE], { input: `${sql}\n`, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) {
    throw new Error(`${result.stderr || result.stdout || 'sqlite exec failed'}`.trim());
  }
  return result.stdout || '';
}

function querySql(sql) {
  ensureRuntimeStore();
  if (!sqliteBin) throw new Error('SQLite runtime store is unavailable');
  const result = spawnSync(sqliteBin, ['-json', DB_FILE, sql], { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) {
    throw new Error(`${result.stderr || result.stdout || 'sqlite query failed'}`.trim());
  }
  const raw = (result.stdout || '').trim();
  return raw ? JSON.parse(raw) : [];
}

export function isRuntimeSqliteEnabled() {
  if (!SQLITE_ENABLED || initFailed) return false;
  ensureRuntimeStore();
  return Boolean(sqliteBin) && !initFailed;
}

export function ensureRuntimeStore() {
  if (!SQLITE_ENABLED || initialized || initFailed) return;
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    sqliteBin = findSqlite();
    if (!sqliteBin) {
      initFailed = true;
      logger.warn('SQLite runtime store requested but sqlite3 CLI was not found; falling back to JSON runtime files');
      return;
    }
    const schema = [
      'PRAGMA journal_mode = WAL;',
      'PRAGMA synchronous = NORMAL;',
      'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS sync_history (id TEXT PRIMARY KEY, run_id TEXT, task_id TEXT, status TEXT, start_time TEXT, end_time TEXT, payload_json TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS sync_failures (id TEXT PRIMARY KEY, task_id TEXT, run_id TEXT, count INTEGER, retry_count INTEGER, created_at TEXT, payload_json TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT, resource_type TEXT, ts TEXT, payload_json TEXT NOT NULL);',
      'CREATE INDEX IF NOT EXISTS idx_runtime_history_task ON sync_history(task_id);',
      'CREATE INDEX IF NOT EXISTS idx_runtime_history_start ON sync_history(start_time);',
      'CREATE INDEX IF NOT EXISTS idx_runtime_failures_task ON sync_failures(task_id);',
      'CREATE INDEX IF NOT EXISTS idx_runtime_audit_user ON audit_logs(user_id);',
      'CREATE INDEX IF NOT EXISTS idx_runtime_audit_action ON audit_logs(action);',
      'CREATE INDEX IF NOT EXISTS idx_runtime_audit_resource ON audit_logs(resource_type);',
    ].join('\n');
    const result = spawnSync(sqliteBin, [DB_FILE], { input: `${schema}\n`, encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'sqlite init failed');
    initialized = true;
  } catch (err) {
    initFailed = true;
    logger.warn('SQLite runtime store initialization failed; falling back to JSON runtime files:', err.message);
  }
}

function metadataExists(key) {
  const rows = querySql(`SELECT value FROM metadata WHERE key = ${sqlString(key)} LIMIT 1;`);
  return rows.length > 0;
}

function setMetadata(key, value = 'true') {
  execSql(`INSERT INTO metadata (key, value) VALUES (${sqlString(key)}, ${sqlString(value)}) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`);
}

function readJsonArray(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function prune(table, orderColumn, maxRows) {
  execSql(`DELETE FROM ${table} WHERE rowid NOT IN (SELECT rowid FROM ${table} ORDER BY datetime(${orderColumn}) DESC, rowid DESC LIMIT ${maxRows});`);
}

export function migrateRuntimeJsonOnce({ historyFile, failuresFile, auditFile }) {
  if (!isRuntimeSqliteEnabled()) return false;
  if (!metadataExists('runtime_json_migrated_v1')) {
    const history = readJsonArray(historyFile);
    const failures = readJsonArray(failuresFile);
    const auditLogs = readJsonArray(auditFile);
    const statements = ['BEGIN;'];
    for (const record of history) statements.push(historyUpsertSql(record, false));
    for (const failure of failures) statements.push(failureUpsertSql(failure, false));
    for (const log of auditLogs) statements.push(auditInsertSql(log, false));
    statements.push(`INSERT INTO metadata (key, value) VALUES ('runtime_json_migrated_v1', ${sqlString(new Date().toISOString())}) ON CONFLICT(key) DO NOTHING;`);
    statements.push('COMMIT;');
    execSql(statements.join('\n'));
    prune('sync_history', 'start_time', MAX_HISTORY_RECORDS);
    prune('sync_failures', 'created_at', MAX_FAILURES);
    prune('audit_logs', 'ts', MAX_AUDIT_LOGS);
  }
  return true;
}

function historyUpsertSql(record, includePrune = true) {
  const sql = `INSERT INTO sync_history (id, run_id, task_id, status, start_time, end_time, payload_json)
VALUES (${sqlString(record.id)}, ${sqlString(record.runId)}, ${sqlString(record.taskId)}, ${sqlString(record.status)}, ${sqlString(record.startTime)}, ${sqlString(record.endTime)}, ${jsonString(record)})
ON CONFLICT(id) DO UPDATE SET
  run_id = excluded.run_id,
  task_id = excluded.task_id,
  status = excluded.status,
  start_time = excluded.start_time,
  end_time = excluded.end_time,
  payload_json = excluded.payload_json;`;
  return includePrune ? `${sql}\nDELETE FROM sync_history WHERE rowid NOT IN (SELECT rowid FROM sync_history ORDER BY datetime(start_time) DESC, rowid DESC LIMIT ${MAX_HISTORY_RECORDS});` : sql;
}

export function insertSyncHistoryRecord(record) {
  execSql(historyUpsertSql(record));
  return record;
}

export function updateSyncHistoryRecord(recordId, updater) {
  const current = getSyncHistoryRecordFromStore(recordId);
  if (!current) return null;
  const next = updater({ ...current });
  execSql(historyUpsertSql(next));
  return next;
}

export function getSyncHistoryFromStore(taskId = null, limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 2000);
  const where = taskId ? `WHERE task_id = ${sqlString(taskId)}` : '';
  return querySql(`SELECT payload_json FROM sync_history ${where} ORDER BY datetime(start_time) DESC, rowid DESC LIMIT ${safeLimit};`).map((row) => JSON.parse(row.payload_json));
}

export function getSyncHistoryRecordFromStore(recordId) {
  const rows = querySql(`SELECT payload_json FROM sync_history WHERE id = ${sqlString(recordId)} LIMIT 1;`);
  return rows[0]?.payload_json ? JSON.parse(rows[0].payload_json) : null;
}

function failureUpsertSql(failure, includePrune = true) {
  const sql = `INSERT INTO sync_failures (id, task_id, run_id, count, retry_count, created_at, payload_json)
VALUES (${sqlString(failure.id)}, ${sqlString(failure.taskId)}, ${sqlString(failure.runId)}, ${Number(failure.count || 0)}, ${Number(failure.retryCount || 0)}, ${sqlString(failure.createdAt)}, ${jsonString(failure)})
ON CONFLICT(id) DO UPDATE SET
  task_id = excluded.task_id,
  run_id = excluded.run_id,
  count = excluded.count,
  retry_count = excluded.retry_count,
  created_at = excluded.created_at,
  payload_json = excluded.payload_json;`;
  return includePrune ? `${sql}\nDELETE FROM sync_failures WHERE rowid NOT IN (SELECT rowid FROM sync_failures ORDER BY datetime(created_at) DESC, rowid DESC LIMIT ${MAX_FAILURES});` : sql;
}

export function insertSyncFailureRecord(failure) {
  execSql(failureUpsertSql(failure));
  return failure;
}

export function getSyncFailuresFromStore(taskId = null) {
  const where = taskId ? `WHERE task_id = ${sqlString(taskId)}` : '';
  return querySql(`SELECT payload_json FROM sync_failures ${where} ORDER BY datetime(created_at) ASC, rowid ASC;`).map((row) => JSON.parse(row.payload_json));
}

export function getSyncFailureFromStore(id) {
  const rows = querySql(`SELECT payload_json FROM sync_failures WHERE id = ${sqlString(id)} LIMIT 1;`);
  return rows[0]?.payload_json ? JSON.parse(rows[0].payload_json) : null;
}

export function clearSyncFailuresFromStore(taskId = null) {
  const before = querySql(`SELECT COUNT(*) AS count FROM sync_failures${taskId ? ` WHERE task_id = ${sqlString(taskId)}` : ''};`)[0]?.count || 0;
  execSql(taskId ? `DELETE FROM sync_failures WHERE task_id = ${sqlString(taskId)};` : 'DELETE FROM sync_failures;');
  return before;
}

export function removeSyncFailuresFromStore(ids) {
  const safeIds = (ids || []).filter(Boolean);
  if (!safeIds.length) return 0;
  const idList = safeIds.map(sqlString).join(', ');
  const before = querySql(`SELECT COUNT(*) AS count FROM sync_failures WHERE id IN (${idList});`)[0]?.count || 0;
  execSql(`DELETE FROM sync_failures WHERE id IN (${idList});`);
  return before;
}

export function updateSyncFailureRecord(id, updater) {
  const current = getSyncFailureFromStore(id);
  if (!current) return null;
  const next = updater({ ...current });
  execSql(failureUpsertSql(next));
  return next;
}

function auditInsertSql(entry, includePrune = true) {
  const sql = `INSERT INTO audit_logs (id, user_id, action, resource_type, ts, payload_json)
VALUES (${sqlString(entry.id)}, ${sqlString(entry.userId)}, ${sqlString(entry.action)}, ${sqlString(entry.resourceType)}, ${sqlString(entry.ts)}, ${jsonString(entry)})
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  action = excluded.action,
  resource_type = excluded.resource_type,
  ts = excluded.ts,
  payload_json = excluded.payload_json;`;
  return includePrune ? `${sql}\nDELETE FROM audit_logs WHERE rowid NOT IN (SELECT rowid FROM audit_logs ORDER BY datetime(ts) DESC, rowid DESC LIMIT ${MAX_AUDIT_LOGS});` : sql;
}

export function insertAuditLogRecord(entry) {
  execSql(auditInsertSql(entry));
  return entry;
}

export function getAuditLogsFromStore({ limit = 200, action, resourceType, userId } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const conditions = [];
  if (userId) conditions.push(`user_id = ${sqlString(userId)}`);
  if (action) conditions.push(`action = ${sqlString(action)}`);
  if (resourceType) conditions.push(`resource_type = ${sqlString(resourceType)}`);
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return querySql(`SELECT payload_json FROM audit_logs ${where} ORDER BY datetime(ts) DESC, rowid DESC LIMIT ${safeLimit};`).map((row) => JSON.parse(row.payload_json));
}

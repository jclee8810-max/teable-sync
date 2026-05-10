#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const startedAt = new Date();
const ROOT = process.cwd();
const DATA_DIR = process.env.SQLITE_SHADOW_DATA_DIR || join(ROOT, 'server', 'data');
const REPORT_DIR = join(DATA_DIR, 'reports');
const OUT_DIR = join(DATA_DIR, 'sqlite-shadow');
const DB_PATH = process.env.SQLITE_SHADOW_DB || join(OUT_DIR, 'teable-sync-shadow.sqlite');
const SQL_PATH = join(OUT_DIR, `sqlite-shadow_${startedAt.toISOString().replace(/[:.]/g, '-')}.sql`);

function readJsonFile(name, fallback) {
  const path = join(DATA_DIR, name);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function jsonString(value) {
  return sqlString(JSON.stringify(value ?? null));
}

function row(table, columns, values) {
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')});`;
}

function findSqlite() {
  const candidates = [process.env.SQLITE_BIN, 'sqlite3', '/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3'].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (result.status === 0) return candidate;
  }
  return null;
}

function countTable(sqlite, table) {
  const result = spawnSync(sqlite, [DB_PATH, `SELECT COUNT(*) FROM ${table};`], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `count ${table} failed`);
  return Number(result.stdout.trim() || 0);
}

mkdirSync(REPORT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const config = readJsonFile('config.json', {});
const users = readJsonFile('users.json', []);
const history = readJsonFile('sync-history.json', []);
const failures = readJsonFile('sync-failures.json', []);
const auditLogs = readJsonFile('audit-logs.json', []);
const connections = Array.isArray(config.connections) ? config.connections : [];
const tasks = Array.isArray(config.syncTasks) ? config.syncTasks : [];
const templates = Array.isArray(config.taskTemplates) ? config.taskTemplates : [];
const syncLogs = Array.isArray(config.syncLogs) ? config.syncLogs : [];

const sql = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA foreign_keys = ON;',
  'BEGIN;',
  'DROP TABLE IF EXISTS metadata;',
  'DROP TABLE IF EXISTS connections;',
  'DROP TABLE IF EXISTS sync_tasks;',
  'DROP TABLE IF EXISTS task_templates;',
  'DROP TABLE IF EXISTS sync_logs;',
  'DROP TABLE IF EXISTS users;',
  'DROP TABLE IF EXISTS sync_history;',
  'DROP TABLE IF EXISTS sync_failures;',
  'DROP TABLE IF EXISTS audit_logs;',
  'CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
  'CREATE TABLE connections (id TEXT PRIMARY KEY, name TEXT, type TEXT, owner_id TEXT, deleted_at TEXT, last_test_success INTEGER, payload_json TEXT NOT NULL);',
  'CREATE TABLE sync_tasks (id TEXT PRIMARY KEY, name TEXT, source_connection_id TEXT, target_connection_id TEXT, owner_id TEXT, enabled INTEGER, status TEXT, deleted_at TEXT, payload_json TEXT NOT NULL);',
  'CREATE TABLE task_templates (id TEXT PRIMARY KEY, name TEXT, owner_id TEXT, shared INTEGER, payload_json TEXT NOT NULL);',
  'CREATE TABLE sync_logs (id TEXT PRIMARY KEY, task_id TEXT, level TEXT, ts TEXT, payload_json TEXT NOT NULL);',
  'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, role TEXT, payload_json TEXT NOT NULL);',
  'CREATE TABLE sync_history (id TEXT PRIMARY KEY, run_id TEXT, task_id TEXT, status TEXT, start_time TEXT, end_time TEXT, payload_json TEXT NOT NULL);',
  'CREATE TABLE sync_failures (id TEXT PRIMARY KEY, task_id TEXT, run_id TEXT, count INTEGER, retry_count INTEGER, created_at TEXT, payload_json TEXT NOT NULL);',
  'CREATE TABLE audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT, ts TEXT, payload_json TEXT NOT NULL);',
  'CREATE INDEX idx_connections_owner ON connections(owner_id);',
  'CREATE INDEX idx_tasks_owner ON sync_tasks(owner_id);',
  'CREATE INDEX idx_history_task ON sync_history(task_id);',
  'CREATE INDEX idx_failures_task ON sync_failures(task_id);',
  row('metadata', ['key', 'value'], [sqlString('format'), sqlString('teable-sync.sqlite-shadow')]),
  row('metadata', ['key', 'value'], [sqlString('generated_at'), sqlString(startedAt.toISOString())]),
];

for (const conn of connections) {
  sql.push(row('connections', ['id', 'name', 'type', 'owner_id', 'deleted_at', 'last_test_success', 'payload_json'], [
    sqlString(conn.id),
    sqlString(conn.name),
    sqlString(conn.type),
    sqlString(conn.ownerId || conn.userId),
    sqlString(conn.deletedAt),
    conn.lastTest?.success === true ? '1' : conn.lastTest ? '0' : 'NULL',
    jsonString(conn),
  ]));
}

for (const task of tasks) {
  sql.push(row('sync_tasks', ['id', 'name', 'source_connection_id', 'target_connection_id', 'owner_id', 'enabled', 'status', 'deleted_at', 'payload_json'], [
    sqlString(task.id),
    sqlString(task.name),
    sqlString(task.sourceConnectionId || task.sourceId),
    sqlString(task.targetConnectionId || task.targetId),
    sqlString(task.userId || task.ownerId),
    task.enabled === true ? '1' : '0',
    sqlString(task.status),
    sqlString(task.deletedAt),
    jsonString(task),
  ]));
}

for (const template of templates) {
  sql.push(row('task_templates', ['id', 'name', 'owner_id', 'shared', 'payload_json'], [
    sqlString(template.id),
    sqlString(template.name),
    sqlString(template.userId || template.ownerId),
    template.shared === true ? '1' : '0',
    jsonString(template),
  ]));
}

for (const [index, log] of syncLogs.entries()) {
  sql.push(row('sync_logs', ['id', 'task_id', 'level', 'ts', 'payload_json'], [
    sqlString(log.id || `sync-log-${index}`),
    sqlString(log.taskId),
    sqlString(log.level),
    sqlString(log.ts || log.createdAt),
    jsonString(log),
  ]));
}

for (const user of users) {
  sql.push(row('users', ['id', 'email', 'role', 'payload_json'], [
    sqlString(user.id),
    sqlString(user.email),
    sqlString(user.role),
    jsonString(user),
  ]));
}

for (const item of history) {
  sql.push(row('sync_history', ['id', 'run_id', 'task_id', 'status', 'start_time', 'end_time', 'payload_json'], [
    sqlString(item.id),
    sqlString(item.runId),
    sqlString(item.taskId),
    sqlString(item.status),
    sqlString(item.startTime),
    sqlString(item.endTime),
    jsonString(item),
  ]));
}

for (const failure of failures) {
  sql.push(row('sync_failures', ['id', 'task_id', 'run_id', 'count', 'retry_count', 'created_at', 'payload_json'], [
    sqlString(failure.id),
    sqlString(failure.taskId),
    sqlString(failure.runId),
    String(Number(failure.count || 0)),
    String(Number(failure.retryCount || 0)),
    sqlString(failure.createdAt),
    jsonString(failure),
  ]));
}

for (const log of auditLogs) {
  sql.push(row('audit_logs', ['id', 'user_id', 'action', 'ts', 'payload_json'], [
    sqlString(log.id),
    sqlString(log.userId),
    sqlString(log.action),
    sqlString(log.ts),
    jsonString(log),
  ]));
}

sql.push('COMMIT;');
writeFileSync(SQL_PATH, `${sql.join('\n')}\n`, 'utf8');

const sqlite = findSqlite();
let dbCreated = false;
let sqliteError = '';
let counts = {};
if (sqlite) {
  rmSync(DB_PATH, { force: true });
  const result = spawnSync(sqlite, [DB_PATH], { input: `${sql.join('\n')}\n`, encoding: 'utf8' });
  dbCreated = result.status === 0;
  sqliteError = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (dbCreated) {
    counts = {
      connections: countTable(sqlite, 'connections'),
      syncTasks: countTable(sqlite, 'sync_tasks'),
      taskTemplates: countTable(sqlite, 'task_templates'),
      syncLogs: countTable(sqlite, 'sync_logs'),
      users: countTable(sqlite, 'users'),
      syncHistory: countTable(sqlite, 'sync_history'),
      syncFailures: countTable(sqlite, 'sync_failures'),
      auditLogs: countTable(sqlite, 'audit_logs'),
    };
  }
}

const expected = {
  connections: connections.length,
  syncTasks: tasks.length,
  taskTemplates: templates.length,
  syncLogs: syncLogs.length,
  users: users.length,
  syncHistory: history.length,
  syncFailures: failures.length,
  auditLogs: auditLogs.length,
};
const countsOk = Object.entries(expected).every(([key, value]) => !dbCreated || counts[key] === value);
const ok = Boolean(sqlite) && dbCreated && countsOk;
const report = [
  '# Teable Sync SQLite Shadow Migration',
  '',
  `- Started: ${startedAt.toISOString()}`,
  `- Finished: ${new Date().toISOString()}`,
  `- Status: ${ok ? 'PASS' : 'FAIL'}`,
  `- SQLite CLI: ${sqlite || 'not found'}`,
  `- SQL file: ${SQL_PATH}`,
  `- SQLite DB: ${DB_PATH}`,
  '',
  '## Counts',
  '',
  '| Dataset | JSON | SQLite | Status |',
  '| --- | ---: | ---: | --- |',
  ...Object.entries(expected).map(([key, value]) => `| ${key} | ${value} | ${dbCreated ? counts[key] : 'n/a'} | ${dbCreated && counts[key] === value ? 'PASS' : 'FAIL'} |`),
  '',
  '## Notes',
  '',
  '- This is a shadow migration: it creates a SQLite copy for validation and planning, but the running service continues to use JSON storage.',
  '- Secrets remain inside encrypted JSON payload columns when the source config stores encrypted secrets.',
  sqliteError ? `- SQLite output: ${sqliteError}` : '- SQLite output: none',
  '',
].join('\n');

const reportPath = join(REPORT_DIR, `sqlite-shadow-migration_${startedAt.toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(reportPath, report, 'utf8');
console.log(reportPath);
process.exit(ok ? 0 : 1);

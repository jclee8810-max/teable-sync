#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'server', 'data');
const TEST_DIR = join(DATA_DIR, 'runtime-store-self-test');
const DB_FILE = join(TEST_DIR, 'runtime.sqlite');

mkdirSync(TEST_DIR, { recursive: true });
rmSync(DB_FILE, { force: true });
writeFileSync(join(TEST_DIR, 'sync-history.json'), JSON.stringify([{
  id: 'legacy-history',
  runId: 'legacy-run',
  taskId: 'legacy-task',
  taskName: 'Legacy Task',
  sourceTable: 'Orders',
  targetTableId: 'tbl',
  trigger: 'legacy',
  startTime: new Date(Date.now() - 1000).toISOString(),
  endTime: null,
  status: 'running',
  mode: 'full',
  sourceRows: 0,
  inserted: 0,
  updated: 0,
  skipped: 0,
  deleted: 0,
  softDeleted: 0,
  failed: 0,
  errorMessage: null,
  durationMs: 0,
}], null, 2));
writeFileSync(join(TEST_DIR, 'sync-failures.json'), JSON.stringify([], null, 2));
writeFileSync(join(TEST_DIR, 'audit-logs.json'), JSON.stringify([], null, 2));

process.env.TEABLE_SYNC_RUNTIME_STORE = 'sqlite';
process.env.RUNTIME_STORE_DATA_DIR = TEST_DIR;
process.env.RUNTIME_SQLITE_FILE = DB_FILE;
process.env.SQLITE_BIN = process.env.SQLITE_BIN || 'sqlite3';

const { createSyncHistory, getSyncHistory, getSyncHistoryRecord, updateSyncHistory } = await import('../src/services/syncHistory.js');
const { addSyncFailure, clearSyncFailures, getSyncFailure, getSyncFailureCounts, getSyncFailures, markSyncFailureRetried, removeSyncFailures } = await import('../src/services/syncFailures.js');
const { appendAuditLog, getAuditLogs } = await import('../src/services/auditLog.js');

assert.ok(existsSync(DB_FILE), 'runtime sqlite database should be created');
assert.equal(getSyncHistoryRecord('legacy-history')?.taskId, 'legacy-task', 'legacy JSON history should be migrated once');

const history = createSyncHistory('task-1', 'Task 1', 'Orders', 'tbl-1', { runId: 'run-1', trigger: 'self-test' });
assert.equal(getSyncHistory('task-1', 5)[0].id, history.id);
updateSyncHistory(history.id, { status: 'success', runId: 'run-1', sourceRows: 10, inserted: 7, updated: 2, skipped: 1, durationMs: 123 });
assert.equal(getSyncHistoryRecord(history.id).inserted, 7);

const failure = addSyncFailure({
  task: { id: 'task-1', name: 'Task 1' },
  operation: 'insert',
  tableId: 'tbl-1',
  records: [{ fields: { id: 1 } }],
  error: new Error('self-test failure'),
  primaryKeys: [1],
  runId: 'run-1',
  batchNo: 1,
});
assert.equal(getSyncFailures('task-1').length, 1);
assert.equal(getSyncFailure(failure.id).count, 1);
assert.equal(getSyncFailureCounts()['task-1'], 1);
markSyncFailureRetried(failure.id, new Error('still failing'));
assert.equal(getSyncFailure(failure.id).retryCount, 1);
assert.equal(removeSyncFailures([failure.id]), 1);
assert.equal(clearSyncFailures('task-1'), 0);

const user = { id: 'user-1', email: 'user@example.com', role: 'user' };
const admin = { id: 'admin-1', email: 'admin@example.com', role: 'super_admin' };
appendAuditLog(user, 'runtime.self_test', { resourceType: 'task', resourceId: 'task-1', message: 'hello' });
appendAuditLog(admin, 'runtime.self_test', { resourceType: 'system', resourceId: 'sys', message: 'admin' });
assert.equal(getAuditLogs({ user, limit: 10 }).length, 1, 'regular user should only see own audit logs');
assert.equal(getAuditLogs({ user: admin, limit: 10 }).length >= 2, true, 'admin should see all audit logs');

console.log('Runtime store self-test PASS');

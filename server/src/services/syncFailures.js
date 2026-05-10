import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import {
  clearSyncFailuresFromStore,
  getSyncFailureFromStore,
  getSyncFailuresFromStore,
  insertSyncFailureRecord,
  isRuntimeSqliteEnabled,
  migrateRuntimeJsonOnce,
  removeSyncFailuresFromStore,
  updateSyncFailureRecord,
} from './runtimeStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.RUNTIME_STORE_DATA_DIR || join(dirname(dirname(__dirname)), 'data');
const FAILURES_FILE = join(DATA_DIR, 'sync-failures.json');
const HISTORY_FILE = join(DATA_DIR, 'sync-history.json');
const AUDIT_FILE = join(DATA_DIR, 'audit-logs.json');
const MAX_FAILURES = 2000;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
migrateRuntimeJsonOnce({ historyFile: HISTORY_FILE, failuresFile: FAILURES_FILE, auditFile: AUDIT_FILE });

function loadFailures() {
  if (!existsSync(FAILURES_FILE)) return [];
  try {
    return JSON.parse(readFileSync(FAILURES_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveFailures(failures) {
  const tmpFile = `${FAILURES_FILE}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(failures.slice(-MAX_FAILURES), null, 2), 'utf-8');
  renameSync(tmpFile, FAILURES_FILE);
}

export function addSyncFailure({
  task,
  operation,
  tableId,
  records,
  recordIds,
  error,
  primaryKeys = [],
  runId = null,
  batchNo = null,
  writeBatchNo = null,
  sourceRange = null,
  sourceOffset = null,
  sourceCursorBefore = null,
  sourceCursorAfter = null,
  pkFieldName = null,
}) {
  const failure = {
    id: crypto.randomUUID(),
    taskId: task.id,
    taskName: task.name,
    runId,
    batchNo,
    writeBatchNo,
    operation,
    tableId,
    records: records || null,
    recordIds: recordIds || null,
    primaryKeys,
    pkFieldName,
    sourceRange,
    sourceOffset,
    sourceCursorBefore,
    sourceCursorAfter,
    count: records?.length || recordIds?.length || 0,
    errorMessage: error?.message || String(error || ''),
    createdAt: new Date().toISOString(),
    retryCount: 0,
    lastRetryAt: null,
  };
  if (isRuntimeSqliteEnabled()) return insertSyncFailureRecord(failure);
  const failures = loadFailures();
  failures.push(failure);
  saveFailures(failures);
  return failure;
}

export function getSyncFailures(taskId = null) {
  if (isRuntimeSqliteEnabled()) return getSyncFailuresFromStore(taskId);
  const failures = loadFailures();
  return taskId ? failures.filter((f) => f.taskId === taskId) : failures;
}

export function getSyncFailure(id) {
  if (isRuntimeSqliteEnabled()) return getSyncFailureFromStore(id);
  return loadFailures().find((f) => f.id === id) || null;
}

export function getSyncFailureCounts() {
  if (isRuntimeSqliteEnabled()) {
    const counts = {};
    for (const failure of getSyncFailuresFromStore()) {
      counts[failure.taskId] = (counts[failure.taskId] || 0) + failure.count;
    }
    return counts;
  }
  const counts = {};
  for (const failure of loadFailures()) {
    counts[failure.taskId] = (counts[failure.taskId] || 0) + failure.count;
  }
  return counts;
}

export function clearSyncFailures(taskId = null) {
  if (isRuntimeSqliteEnabled()) return clearSyncFailuresFromStore(taskId);
  const failures = loadFailures();
  const remaining = taskId ? failures.filter((f) => f.taskId !== taskId) : [];
  const removed = failures.length - remaining.length;
  saveFailures(remaining);
  return removed;
}

export function removeSyncFailures(ids) {
  if (isRuntimeSqliteEnabled()) return removeSyncFailuresFromStore(ids);
  const idSet = new Set(ids);
  const failures = loadFailures();
  const remaining = failures.filter((f) => !idSet.has(f.id));
  saveFailures(remaining);
  return failures.length - remaining.length;
}

export function markSyncFailureRetried(id, error) {
  if (isRuntimeSqliteEnabled()) {
    return updateSyncFailureRecord(id, (failure) => {
      failure.retryCount = (failure.retryCount || 0) + 1;
      failure.lastRetryAt = new Date().toISOString();
      failure.errorMessage = error?.message || String(error || failure.errorMessage || '');
      return failure;
    });
  }
  const failures = loadFailures();
  const idx = failures.findIndex((f) => f.id === id);
  if (idx === -1) return null;
  failures[idx].retryCount = (failures[idx].retryCount || 0) + 1;
  failures[idx].lastRetryAt = new Date().toISOString();
  failures[idx].errorMessage = error?.message || String(error || failures[idx].errorMessage || '');
  saveFailures(failures);
  return failures[idx];
}

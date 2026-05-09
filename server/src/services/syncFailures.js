import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(dirname(dirname(__dirname)), 'data');
const FAILURES_FILE = join(DATA_DIR, 'sync-failures.json');
const MAX_FAILURES = 2000;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

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
  const failures = loadFailures();
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
  failures.push(failure);
  saveFailures(failures);
  return failure;
}

export function getSyncFailures(taskId = null) {
  const failures = loadFailures();
  return taskId ? failures.filter((f) => f.taskId === taskId) : failures;
}

export function getSyncFailure(id) {
  return loadFailures().find((f) => f.id === id) || null;
}

export function getSyncFailureCounts() {
  const counts = {};
  for (const failure of loadFailures()) {
    counts[failure.taskId] = (counts[failure.taskId] || 0) + failure.count;
  }
  return counts;
}

export function clearSyncFailures(taskId = null) {
  const failures = loadFailures();
  const remaining = taskId ? failures.filter((f) => f.taskId !== taskId) : [];
  const removed = failures.length - remaining.length;
  saveFailures(remaining);
  return removed;
}

export function removeSyncFailures(ids) {
  const idSet = new Set(ids);
  const failures = loadFailures();
  const remaining = failures.filter((f) => !idSet.has(f.id));
  saveFailures(remaining);
  return failures.length - remaining.length;
}

export function markSyncFailureRetried(id, error) {
  const failures = loadFailures();
  const idx = failures.findIndex((f) => f.id === id);
  if (idx === -1) return null;
  failures[idx].retryCount = (failures[idx].retryCount || 0) + 1;
  failures[idx].lastRetryAt = new Date().toISOString();
  failures[idx].errorMessage = error?.message || String(error || failures[idx].errorMessage || '');
  saveFailures(failures);
  return failures[idx];
}

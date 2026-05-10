// Sync history service - records each sync run

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getSyncHistoryFromStore,
  getSyncHistoryRecordFromStore,
  insertSyncHistoryRecord,
  isRuntimeSqliteEnabled,
  migrateRuntimeJsonOnce,
  updateSyncHistoryRecord,
} from './runtimeStore.js';
import { classifySyncError } from './errorGuidance.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.RUNTIME_STORE_DATA_DIR || join(dirname(dirname(__dirname)), 'data');
const HISTORY_FILE = join(DATA_DIR, 'sync-history.json');
const FAILURES_FILE = join(DATA_DIR, 'sync-failures.json');
const AUDIT_FILE = join(DATA_DIR, 'audit-logs.json');
const MAX_HISTORY_RECORDS = 2000;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
migrateRuntimeJsonOnce({ historyFile: HISTORY_FILE, failuresFile: FAILURES_FILE, auditFile: AUDIT_FILE });

function loadHistory() {
  if (!existsSync(HISTORY_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveHistory(history) {
  const tmpFile = `${HISTORY_FILE}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(history.slice(0, MAX_HISTORY_RECORDS), null, 2), 'utf-8');
  renameSync(tmpFile, HISTORY_FILE);
}

// Create a new sync history record when sync starts
export function createSyncHistory(taskId, taskName, sourceTable, targetTableId, options = {}) {
  if (isRuntimeSqliteEnabled()) {
    const record = buildSyncHistoryRecord(taskId, taskName, sourceTable, targetTableId, options);
    return insertSyncHistoryRecord(record);
  }
  const history = loadHistory();
  const record = buildSyncHistoryRecord(taskId, taskName, sourceTable, targetTableId, options);
  history.unshift(record); // newest first
  saveHistory(history);
  return record;
}

function buildSyncHistoryRecord(taskId, taskName, sourceTable, targetTableId, options = {}) {
  return {
    id: options.runId || `${taskId}_${Date.now()}`,
    runId: options.runId || null,
    taskId,
    taskName,
    sourceTable,
    targetTableId,
    trigger: options.trigger || 'unknown',
    startTime: new Date().toISOString(),
    endTime: null,
    status: 'running', // running, success, failed
    mode: 'full', // full, incremental
    sourceRows: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    softDeleted: 0,
    failed: 0,
    errorMessage: null,
    errorType: null,
    errorSummary: null,
    suggestedAction: null,
    actionTarget: null,
    durationMs: 0,
  };
}

// Update sync history when sync completes
export function updateSyncHistory(recordId, stats) {
  if (isRuntimeSqliteEnabled()) {
    return updateSyncHistoryRecord(recordId, (record) => applySyncHistoryStats(record, stats));
  }
  const history = loadHistory();
  const index = history.findIndex(r => r.id === recordId);
  if (index === -1) return null;
  
  const record = history[index];
  applySyncHistoryStats(record, stats);
  history[index] = record;
  saveHistory(history);
  return record;
}

function applySyncHistoryStats(record, stats) {
  record.status = stats.status || record.status; // running, success, failed
  if (record.status !== 'running') {
    record.endTime = new Date().toISOString();
  }
  record.runId = stats.runId || record.runId || record.id;
  record.trigger = stats.trigger || record.trigger || 'unknown';
  record.mode = stats.mode || record.mode;
  record.sourceRows = stats.sourceRows ?? record.sourceRows ?? 0;
  record.inserted = stats.inserted ?? record.inserted ?? 0;
  record.updated = stats.updated ?? record.updated ?? 0;
  record.skipped = stats.skipped ?? record.skipped ?? 0;
  record.deleted = stats.deleted ?? record.deleted ?? 0;
  record.softDeleted = stats.softDeleted ?? record.softDeleted ?? 0;
  record.failed = stats.failed ?? record.failed ?? 0;
  record.errorMessage = stats.errorMessage ?? record.errorMessage ?? null;
  if (record.errorMessage) {
    const guidance = stats.errorGuidance || classifySyncError(record.errorMessage, {
      status: record.status,
      trigger: record.trigger,
      taskName: record.taskName,
    });
    record.errorType = stats.errorType ?? guidance.errorType ?? record.errorType ?? null;
    record.errorSummary = stats.errorSummary ?? guidance.summary ?? record.errorSummary ?? null;
    record.suggestedAction = stats.suggestedAction ?? guidance.suggestedAction ?? record.suggestedAction ?? null;
    record.actionTarget = stats.actionTarget ?? guidance.actionTarget ?? record.actionTarget ?? null;
  } else if (['success', 'noop'].includes(record.status)) {
    record.errorType = null;
    record.errorSummary = null;
    record.suggestedAction = null;
    record.actionTarget = null;
  }
  record.durationMs = stats.durationMs ?? record.durationMs ?? 0;
  return record;
}

function decorateHistoryGuidance(record) {
  if (!record?.errorMessage || record.suggestedAction) return record;
  const guidance = classifySyncError(record.errorMessage, {
    status: record.status,
    trigger: record.trigger,
    taskName: record.taskName,
  });
  return {
    ...record,
    errorType: record.errorType || guidance.errorType,
    errorSummary: record.errorSummary || guidance.summary,
    suggestedAction: record.suggestedAction || guidance.suggestedAction,
    actionTarget: record.actionTarget || guidance.actionTarget,
  };
}

// Get sync history (all or filtered by taskId)
export function getSyncHistory(taskId = null, limit = 50) {
  if (isRuntimeSqliteEnabled()) return getSyncHistoryFromStore(taskId, limit).map(decorateHistoryGuidance);
  const history = loadHistory();
  if (taskId) {
    return history.filter(r => r.taskId === taskId).slice(0, limit).map(decorateHistoryGuidance);
  }
  return history.slice(0, limit).map(decorateHistoryGuidance);
}

// Get a single history record
export function getSyncHistoryRecord(recordId) {
  if (isRuntimeSqliteEnabled()) return decorateHistoryGuidance(getSyncHistoryRecordFromStore(recordId));
  const history = loadHistory();
  return decorateHistoryGuidance(history.find(r => r.id === recordId) || null);
}

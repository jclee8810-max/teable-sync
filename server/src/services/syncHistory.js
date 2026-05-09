// Sync history service - records each sync run

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(dirname(dirname(__dirname)), 'data');
const HISTORY_FILE = join(DATA_DIR, 'sync-history.json');
const MAX_HISTORY_RECORDS = 2000;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

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
  const history = loadHistory();
  const record = {
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
    durationMs: 0
  };
  history.unshift(record); // newest first
  saveHistory(history);
  return record;
}

// Update sync history when sync completes
export function updateSyncHistory(recordId, stats) {
  const history = loadHistory();
  const index = history.findIndex(r => r.id === recordId);
  if (index === -1) return null;
  
  const record = history[index];
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
  record.durationMs = stats.durationMs ?? record.durationMs ?? 0;
  
  history[index] = record;
  saveHistory(history);
  return record;
}

// Get sync history (all or filtered by taskId)
export function getSyncHistory(taskId = null, limit = 50) {
  const history = loadHistory();
  if (taskId) {
    return history.filter(r => r.taskId === taskId).slice(0, limit);
  }
  return history.slice(0, limit);
}

// Get a single history record
export function getSyncHistoryRecord(recordId) {
  const history = loadHistory();
  return history.find(r => r.id === recordId) || null;
}

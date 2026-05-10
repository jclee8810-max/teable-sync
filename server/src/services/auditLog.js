import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isAdmin } from './roles.js';
import { logger } from './logger.js';
import {
  getAuditLogsFromStore,
  insertAuditLogRecord,
  isRuntimeSqliteEnabled,
  migrateRuntimeJsonOnce,
} from './runtimeStore.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.RUNTIME_STORE_DATA_DIR || join(__dirname, '..', '..', 'data');
const AUDIT_FILE = join(DATA_DIR, 'audit-logs.json');
const HISTORY_FILE = join(DATA_DIR, 'sync-history.json');
const FAILURES_FILE = join(DATA_DIR, 'sync-failures.json');
const MAX_AUDIT_LOGS = 2000;

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}
migrateRuntimeJsonOnce({ historyFile: HISTORY_FILE, failuresFile: FAILURES_FILE, auditFile: AUDIT_FILE });

function readAuditLogs() {
  ensureDataDir();
  if (!existsSync(AUDIT_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(AUDIT_FILE, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAuditLogs(logs) {
  ensureDataDir();
  const tmpFile = `${AUDIT_FILE}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(logs.slice(-MAX_AUDIT_LOGS), null, 2), 'utf-8');
  renameSync(tmpFile, AUDIT_FILE);
}

export function appendAuditLog(user, action, details = {}) {
  try {
    const logs = readAuditLogs();
    const entry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      userId: user?.id || null,
      userEmail: user?.email || null,
      userRole: user?.role || null,
      action,
      resourceType: details.resourceType || null,
      resourceId: details.resourceId || null,
      resourceName: details.resourceName || null,
      outcome: details.outcome || 'success',
      message: details.message || '',
      metadata: details.metadata || {},
    };
    if (isRuntimeSqliteEnabled()) return insertAuditLogRecord(entry);
    logs.push(entry);
    writeAuditLogs(logs);
    return entry;
  } catch (err) {
    logger.warn('Audit log write failed:', err.message);
    return null;
  }
}

export function getAuditLogs({ user, limit = 200, action, resourceType } = {}) {
  if (isRuntimeSqliteEnabled()) {
    return getAuditLogsFromStore({
      limit,
      action,
      resourceType,
      userId: isAdmin(user) ? null : user?.id,
    });
  }
  let logs = readAuditLogs();
  if (!isAdmin(user)) {
    logs = logs.filter((entry) => entry.userId === user?.id);
  }
  if (action) logs = logs.filter((entry) => entry.action === action);
  if (resourceType) logs = logs.filter((entry) => entry.resourceType === resourceType);
  return logs.slice(-Math.min(Math.max(Number(limit) || 200, 1), 1000)).reverse();
}

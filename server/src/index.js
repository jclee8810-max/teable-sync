import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { static as expressStatic } from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import authRouter from './routes/auth.js';
import oauthRouter from './routes/oauth.js';
import { authMiddleware, verifyToken } from './middleware/auth.js';
import { canReadConnection, validateTaskConnections } from './services/accessControl.js';
import { decryptConfigSecrets, encryptConfigSecrets } from './services/secretStore.js';
import { getSyncFailures, getSyncFailure, getSyncFailureCounts, clearSyncFailures, removeSyncFailures, markSyncFailureRetried } from './services/syncFailures.js';
import { createTeableRecords, updateTeableRecords, deleteTeableRecords, getTeableRecords, normalizeTeableRecordsResponse } from './services/teableService.js';
import { runSystemDoctor } from './services/systemDoctor.js';
import { getTaskHealth, getTaskHealthMap } from './services/taskHealth.js';
import { reconcileTask } from './services/reconcileService.js';
import { appendAuditLog, getAuditLogs } from './services/auditLog.js';
import { createConfigBackup, getConfigBackups } from './services/configBackup.js';
import { getCurrentTaskSchema, detectTaskSchemaDrift } from './services/schemaDriftService.js';
import { buildObservabilitySnapshot } from './services/observabilityService.js';
import { buildConfigExport, previewConfigImport, applyConfigImport } from './services/configMigrationService.js';
import {
  cleanAlertNotificationInput,
  normalizeAlertNotificationSettings,
  sanitizeAlertNotificationSettings,
  sendAlertNotifications,
  sendTestAlertNotification,
} from './services/alertNotificationService.js';
import { clearTaskSyncState, getTaskInitializationState } from './services/syncEngine.js';
import { isAdmin, isOwner } from './services/roles.js';
import { logger } from './services/logger.js';
import { connectionLabel, getConnectionHealth } from './services/connectionHealth.js';
import { applyTestEnvironmentCleanup, buildTestEnvironmentPlan } from './services/testEnvironmentService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || process.env.RUNTIME_STORE_DATA_DIR || join(__dirname, '..', 'data');
const CONFIG_FILE = join(DATA_DIR, 'config.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3101;
const APP_VERSION = process.env.APP_VERSION || '1.0.0';
const GIT_COMMIT = process.env.GIT_COMMIT || 'unknown';
const BUILD_TIME = process.env.BUILD_TIME || 'unknown';
const ALERT_NOTIFICATION_SCAN_INTERVAL_MS = Math.max(15000, Number(process.env.ALERT_NOTIFICATION_SCAN_INTERVAL_MS || 60000));
const INITIALIZATION_CONCURRENCY = Math.max(1, Math.floor(Number(process.env.INITIALIZATION_CONCURRENCY || process.env.INITIALIZATION_QUEUE_CONCURRENCY || 1)));
const INITIALIZATION_QUEUE_AVG_RUN_MINUTES = Math.max(1, Math.floor(Number(process.env.INITIALIZATION_QUEUE_AVG_RUN_MINUTES || 30)));

// --- Scheduler state (in-memory) ---
const syncScheduler = new Map(); // taskId -> { intervalId, syncMode, intervalSec }
const syncRuns = new Map(); // taskId -> { controller, state }
const initializationQueue = [];
let activeInitializations = 0;

app.use(cors());
app.use(expressStatic(join(__dirname, '..', '..', 'client', 'dist')));
app.use(express.json({ limit: '50mb' }));

// --- Config persistence (with write lock for concurrency safety) ---
let _writeLock = Promise.resolve();

function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    const config = decryptConfigSecrets(JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')));
    if (!Array.isArray(config.taskTemplates)) config.taskTemplates = [];
    if (!config.alertNotifications || typeof config.alertNotifications !== 'object') config.alertNotifications = {};
    if (!config.alertStates || typeof config.alertStates !== 'object') config.alertStates = {};
    return config;
  }
  const defaults = { connections: [], syncTasks: [], syncLogs: [], taskTemplates: [], alertNotifications: {}, alertStates: {} };
  saveConfig(defaults);
  return defaults;
}

function saveConfig(config, options = {}) {
  const { backup = true, backupReason = 'write' } = options;
  _writeLock = _writeLock.then(() => {
    const tmpFile = `${CONFIG_FILE}.tmp`;
    if (backup) createConfigBackup(CONFIG_FILE, backupReason);
    writeFileSync(tmpFile, JSON.stringify(encryptConfigSecrets(config), null, 2), 'utf-8');
    renameSync(tmpFile, CONFIG_FILE);
  }).catch(err => {
    logger.error('Config write error:', err.message);
  });
  return _writeLock;
}

function quoteSqlIdentifier(type, name) {
  if (!/^[a-zA-Z0-9_.]+$/.test(name)) {
    throw new Error(`非法标识符: ${name}`);
  }
  const parts = name.split('.');
  if (type === 'mssql') return parts.map((p) => `[${p.replace(/]/g, ']]')}]`).join('.');
  if (type === 'mysql') return parts.map((p) => `\`${p.replace(/`/g, '``')}\``).join('.');
  if (type === 'pg') return parts.map((p) => `"${p.replace(/"/g, '""')}"`).join('.');
  throw new Error(`Unsupported database type: ${type}`);
}

function sqlPlaceholder(type, index) {
  return type === 'pg' ? `$${index + 1}` : '?';
}

const CONNECTION_SECRET_FIELDS = ['password', 'token', 'oauthClientSecret', 'teableOAuthToken'];
const CONNECTION_DTO_ONLY_FIELDS = ['hasPassword', 'hasToken', 'hasOauthClientSecret'];
const CONNECTION_TEST_FIELDS = ['lastTest'];

function sanitizeConnection(conn) {
  const safe = { ...conn };
  safe.testHealth = getConnectionHealth(conn);
  for (const field of CONNECTION_SECRET_FIELDS) {
    if (safe[field]) {
      const flag = field === 'oauthClientSecret'
        ? 'hasOauthClientSecret'
        : `has${field[0].toUpperCase()}${field.slice(1)}`;
      safe[flag] = true;
    }
    delete safe[field];
  }
  if (safe.config && typeof safe.config === 'object') {
    safe.config = { ...safe.config };
    for (const field of CONNECTION_SECRET_FIELDS) {
      if (safe.config[field]) {
        const flag = field === 'oauthClientSecret'
          ? 'hasOauthClientSecret'
          : `has${field[0].toUpperCase()}${field.slice(1)}`;
        safe[flag] = true;
      }
      delete safe.config[field];
    }
  }
  return safe;
}

function cleanConnectionInput(body = {}) {
  const { id, ownerId, createdAt, deletedAt, ...cleaned } = body;
  for (const field of [...CONNECTION_DTO_ONLY_FIELDS, ...CONNECTION_TEST_FIELDS]) delete cleaned[field];
  for (const field of CONNECTION_SECRET_FIELDS) {
    if (cleaned[field] === '') delete cleaned[field];
  }
  return cleaned;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function cleanTaskInput(body = {}) {
  const { id, userId, createdAt, deletedAt, status, enabled, lastSyncAt, connectionStatus, sourceConnection, targetConnection, ...cleaned } = body;
  cleaned.pageSize = clampInt(cleaned.pageSize, 1000, 100, 5000);
  cleaned.batchSize = clampInt(cleaned.batchSize, 500, 10, 1000);
  cleaned.retryCount = clampInt(cleaned.retryCount, 3, 1, 8);
  cleaned.maxInitialRows = clampInt(cleaned.maxInitialRows, 100000, 1000, 10000000);
  cleaned.initialReadPagesPerMinute = clampInt(cleaned.initialReadPagesPerMinute, 0, 0, 100000);
  cleaned.initialWriteBatchesPerMinute = clampInt(cleaned.initialWriteBatchesPerMinute, 0, 0, 100000);
  cleaned.initialMaxRunMinutes = clampInt(cleaned.initialMaxRunMinutes, 0, 0, 1440);
  if ('syncMode' in cleaned && !['manual', 'scheduled', 'realtime', 'incremental'].includes(cleaned.syncMode)) cleaned.syncMode = 'manual';
  if ('syncDirection' in cleaned && !['one_way', 'bidirectional'].includes(cleaned.syncDirection)) cleaned.syncDirection = 'one_way';
  if ('conflictStrategy' in cleaned && !['upsert', 'skip', 'insert_only', 'source_wins', 'target_wins', 'latest_wins', 'skip_conflict'].includes(cleaned.conflictStrategy)) cleaned.conflictStrategy = 'upsert';
  if (!['ignore', 'soft_delete', 'hard_delete'].includes(cleaned.deletionMode)) cleaned.deletionMode = 'ignore';
  if (!/^[a-zA-Z0-9_]+$/.test(cleaned.softDeleteField || 'deleted')) cleaned.softDeleteField = 'deleted';
  if (cleaned.sourceTable && typeof cleaned.sourceTable === 'string') cleaned.sourceTable = cleaned.sourceTable.trim();
  if (cleaned.targetTableId && typeof cleaned.targetTableId === 'string') cleaned.targetTableId = cleaned.targetTableId.trim();
  return cleaned;
}

const TASK_RUNTIME_FIELDS = ['id', 'userId', 'ownerId', 'createdAt', 'updatedAt', 'deletedAt', 'status', 'enabled', 'lastSyncAt', 'connectionStatus', 'sourceConnection', 'targetConnection'];

function taskConfigSnapshot(task = {}) {
  const snapshot = { ...task };
  for (const field of TASK_RUNTIME_FIELDS) delete snapshot[field];
  delete snapshot._running;
  return cleanTaskInput(snapshot);
}

function buildCopiedTask(sourceTask, overrides = {}) {
  const body = cleanTaskInput({ ...taskConfigSnapshot(sourceTask), ...overrides });
  return {
    ...body,
    id: crypto.randomUUID(),
    name: body.name || `${sourceTask.name || '同步任务'} 副本`,
    syncMode: body.syncMode || 'manual',
    syncDirection: body.syncDirection || 'one_way',
    conflictStrategy: body.conflictStrategy || 'upsert',
    enabled: false,
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
    status: 'idle',
    userId: sourceTask.userId,
  };
}

function canUseTemplate(user, template) {
  return template && !template.deletedAt && (isAdmin(user) || template.userId === user.id || template.shared === true);
}

async function attachSchemaSnapshot(task, srcConn, tgtConn) {
  if (!task || !srcConn || !tgtConn) return task;
  try {
    task.schemaSnapshot = await getCurrentTaskSchema(task, srcConn, tgtConn);
  } catch (err) {
    task.schemaSnapshotError = err.message;
  }
  return task;
}

function buildTaskConnectionStatus(config, user, task) {
  const sourceId = task.sourceConnectionId || task.sourceId;
  const targetId = task.targetConnectionId || task.targetId;
  const srcConnRaw = sourceId ? config.connections.find((c) => c.id === sourceId) : null;
  const tgtConnRaw = targetId ? config.connections.find((c) => c.id === targetId) : null;
  const validation = validateTaskConnections(config, user, task);
  const issues = [];

  if (!sourceId) issues.push({ field: 'sourceConnectionId', level: 'error', message: '未配置源连接' });
  if (!targetId) issues.push({ field: 'targetConnectionId', level: 'error', message: '未配置 Teable 目标连接' });
  if (sourceId && !srcConnRaw) issues.push({ field: 'sourceConnectionId', level: 'error', message: `源连接不存在: ${sourceId}` });
  else if (srcConnRaw?.deletedAt) issues.push({ field: 'sourceConnectionId', level: 'error', message: `源连接已删除: ${connectionLabel(srcConnRaw, sourceId)}` });
  if (targetId && !tgtConnRaw) issues.push({ field: 'targetConnectionId', level: 'error', message: `目标连接不存在: ${targetId}` });
  else if (tgtConnRaw?.deletedAt) issues.push({ field: 'targetConnectionId', level: 'error', message: `目标连接已删除: ${connectionLabel(tgtConnRaw, targetId)}` });
  if (srcConnRaw && !['mssql', 'mysql', 'pg', 'teable'].includes(srcConnRaw.type)) issues.push({ field: 'sourceConnectionId', level: 'error', message: `源连接类型错误: ${connectionLabel(srcConnRaw, sourceId)} 不是 SQL 或 Teable` });
  if (tgtConnRaw && tgtConnRaw.type !== 'teable') issues.push({ field: 'targetConnectionId', level: 'error', message: `目标连接类型错误: ${connectionLabel(tgtConnRaw, targetId)} 不是 Teable` });
  if (task.syncDirection === 'bidirectional') {
    if (srcConnRaw && srcConnRaw.type !== 'teable') issues.push({ field: 'syncDirection', level: 'error', message: '双向同步仅支持 Teable ↔ Teable' });
    if (task.deletionMode && task.deletionMode !== 'ignore') issues.push({ field: 'deletionMode', level: 'warn', message: '双向删除仅根据软删除标记传播，单侧缺失记录不会被直接删除' });
  }
  if (validation.error && issues.length === 0) issues.push({ field: 'connections', level: 'error', message: validation.error });

  for (const [field, conn] of [['sourceConnectionId', srcConnRaw], ['targetConnectionId', tgtConnRaw]]) {
    if (!conn || conn.deletedAt) continue;
    const health = getConnectionHealth(conn);
    if (health.severity === 'error') issues.push({ field, level: 'error', message: health.message });
    else if (health.severity === 'warn') issues.push({ field, level: 'warn', message: health.message });
  }

  return {
    ok: issues.filter((issue) => issue.level === 'error').length === 0,
    source: sourceId ? {
      id: sourceId,
      name: connectionLabel(srcConnRaw, sourceId),
      type: srcConnRaw?.type || null,
      readable: Boolean(validation.srcConn),
      lastTest: srcConnRaw?.lastTest || null,
      testHealth: srcConnRaw ? getConnectionHealth(srcConnRaw, { fallbackId: sourceId }) : null,
    } : null,
    target: targetId ? {
      id: targetId,
      name: connectionLabel(tgtConnRaw, targetId),
      type: tgtConnRaw?.type || null,
      readable: Boolean(validation.tgtConn),
      lastTest: tgtConnRaw?.lastTest || null,
      testHealth: tgtConnRaw ? getConnectionHealth(tgtConnRaw, { fallbackId: targetId }) : null,
    } : null,
    issues,
  };
}

function validateTaskRunnable(config, user, task, options = {}) {
  const { requireTarget = true } = options;
  return validateTaskConnections(config, user, task, { requireTarget, requireTested: true });
}

function taskDto(config, user, task) {
  return {
    ...task,
    connectionStatus: buildTaskConnectionStatus(config, user, task),
  };
}

function recordConnectionTest(config, connId, result) {
  const idx = config.connections.findIndex((c) => c.id === connId);
  if (idx === -1) return Promise.resolve();
  config.connections[idx].lastTest = {
    success: result.success === true,
    testedAt: new Date().toISOString(),
    message: result.message || result.version || null,
    error: result.success === true ? null : (result.error || '未知错误'),
    testedBy: result.testedBy || null,
  };
  return saveConfig(config, { backup: false });
}

function createRunState(task, trigger) {
  return {
    taskId: task.id,
    taskName: task.name,
    trigger,
    status: 'running',
    phase: 'starting',
    processedRows: 0,
    targetRows: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    softDeleted: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cancellable: true,
  };
}

function calculateQueueEstimate(position) {
  const occupiedSlots = Math.max(0, activeInitializations);
  const batchIndex = Math.max(0, Math.floor((occupiedSlots + Math.max(1, position) - 1) / INITIALIZATION_CONCURRENCY));
  return new Date(Date.now() + batchIndex * INITIALIZATION_QUEUE_AVG_RUN_MINUTES * 60000).toISOString();
}

function buildInitializationQueueMeta(taskId) {
  const index = initializationQueue.findIndex((item) => item.task.id === taskId);
  const position = index >= 0 ? index + 1 : 0;
  return {
    queued: index >= 0,
    position,
    active: activeInitializations,
    concurrency: INITIALIZATION_CONCURRENCY,
    queueLength: initializationQueue.length,
    estimatedStartAt: position ? calculateQueueEstimate(position) : null,
  };
}

function updateQueuedInitializationStates() {
  initializationQueue.forEach((item, index) => {
    const position = index + 1;
    item.runControl.onProgress({
      status: 'queued',
      phase: 'queued',
      cancellable: true,
      queuePosition: position,
      queueLength: initializationQueue.length,
      initializationConcurrency: INITIALIZATION_CONCURRENCY,
      estimatedStartAt: calculateQueueEstimate(position),
    });
  });
}

function removeQueuedInitialization(taskId, reason = '排队中的初始化已取消') {
  const index = initializationQueue.findIndex((item) => item.task.id === taskId);
  if (index === -1) return null;
  const [job] = initializationQueue.splice(index, 1);
  job.runControl.signal?.aborted || job.runControl.finish({
    status: 'cancelled',
    phase: 'cancelled',
    errorMessage: reason,
    cancellable: false,
  });
  updateQueuedInitializationStates();
  processInitializationQueue();
  return job;
}

function startTrackedRun(task, trigger) {
  const existing = syncRuns.get(task.id);
  if (['running', 'queued', 'cancelling'].includes(existing?.state.status)) {
    return {
      owned: false,
      signal: existing.controller.signal,
      onProgress: () => {},
      finish: () => {},
    };
  }
  const controller = new AbortController();
  const state = createRunState(task, trigger);
  syncRuns.set(task.id, { controller, state });
  return {
    owned: true,
    signal: controller.signal,
    onProgress: (patch) => {
      const current = syncRuns.get(task.id);
      if (!current) return;
      current.state = { ...current.state, ...patch, updatedAt: new Date().toISOString() };
      syncRuns.set(task.id, current);
    },
    finish: (patch = {}) => {
      const current = syncRuns.get(task.id);
      if (!current) return;
      current.state = { ...current.state, ...patch, cancellable: false, updatedAt: new Date().toISOString() };
      syncRuns.set(task.id, current);
      setTimeout(() => {
        const latest = syncRuns.get(task.id);
        if (latest?.state.updatedAt === current.state.updatedAt) syncRuns.delete(task.id);
      }, 5 * 60 * 1000);
    },
  };
}

function getRunState(taskId) {
  const state = syncRuns.get(taskId)?.state;
  if (state) {
    return {
      ...state,
      initializationQueue: buildInitializationQueueMeta(taskId),
    };
  }
  return { taskId, status: 'idle', phase: 'idle', cancellable: false, initializationQueue: buildInitializationQueueMeta(taskId) };
}

function assertTaskAccess(user, task, action = '访问') {
  if (!task) {
    const err = new Error('Not found');
    err.status = 404;
    throw err;
  }
  if (!isAdmin(user) && task.userId !== user.id) {
    const err = new Error(`无权${action}此任务`);
    err.status = 403;
    throw err;
  }
}

function sanitizeFailureForApi(failure) {
  return {
    ...failure,
    records: undefined,
    recordIds: undefined,
    hasPayload: Boolean(failure.records || failure.recordIds),
  };
}

function buildVersionInfo() {
  return {
    version: APP_VERSION,
    commit: GIT_COMMIT,
    buildTime: BUILD_TIME,
    nodeEnv: process.env.NODE_ENV || 'development',
  };
}

function pruneAlertStates(config, currentAlertIds = []) {
  const ids = new Set(currentAlertIds);
  const next = {};
  for (const [id, state] of Object.entries(config.alertStates || {})) {
    if (ids.has(id)) next[id] = state;
    else if (state?.acknowledgedAt || state?.mutedUntil) next[id] = { ...state, resolvedAt: state.resolvedAt || new Date().toISOString() };
  }
  config.alertStates = Object.fromEntries(Object.entries(next).slice(-500));
}

function buildObservabilityForUser(config, user) {
  const tasks = config.syncTasks
    .filter((task) => !task.deletedAt && (isAdmin(user) || task.userId === user.id))
    .map((task) => taskDto(config, user, task));
  const visibleTaskIds = new Set(tasks.map((task) => task.id));
  const schedulerStatus = {};
  const runStates = {};
  for (const [taskId, info] of syncScheduler) {
    if (visibleTaskIds.has(taskId)) schedulerStatus[taskId] = { syncMode: info.syncMode, intervalSec: info.intervalSec };
  }
  for (const task of tasks) {
    runStates[task.id] = getRunState(task.id);
  }
  return buildObservabilitySnapshot({
    config,
    user,
    tasks,
    schedulerStatus,
    runStates,
    version: buildVersionInfo(),
    alertStates: config.alertStates || {},
  });
}

function getAppUrl() {
  return process.env.SERVER_PUBLIC_URL || `http://localhost:${PORT}`;
}

function acceptanceStep(status, title, message, meta = {}) {
  return { status, title, message, ...meta };
}

function summarizeAcceptanceSteps(steps) {
  return {
    pass: steps.filter((step) => step.status === 'pass').length,
    warn: steps.filter((step) => step.status === 'warn').length,
    fail: steps.filter((step) => step.status === 'fail').length,
  };
}

async function testConnectionForAcceptance(config, conn, user) {
  try {
    let result;
    if (conn.type === 'teable') {
      const { getTeableSpaces } = await import('./services/teableService.js');
      const spaces = await getTeableSpaces(conn);
      result = { success: true, type: 'teable', message: `连接成功，共 ${spaces.length} 个空间`, spaces: spaces.length };
    } else {
      const { testConnection } = await import('./services/dbService.js');
      result = { success: true, type: conn.type, ...(await testConnection(conn)) };
    }
    await recordConnectionTest(config, conn.id, { ...result, testedBy: user.id });
    return result;
  } catch (err) {
    const result = { success: false, type: conn.type, error: err.message };
    await recordConnectionTest(config, conn.id, { ...result, testedBy: user.id });
    return result;
  }
}

async function buildAcceptanceReport(user, options = {}) {
  const startedAt = new Date();
  const steps = [];
  const details = { connections: [], tasks: [], preflights: [] };
  let config = loadConfig();

  const doctor = runSystemDoctor({ dataDir: DATA_DIR, configFile: CONFIG_FILE, config });
  steps.push(acceptanceStep(
    doctor.status === 'fail' ? 'fail' : doctor.status === 'warn' ? 'warn' : 'pass',
    '系统检查',
    `${doctor.summary.pass} 通过，${doctor.summary.warn} 警告，${doctor.summary.fail} 失败`,
    { doctorSummary: doctor.summary },
  ));

  const envPlan = buildTestEnvironmentPlan(config);
  steps.push(acceptanceStep(
    envPlan.summary.readyBaselineConnections >= Math.min(1, envPlan.summary.baselineConnections) ? (envPlan.warnings.length ? 'warn' : 'pass') : 'fail',
    '测试基准环境',
    `找到 ${envPlan.summary.baselineConnections} 个基准数据源，${envPlan.summary.readyBaselineConnections} 个最近测试通过`,
    { environment: envPlan.summary, warnings: envPlan.warnings },
  ));

  const scope = options.connectionScope === 'all' ? 'all' : 'baseline';
  const baselineNames = new Set(envPlan.baselineConnectionNames.map((name) => name.toLowerCase()));
  const visibleConnections = (config.connections || []).filter((conn) => !conn.deletedAt && (isAdmin(user) || conn.ownerId === user.id || conn.shared === true));
  const connectionsToTest = visibleConnections
    .filter((conn) => scope === 'all' || baselineNames.has(String(conn.name || '').toLowerCase()))
    .slice(0, 20);
  let connectionFailures = 0;
  for (const conn of connectionsToTest) {
    const result = await testConnectionForAcceptance(config, conn, user);
    details.connections.push({ id: conn.id, name: conn.name, type: conn.type, success: result.success === true, message: result.message || null, error: result.error || null });
    if (result.success !== true) connectionFailures += 1;
  }
  config = loadConfig();
  steps.push(acceptanceStep(
    connectionFailures > 0 ? 'fail' : connectionsToTest.length > 0 ? 'pass' : 'warn',
    '数据源实测',
    connectionsToTest.length > 0 ? `${connectionsToTest.length - connectionFailures}/${connectionsToTest.length} 个数据源连接成功` : '没有可测试的数据源',
    { scope, tested: connectionsToTest.length, failed: connectionFailures },
  ));

  const tasks = (config.syncTasks || []).filter((task) => !task.deletedAt && (isAdmin(user) || task.userId === user.id));
  const runnable = [];
  const blocked = [];
  for (const task of tasks) {
    const dto = taskDto(config, user, task);
    const issues = dto.connectionStatus?.issues || [];
    const errors = issues.filter((issue) => issue.level === 'error');
    const item = { id: task.id, name: task.name, status: task.status, enabled: task.enabled === true, errors: errors.map((issue) => issue.message), warnings: issues.filter((issue) => issue.level !== 'error').map((issue) => issue.message) };
    details.tasks.push(item);
    if (errors.length > 0) blocked.push(item);
    else runnable.push(task);
  }
  steps.push(acceptanceStep(
    blocked.length > 0 ? 'warn' : 'pass',
    '任务可运行性',
    `${runnable.length} 个任务连接正常，${blocked.length} 个任务需要处理连接或配置`,
    { runnable: runnable.length, blocked: blocked.length },
  ));

  const preflightLimit = Math.max(0, Math.min(5, Number(options.preflightLimit ?? 3) || 3));
  let preflightWarn = 0;
  let preflightFail = 0;
  for (const task of runnable.slice(0, preflightLimit)) {
    try {
      const srcConn = config.connections.find((c) => c.id === (task.sourceConnectionId || task.sourceId));
      const tgtConn = config.connections.find((c) => c.id === (task.targetConnectionId || task.targetId));
      const result = await runTaskPreflightCheck(task, srcConn, tgtConn);
      details.preflights.push({ taskId: task.id, taskName: task.name, status: result.status, summary: result.summary });
      if (result.status === 'error') preflightFail += 1;
      else if (result.status === 'warn') preflightWarn += 1;
    } catch (err) {
      preflightFail += 1;
      details.preflights.push({ taskId: task.id, taskName: task.name, status: 'error', error: err.message });
    }
  }
  steps.push(acceptanceStep(
    preflightFail > 0 ? 'fail' : preflightWarn > 0 ? 'warn' : 'pass',
    '同步前预检抽样',
    preflightLimit > 0 ? `已预检 ${details.preflights.length} 个任务，${preflightWarn} 个警告，${preflightFail} 个失败` : '已跳过预检抽样',
    { checked: details.preflights.length, warnings: preflightWarn, failures: preflightFail },
  ));

  const failureCounts = getSyncFailureCounts();
  const visibleTaskIds = new Set(tasks.map((task) => task.id));
  const failedRows = Object.entries(failureCounts).reduce((sum, [taskId, count]) => visibleTaskIds.has(taskId) ? sum + count : sum, 0);
  steps.push(acceptanceStep(
    failedRows > 0 ? 'warn' : 'pass',
    '失败批次',
    failedRows > 0 ? `仍有 ${failedRows} 条失败批次待处理` : '没有待处理失败批次',
    { failedRows },
  ));

  const snapshot = buildObservabilityForUser(config, user);
  const openAlerts = (snapshot.alerts || []).filter((alert) => alert.state !== 'resolved');
  const blockingAlerts = openAlerts.filter((alert) => alert.severity === 'critical' && !['acknowledged', 'muted'].includes(alert.state));
  steps.push(acceptanceStep(
    blockingAlerts.length > 0 ? 'fail' : openAlerts.length > 0 ? 'warn' : 'pass',
    '观测告警',
    blockingAlerts.length > 0
      ? `当前有 ${blockingAlerts.length} 条未处理严重告警`
      : openAlerts.length > 0
        ? `当前有 ${openAlerts.length} 条已确认或待关注告警`
        : '当前没有告警',
    { alerts: openAlerts.length, blockingAlerts: blockingAlerts.length },
  ));

  const summary = summarizeAcceptanceSteps(steps);
  const status = summary.fail > 0 ? 'fail' : summary.warn > 0 ? 'warn' : 'pass';
  return {
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    summary,
    steps,
    details,
  };
}

// --- Auth routes (public) ---
app.use('/api/auth', authRouter);
// --- OAuth routes ---
app.use('/api/oauth', oauthRouter);

// --- Public health (before auth middleware) ---
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/version', (req, res) => {
  res.json({
    name: 'teable-sync',
    version: APP_VERSION,
    commit: GIT_COMMIT,
    buildTime: BUILD_TIME,
    nodeEnv: process.env.NODE_ENV || 'development',
  });
});

// --- Protected API routes ---
app.use('/api', authMiddleware);
const server = app.listen(PORT, () => {
  logger.info(`TeableSync Server running on http://localhost:${PORT}`);
  resumeEnabledTasks().catch((err) => logger.warn(`自动恢复检查失败: ${err.message}`));
  startAlertNotificationScanner();
});

const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws._userId = null;
  ws._role = null;
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'auth' && msg.token) {
        const user = verifyToken(msg.token);
        if (user) {
          ws._userId = user.id;
          ws._role = user.role;
        } else {
          ws.close(1008, 'Invalid token');
        }
      }
    } catch {
      ws.close(1008, 'Invalid message');
    }
  });
  ws.on('close', () => wsClients.delete(ws));
});

function broadcastLog(log) {
  const msg = JSON.stringify({ type: 'sync_log', data: log });
  wsClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// broadcastLogUser: sends only to the WebSocket client authenticated as the given userId
function broadcastLogUser(log, userId) {
  const msg = JSON.stringify({ type: 'sync_log', data: { ...log, userId } });
  wsClients.forEach((ws) => {
    if (ws.readyState === 1 && ws._userId === userId) ws.send(msg);
  });
}

async function persistSyncLog(entry) {
  broadcastLog(entry);
  const cfg = loadConfig();
  cfg.syncLogs.push(entry);
  if (cfg.syncLogs.length > 500) cfg.syncLogs = cfg.syncLogs.slice(-500);
  await saveConfig(cfg, { backup: false });
}

async function persistUserSyncLog(entry, userId) {
  const enhanced = { ...entry, userId };
  broadcastLogUser(enhanced, userId);
  const cfg = loadConfig();
  cfg.syncLogs.push(enhanced);
  if (cfg.syncLogs.length > 500) cfg.syncLogs = cfg.syncLogs.slice(-500);
  await saveConfig(cfg, { backup: false });
}

function getTaskStartMissingFields(task) {
  const missingFields = [];
  if (!task.sourceTable) missingFields.push('sourceTable');
  if (!task.targetTableId) missingFields.push('targetTableId');
  if (!task.sourceConnectionId && !task.sourceId) missingFields.push('sourceConnectionId');
  if (!task.targetConnectionId && !task.targetId) missingFields.push('targetConnectionId');
  return missingFields;
}

function isAutoSyncMode(mode) {
  return ['scheduled', 'realtime', 'incremental'].includes(mode || 'manual');
}

async function runTaskPreflightCheck(task, srcConn, tgtConn) {
  const { runTaskPreflight } = await import('./services/preflightService.js');
  return runTaskPreflight(task, srcConn, tgtConn);
}

function preflightError(result) {
  if (!result || result.ok) return null;
  const firstError = (result.issues || []).find((issue) => issue.level === 'error');
  const message = firstError?.message || `同步前预检未通过：${result.summary?.error || 0} 个错误`;
  const err = new Error(message);
  err.status = 400;
  err.preflight = result;
  return err;
}

function shouldUseInitializationMode(preflight, requested = false) {
  if (requested) return true;
  const estimate = preflight?.initialFullSync;
  return Boolean(estimate?.initialRun && Number(estimate.sourceRows || 0) > 0);
}

function enqueueInitializationRun(job) {
  if (!job?.runControl?.owned) return false;
  if (!job.initializationMode) return false;
  initializationQueue.push({
    ...job,
    queuedAt: new Date().toISOString(),
  });
  updateQueuedInitializationStates();
  processInitializationQueue();
  return true;
}

async function processInitializationQueue() {
  while (activeInitializations < INITIALIZATION_CONCURRENCY && initializationQueue.length > 0) {
    const job = initializationQueue.shift();
    if (job.runControl.signal?.aborted) {
      job.runControl.finish({ status: 'cancelled', phase: 'cancelled', errorMessage: '排队中的初始化已取消', cancellable: false });
      continue;
    }
    activeInitializations++;
    updateQueuedInitializationStates();
    runInitializationJob(job)
      .catch((err) => logger.error(`初始化队列任务失败: ${err.message}`))
      .finally(() => {
        activeInitializations = Math.max(0, activeInitializations - 1);
        updateQueuedInitializationStates();
        processInitializationQueue();
      });
  }
}

async function runInitializationJob(job) {
  const { task, srcConn, tgtConn, runControl, persistLog, resetState, trigger, actorUser, mode, intervalSec } = job;
  runControl.onProgress({
    status: 'running',
    phase: 'starting',
    queuePosition: 0,
    queueLength: initializationQueue.length,
    initializationConcurrency: INITIALIZATION_CONCURRENCY,
    estimatedStartAt: null,
  });
  await persistLog({ taskId: task.id, level: 'info', message: `初始化队列开始执行: 并发 ${activeInitializations}/${INITIALIZATION_CONCURRENCY}`, ts: new Date().toISOString() });
  const { runSyncWithControl } = await import('./services/syncEngine.js');
  try {
    const result = await runSyncWithControl(task, srcConn, tgtConn, persistLog, {
      ...runControl,
      resetState,
      initializationMode: true,
      trigger,
    });
    runControl.finish({ status: result?.status || 'success', phase: result?.status === 'skipped' ? 'skipped' : 'completed', cancellable: false });
    await finalizeTaskRun(task, result, { scheduled: Boolean(mode), intervalSec });
    if (mode && result?.status !== 'skipped') {
      await persistLog({ taskId: task.id, level: 'info', message: `[${mode}] 同步完成，下次同步: ${intervalSec}s 后`, ts: new Date().toISOString() });
    }
  } catch (err) {
    const cancelled = err.code === 'SYNC_CANCELLED';
    const paused = err.code === 'SYNC_INITIALIZATION_PAUSED';
    runControl.finish({
      status: paused ? 'paused' : cancelled ? 'cancelled' : 'failed',
      phase: paused ? 'paused' : cancelled ? 'cancelled' : 'failed',
      errorMessage: err.message,
      cancellable: false,
    });
    await failTaskRun(task, err, { scheduled: Boolean(mode) });
    if (actorUser) {
      appendAuditLog(actorUser, 'task.initialization.failed', {
        resourceType: 'task',
        resourceId: task.id,
        resourceName: task.name,
        message: `初始化任务失败 ${task.name || task.id}`,
        metadata: { error: err.message, trigger },
      });
    }
  }
}

function teableFormulaString(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function findExistingTeableRecordByPk(conn, tableId, pkFieldName, pkValue) {
  if (!pkFieldName || pkValue === undefined || pkValue === null || pkValue === '') return null;
  const formula = `{${pkFieldName}} = "${teableFormulaString(pkValue)}"`;
  const result = await getTeableRecords(conn, tableId, { take: 1, filter: { conjunction: 'and', filterSet: [{ fieldId: pkFieldName, operator: 'is', value: String(pkValue) }], formula } });
  const records = normalizeTeableRecordsResponse(result);
  return records[0] || null;
}

async function replayFailureBatch(tgtConn, task, failure) {
  const tableId = failure.tableId || task.targetTableId;
  const records = failure.records || [];
  if (failure.operation === 'insert') {
    const safeInserts = [];
    const safeUpdates = [];
    for (const record of records) {
      const pk = failure.pkFieldName ? record.fields?.[failure.pkFieldName] : null;
      const existing = await findExistingTeableRecordByPk(tgtConn, tableId, failure.pkFieldName, pk).catch(() => null);
      if (existing?.id || existing?.recordId) {
        safeUpdates.push({ id: existing.id || existing.recordId, fields: record.fields || {} });
      } else {
        safeInserts.push(record);
      }
    }
    if (safeInserts.length) await createTeableRecords(tgtConn, tableId, safeInserts);
    if (safeUpdates.length) await updateTeableRecords(tgtConn, tableId, safeUpdates);
    return { inserted: safeInserts.length, updated: safeUpdates.length };
  }
  if (failure.operation === 'update' || failure.operation === 'soft_delete') {
    await updateTeableRecords(tgtConn, tableId, records);
    return { updated: records.length };
  }
  if (failure.operation === 'hard_delete') {
    await deleteTeableRecords(tgtConn, tableId, failure.recordIds || []);
    return { deleted: failure.recordIds?.length || 0 };
  }
  throw new Error('Unsupported failure operation: ' + failure.operation);
}

async function finalizeTaskRun(task, result, options = {}) {
  const cfg = loadConfig();
  const idx = cfg.syncTasks.findIndex((x) => x.id === task.id);
  if (idx !== -1) {
    cfg.syncTasks[idx].status = options.scheduled || syncScheduler.has(task.id) ? 'scheduled' : 'idle';
    if (result?.status !== 'skipped') cfg.syncTasks[idx].lastSyncAt = new Date().toISOString();
    await saveConfig(cfg);
  }
}

async function failTaskRun(task, err, options = {}) {
  const cancelled = err.code === 'SYNC_CANCELLED';
  const paused = err.code === 'SYNC_INITIALIZATION_PAUSED';
  const cfg = loadConfig();
  const idx = cfg.syncTasks.findIndex((x) => x.id === task.id);
  if (idx !== -1) {
    cfg.syncTasks[idx].status = options.scheduled || syncScheduler.has(task.id) ? 'scheduled' : (cancelled || paused ? 'idle' : 'error');
    await saveConfig(cfg, { backup: false });
  }
}

async function runScheduledTask(taskId, trigger, mode, intervalSec) {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === taskId);
  if (!task || !task.enabled) {
    const scheduled = syncScheduler.get(taskId);
    if (scheduled) clearInterval(scheduled.intervalId);
    syncScheduler.delete(taskId);
    return { status: 'disabled' };
  }
  if (task.status === 'running') return { status: 'skipped' };

  const srcConn = config.connections.find((c) => c.id === (task.sourceConnectionId || task.sourceId));
  const tgtConn = config.connections.find((c) => c.id === (task.targetConnectionId || task.targetId));
  const validation = validateTaskRunnable(config, { id: task.userId, role: 'user' }, task);
  if (validation.error || !srcConn || !tgtConn) {
    const error = validation.error || 'Connection not found';
    await persistUserSyncLog({ taskId: task.id, level: 'error', message: `[${mode}] 未启动: ${error}`, ts: new Date().toISOString() }, task.userId);
    return { status: 'invalid', error };
  }

  let preflightForRun = null;
  try {
    const preflight = await runTaskPreflightCheck(task, validation.srcConn || srcConn, validation.tgtConn || tgtConn);
    preflightForRun = preflight;
    const gateError = preflightError(preflight);
    if (gateError) {
      await persistUserSyncLog({ taskId: task.id, level: 'error', message: `[${mode}] 预检未通过: ${gateError.message}`, ts: new Date().toISOString() }, task.userId);
      return { status: 'preflight_failed', error: gateError.message, preflight };
    }
    if (preflight.status === 'warn') {
      await persistUserSyncLog({ taskId: task.id, level: 'warn', message: `[${mode}] 预检有 ${preflight.summary.warn} 个警告，继续执行`, ts: new Date().toISOString() }, task.userId);
    }
    task._initializationMode = shouldUseInitializationMode(preflight);
  } catch (err) {
    await persistUserSyncLog({ taskId: task.id, level: 'error', message: `[${mode}] 预检失败: ${err.message}`, ts: new Date().toISOString() }, task.userId);
    return { status: 'preflight_failed', error: err.message };
  }

  const runControl = startTrackedRun(task, trigger);
  if (!runControl.owned) {
    await persistUserSyncLog({ taskId: task.id, level: 'warn', message: `[${mode}] 上一次同步仍在执行，本轮已跳过`, ts: new Date().toISOString() }, task.userId);
    return { status: 'skipped' };
  }

  const c1 = loadConfig();
  const idx1 = c1.syncTasks.findIndex((x) => x.id === task.id);
  if (idx1 === -1) return { status: 'missing' };
  c1.syncTasks[idx1].status = task._initializationMode === true ? 'queued' : 'running';
  await saveConfig(c1);

  if (task._initializationMode === true) {
    enqueueInitializationRun({
      task,
      srcConn,
      tgtConn,
      runControl,
      persistLog: (entry) => persistUserSyncLog(entry, task.userId),
      resetState: false,
      initializationMode: true,
      trigger,
      mode,
      intervalSec,
    });
    const queueMeta = buildInitializationQueueMeta(task.id);
    await persistUserSyncLog({ taskId: task.id, level: 'info', message: `[${mode}] 初始化任务已进入队列，当前位置 ${queueMeta.position || 1}，并发上限 ${INITIALIZATION_CONCURRENCY}`, ts: new Date().toISOString() }, task.userId);
    return { status: 'queued', initializationMode: true, queue: queueMeta };
  }

  try {
    const { runSyncWithControl } = await import('./services/syncEngine.js');
    const result = await runSyncWithControl(
      task,
      srcConn,
      tgtConn,
      (entry) => persistUserSyncLog(entry, task.userId),
      { ...runControl, initializationMode: task._initializationMode === true, trigger },
    );
    runControl.finish({ status: result?.status || 'success', phase: result?.status === 'skipped' ? 'skipped' : 'completed', cancellable: false });
    await finalizeTaskRun(task, result, { scheduled: true, intervalSec });
    if (result?.status === 'skipped') {
      await persistUserSyncLog({ taskId: task.id, level: 'warn', message: `[${mode}] 上一次同步仍在执行，本轮已跳过`, ts: new Date().toISOString() }, task.userId);
    } else {
      await persistUserSyncLog({ taskId: task.id, level: 'info', message: `[${mode}] 同步完成，下次同步: ${intervalSec}s 后`, ts: new Date().toISOString() }, task.userId);
    }
    return result || { status: 'success' };
  } catch (err) {
    runControl.finish({ status: err.code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed', phase: err.code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed', errorMessage: err.message, cancellable: false });
    await failTaskRun(task, err, { scheduled: true });
    await persistUserSyncLog({ taskId: task.id, level: 'error', message: `[${mode}] 同步失败: ${err.message}`, ts: new Date().toISOString() }, task.userId);
    return { status: 'failed', error: err.message };
  }
}

async function startTaskScheduler(taskId, actorUser, options = {}) {
  const { audit = true, runImmediately = true, resume = false } = options;
  const config = loadConfig();
  const taskIdx = config.syncTasks.findIndex((t) => t.id === taskId);
  if (taskIdx === -1) throw Object.assign(new Error('Not found'), { status: 404 });
  const task = config.syncTasks[taskIdx];
  if (!isAdmin(actorUser) && task.userId !== actorUser.id) {
    throw Object.assign(new Error('无权操作此任务'), { status: 403 });
  }

  const missingFields = getTaskStartMissingFields(task);
  if (missingFields.length > 0) {
    throw Object.assign(new Error(`缺少必要字段: ${missingFields.join(', ')}`), { status: 400 });
  }
  const validation = validateTaskRunnable(config, actorUser, task);
  if (validation.error) throw Object.assign(new Error(validation.error), { status: 400 });
  const preflight = await runTaskPreflightCheck(task, validation.srcConn, validation.tgtConn);
  const gateError = preflightError(preflight);
  if (gateError) throw gateError;

  if (syncScheduler.has(task.id)) {
    clearInterval(syncScheduler.get(task.id).intervalId);
    syncScheduler.delete(task.id);
  }

  const intervalSec = task.syncInterval || 300;
  const mode = task.syncMode || 'scheduled';
  if (!isAutoSyncMode(mode)) {
    throw Object.assign(new Error('手动任务不能启动自动同步，请改为定时或实时模式'), { status: 400 });
  }

  const cfg = loadConfig();
  const idx = cfg.syncTasks.findIndex((t) => t.id === task.id);
  if (idx === -1) throw Object.assign(new Error('Not found'), { status: 404 });
  cfg.syncTasks[idx].status = 'scheduled';
  cfg.syncTasks[idx].enabled = true;
  await saveConfig(cfg);

  const intervalId = setInterval(() => {
    runScheduledTask(task.id, mode, mode, intervalSec).catch((err) => {
      persistUserSyncLog({ taskId: task.id, level: 'error', message: `[${mode}] 调度失败: ${err.message}`, ts: new Date().toISOString() }, task.userId).catch(() => {});
    });
  }, intervalSec * 1000);
  syncScheduler.set(task.id, { intervalId, syncMode: mode, intervalSec });

  if (audit) {
    appendAuditLog(actorUser, resume ? 'task.resume' : 'task.start', {
      resourceType: 'task',
      resourceId: task.id,
      resourceName: task.name,
      message: `${resume ? '恢复' : '启动'}任务 ${task.name || task.id}`,
      metadata: { syncMode: mode, intervalSec },
    });
  }

  await persistUserSyncLog({ taskId: task.id, level: 'info', message: `已${resume ? '恢复' : '启动'}${mode === 'realtime' ? '准实时（高频轮询）' : '定时'}同步，间隔 ${intervalSec}s`, ts: new Date().toISOString() }, task.userId);

  if (runImmediately) {
    await runScheduledTask(task.id, resume ? 'resume' : 'initial', mode, intervalSec);
  }
  return { started: true, syncMode: mode, intervalSec };
}

async function resumeEnabledTasks() {
  if (process.env.AUTO_RESUME_TASKS !== 'true') {
    logger.info('自动恢复已关闭，设置 AUTO_RESUME_TASKS=true 可启用');
    return;
  }
  const config = loadConfig();
  const resumable = config.syncTasks.filter((task) => {
    return task.enabled && !task.deletedAt && ['scheduled', 'realtime', 'incremental'].includes(task.syncMode || 'scheduled');
  });
  const runImmediately = process.env.AUTO_RESUME_RUN_IMMEDIATELY === 'true';
  let restored = 0;
  for (const task of resumable) {
    try {
      await startTaskScheduler(task.id, { id: task.userId, role: 'user' }, { audit: false, resume: true, runImmediately });
      restored += 1;
    } catch (err) {
      logger.warn(`自动恢复失败: ${task.name || task.id}: ${err.message}`);
    }
  }
  logger.info(`自动恢复完成: ${restored}/${resumable.length} 个任务`);
}

let alertNotificationScanRunning = false;

async function scanAndSendAlertNotifications() {
  if (alertNotificationScanRunning) return;
  alertNotificationScanRunning = true;
  try {
    const config = loadConfig();
    const settings = normalizeAlertNotificationSettings(config.alertNotifications || {});
    if (!settings.enabled || !settings.webhookUrl) return;
    const systemUser = { id: 'system', email: 'system@local', role: 'super_admin' };
    const snapshot = buildObservabilityForUser(config, systemUser);
    const result = await sendAlertNotifications({ settings, snapshot, appUrl: getAppUrl() });
    if (!result.skipped) {
      const latest = loadConfig();
      latest.alertNotifications = result.settings;
      await saveConfig(latest, { backup: false });
    }
    if (result.sent > 0) {
      await persistSyncLog({
        level: 'info',
        message: `告警通知已发送 ${result.sent} 条`,
        ts: new Date().toISOString(),
      });
    }
  } catch (err) {
    const latest = loadConfig();
    latest.alertNotifications = {
      ...normalizeAlertNotificationSettings(latest.alertNotifications || {}),
      lastError: err.message,
    };
    await saveConfig(latest, { backup: false });
    logger.warn(`告警通知发送失败: ${err.message}`);
  } finally {
    alertNotificationScanRunning = false;
  }
}

function startAlertNotificationScanner() {
  setInterval(() => {
    scanAndSendAlertNotifications().catch((err) => logger.warn(`告警通知扫描失败: ${err.message}`));
  }, ALERT_NOTIFICATION_SCAN_INTERVAL_MS);
}

// --- Routes ---

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/system/doctor', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可执行系统检查' });
  try {
    appendAuditLog(req.user, 'system.doctor', {
      resourceType: 'system',
      message: '执行系统检查',
    });
    res.json(runSystemDoctor({ dataDir: DATA_DIR, configFile: CONFIG_FILE, config: loadConfig() }));
  } catch (err) {
    res.status(500).json({
      status: 'fail',
      checkedAt: new Date().toISOString(),
      summary: { pass: 0, warn: 0, fail: 1 },
      checks: [{ status: 'fail', title: '系统检查失败', message: err.message }],
    });
  }
});

app.get('/api/system/config-backups', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可查看配置备份' });
  res.json(getConfigBackups(CONFIG_FILE, req.query.limit));
});

app.get('/api/system/test-environment', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可查看测试环境' });
  res.json(buildTestEnvironmentPlan(loadConfig(), { keepRecentLogs: req.query.keepRecentLogs }));
});

app.post('/api/system/test-environment/cleanup', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可整理测试环境' });
  const config = loadConfig();
  const result = applyTestEnvironmentCleanup(config, { keepRecentLogs: req.body?.keepRecentLogs });
  syncScheduler.forEach((info, taskId) => {
    if (result.removable.tasks.some((task) => task.id === taskId)) {
      clearInterval(info.intervalId);
      syncScheduler.delete(taskId);
    }
  });
  for (const task of result.removable.tasks) {
    const run = syncRuns.get(task.id);
    if (run?.state?.status === 'queued') removeQueuedInitialization(task.id, '测试环境整理已取消临时初始化任务');
    else if (run?.controller) run.controller.abort();
    syncRuns.delete(task.id);
  }
  await saveConfig(config, { backup: true, backupReason: 'test-env-cleanup' });
  appendAuditLog(req.user, 'system.test_environment_cleanup', {
    resourceType: 'system',
    message: '整理测试环境',
    metadata: { removed: result.removed, baselineConnectionNames: result.baselineConnectionNames },
  });
  res.json(result);
});

app.post('/api/system/acceptance', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可执行一键验收' });
  try {
    const report = await buildAcceptanceReport(req.user, req.body || {});
    appendAuditLog(req.user, 'system.acceptance', {
      resourceType: 'system',
      message: `执行一键验收：${report.status}`,
      metadata: { status: report.status, summary: report.summary },
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/system/config-export', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可导出配置' });
  const includeSecrets = req.query.includeSecrets === 'true';
  if (includeSecrets && !isOwner(req.user)) {
    return res.status(403).json({ error: '仅系统所有者可导出含密钥迁移包' });
  }
  const includeLogs = req.query.includeLogs === 'true';
  const payload = buildConfigExport(loadConfig(), {
    includeSecrets,
    includeLogs,
    exportedBy: req.user.email || req.user.id,
  });
  appendAuditLog(req.user, 'system.config_export', {
    resourceType: 'system',
    message: `导出配置迁移包${includeSecrets ? '（含密钥）' : ''}`,
    metadata: { includeSecrets, includeLogs },
  });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="teable-sync-config-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(payload);
});

app.post('/api/system/config-import/preview', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可导入配置' });
  try {
    res.json(previewConfigImport(req.body, loadConfig()));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/system/config-import', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可导入配置' });
  try {
    const mode = req.query.mode === 'replace' ? 'replace' : 'merge';
    const includeLogs = req.query.includeLogs === 'true';
    const disableImportedTasks = req.query.disableImportedTasks !== 'false';
    const before = loadConfig();
    const { preview, config: nextConfig } = applyConfigImport(req.body, before, { mode, includeLogs, disableImportedTasks });
    createConfigBackup(CONFIG_FILE, `before-import-${mode}`);
    syncScheduler.forEach((info) => clearInterval(info.intervalId));
    syncScheduler.clear();
    syncRuns.clear();
    await saveConfig(nextConfig, { backup: true, backupReason: `import-${mode}` });
    appendAuditLog(req.user, 'system.config_import', {
      resourceType: 'system',
      message: `${mode === 'replace' ? '替换' : '合并'}导入配置迁移包`,
      metadata: { mode, includeLogs, disableImportedTasks, summary: preview.summary },
    });
    res.json({ success: true, mode, preview });
  } catch (err) {
    res.status(400).json({ error: err.message, preview: err.preview || null });
  }
});

app.get('/api/observability', async (req, res) => {
  const config = loadConfig();
  const snapshot = buildObservabilityForUser(config, req.user);
  pruneAlertStates(config, snapshot.alerts.map((item) => item.id));
  await saveConfig(config, { backup: false });
  res.json(snapshot);
});

app.post('/api/observability/alerts/:id/ack', async (req, res) => {
  const config = loadConfig();
  const snapshot = buildObservabilityForUser(config, req.user);
  const alert = snapshot.alerts.find((item) => item.id === req.params.id);
  if (!alert) return res.status(404).json({ error: '告警不存在或无权访问' });
  config.alertStates = config.alertStates || {};
  config.alertStates[alert.id] = {
    ...(config.alertStates[alert.id] || {}),
    acknowledgedAt: new Date().toISOString(),
    acknowledgedBy: req.user.id,
    mutedUntil: null,
    mutedBy: null,
    resolvedAt: null,
  };
  await saveConfig(config, { backup: false });
  appendAuditLog(req.user, 'alert.acknowledge', { resourceType: 'alert', resourceId: alert.id, message: `确认告警 ${alert.title}` });
  res.json({ success: true, alertId: alert.id });
});

app.post('/api/observability/alerts/:id/mute', async (req, res) => {
  const config = loadConfig();
  const snapshot = buildObservabilityForUser(config, req.user);
  const alert = snapshot.alerts.find((item) => item.id === req.params.id);
  if (!alert) return res.status(404).json({ error: '告警不存在或无权访问' });
  const minutes = clampInt(req.body?.minutes, 60, 5, 1440);
  config.alertStates = config.alertStates || {};
  config.alertStates[alert.id] = {
    ...(config.alertStates[alert.id] || {}),
    mutedUntil: new Date(Date.now() + minutes * 60000).toISOString(),
    mutedBy: req.user.id,
    acknowledgedAt: config.alertStates[alert.id]?.acknowledgedAt || new Date().toISOString(),
    acknowledgedBy: config.alertStates[alert.id]?.acknowledgedBy || req.user.id,
    resolvedAt: null,
  };
  await saveConfig(config, { backup: false });
  appendAuditLog(req.user, 'alert.mute', { resourceType: 'alert', resourceId: alert.id, message: `静默告警 ${alert.title}`, metadata: { minutes } });
  res.json({ success: true, alertId: alert.id, mutedUntil: config.alertStates[alert.id].mutedUntil });
});

app.post('/api/observability/alerts/:id/restore', async (req, res) => {
  const config = loadConfig();
  const snapshot = buildObservabilityForUser(config, req.user);
  const alert = snapshot.alerts.find((item) => item.id === req.params.id) || { id: req.params.id, title: req.params.id };
  if (!config.alertStates?.[req.params.id]) return res.json({ success: true, alertId: req.params.id });
  delete config.alertStates[req.params.id];
  await saveConfig(config, { backup: false });
  appendAuditLog(req.user, 'alert.restore', { resourceType: 'alert', resourceId: alert.id, message: `恢复告警 ${alert.title}` });
  res.json({ success: true, alertId: alert.id });
});

app.get('/api/alert-notifications', (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可配置告警通知' });
  const config = loadConfig();
  res.json(sanitizeAlertNotificationSettings(config.alertNotifications || {}));
});

app.put('/api/alert-notifications', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可配置告警通知' });
  try {
    const config = loadConfig();
    config.alertNotifications = cleanAlertNotificationInput(req.body, config.alertNotifications || {});
    await saveConfig(config, { backup: false });
    appendAuditLog(req.user, 'alert_notification.update', {
      resourceType: 'system',
      message: `更新告警通知配置${config.alertNotifications.enabled ? '（已启用）' : '（已关闭）'}`,
      metadata: {
        enabled: config.alertNotifications.enabled,
        minSeverity: config.alertNotifications.minSeverity,
        cooldownMinutes: config.alertNotifications.cooldownMinutes,
        hasWebhookUrl: Boolean(config.alertNotifications.webhookUrl),
      },
    });
    res.json(sanitizeAlertNotificationSettings(config.alertNotifications));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/alert-notifications/test', async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: '仅管理员可测试告警通知' });
  const config = loadConfig();
  try {
    const result = await sendTestAlertNotification({ settings: config.alertNotifications || {}, appUrl: getAppUrl() });
    config.alertNotifications = result.settings;
    await saveConfig(config, { backup: false });
    appendAuditLog(req.user, 'alert_notification.test', {
      resourceType: 'system',
      message: '发送测试告警通知',
      metadata: { status: result.result?.status || null },
    });
    res.json({ success: true, settings: sanitizeAlertNotificationSettings(config.alertNotifications) });
  } catch (err) {
    config.alertNotifications = {
      ...normalizeAlertNotificationSettings(config.alertNotifications || {}),
      lastError: err.message,
    };
    await saveConfig(config, { backup: false });
    res.status(400).json({ error: err.message, settings: sanitizeAlertNotificationSettings(config.alertNotifications) });
  }
});

app.get('/api/audit-logs', (req, res) => {
  res.json(getAuditLogs({
    user: req.user,
    limit: req.query.limit,
    action: req.query.action,
    resourceType: req.query.resourceType,
  }));
});

// Connections CRUD (multi-tenant: owner can see/edit + shared connections)
app.get('/api/connections', (req, res) => {
  const config = loadConfig();
  const { role, id: userId } = req.user;
  const includeDeleted = req.query.includeDeleted === 'true';
  const visible = config.connections.filter((c) => {
    if (!includeDeleted && c.deletedAt) return false;
    return isAdmin({ role }) || c.ownerId === userId || c.shared === true;
  });
  res.json(visible.map(sanitizeConnection));
});

app.post('/api/connections', (req, res) => {
  const config = loadConfig();
  const body = cleanConnectionInput(req.body);
  const conn = {
    ...body,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ownerId: req.user.id,
    shared: body.shared === true, // 默认为私有
  };
  config.connections.push(conn);
  saveConfig(config);
  appendAuditLog(req.user, 'connection.create', {
    resourceType: 'connection',
    resourceId: conn.id,
    resourceName: conn.name,
    message: `创建连接 ${conn.name || conn.id}`,
    metadata: { type: conn.type, shared: conn.shared === true },
  });
  res.json(sanitizeConnection(conn));
});

app.put('/api/connections/:id', (req, res) => {
  const config = loadConfig();
  const idx = config.connections.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const conn = config.connections[idx];
  if (conn.deletedAt) return res.status(400).json({ error: '该连接已删除，请先恢复' });
  if (!isAdmin(req.user) && conn.ownerId !== req.user.id) {
    return res.status(403).json({ error: '无权编辑此连接' });
  }
  const updates = cleanConnectionInput(req.body);
  config.connections[idx] = { ...conn, ...updates, id: conn.id, ownerId: conn.ownerId, createdAt: conn.createdAt };
  saveConfig(config);
  appendAuditLog(req.user, 'connection.update', {
    resourceType: 'connection',
    resourceId: conn.id,
    resourceName: config.connections[idx].name,
    message: `更新连接 ${config.connections[idx].name || conn.id}`,
    metadata: { fields: Object.keys(updates).filter((field) => !CONNECTION_SECRET_FIELDS.includes(field)) },
  });
  res.json(sanitizeConnection(config.connections[idx]));
});

app.delete('/api/connections/:id', (req, res) => {
  const config = loadConfig();
  const conn = config.connections.find((c) => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && conn.ownerId !== req.user.id) {
    return res.status(403).json({ error: '无权删除此连接' });
  }
  // 软删除：标记 deletedAt，不物理删除
  conn.deletedAt = new Date().toISOString();
  saveConfig(config);
  appendAuditLog(req.user, 'connection.delete', {
    resourceType: 'connection',
    resourceId: conn.id,
    resourceName: conn.name,
    message: `删除连接 ${conn.name || conn.id}`,
  });
  res.json({ ok: true });
});

// PUT /api/connections/:id/share — 切换共享状态（仅 owner 或 super_admin）
app.put('/api/connections/:id/share', (req, res) => {
  const config = loadConfig();
  const idx = config.connections.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const conn = config.connections[idx];
  if (!isAdmin(req.user) && conn.ownerId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此连接' });
  }
  const { shared } = req.body;
  if (typeof shared !== 'boolean') {
    return res.status(400).json({ error: 'shared 必须是 boolean' });
  }
  config.connections[idx].shared = shared;
  saveConfig(config);
  appendAuditLog(req.user, 'connection.share', {
    resourceType: 'connection',
    resourceId: conn.id,
    resourceName: conn.name,
    message: `${shared ? '共享' : '取消共享'}连接 ${conn.name || conn.id}`,
    metadata: { shared },
  });
  res.json(sanitizeConnection(config.connections[idx]));
});

// POST /api/connections/:id/restore — 恢复已删除的连接（仅 owner 或 super_admin）
app.post('/api/connections/:id/restore', (req, res) => {
  const config = loadConfig();
  const idx = config.connections.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const conn = config.connections[idx];
  if (!isAdmin(req.user) && conn.ownerId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此连接' });
  }
  if (!conn.deletedAt) return res.status(400).json({ error: '该连接未被删除' });
  delete config.connections[idx].deletedAt;
  saveConfig(config);
  appendAuditLog(req.user, 'connection.restore', {
    resourceType: 'connection',
    resourceId: conn.id,
    resourceName: conn.name,
    message: `恢复连接 ${conn.name || conn.id}`,
  });
  res.json(sanitizeConnection(config.connections[idx]));
});

// Test connection (supports both SQL databases and Teable)
app.post('/api/connections/:id/test', async (req, res) => {
  const config = loadConfig();
  const conn = config.connections.find((c) => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (!canReadConnection(req.user, conn)) return res.status(403).json({ error: '无权访问此连接' });

  try {
    let result;
    if (conn.type === 'teable') {
      const { getTeableSpaces } = await import('./services/teableService.js');
      const spaces = await getTeableSpaces(conn);
      result = { success: true, type: 'teable', spaces: spaces.length, message: `连接成功，共 ${spaces.length} 个空间` };
    } else {
      const { testConnection } = await import('./services/dbService.js');
      const testResult = await testConnection(conn);
      result = { success: true, type: conn.type, ...testResult };
    }
    await recordConnectionTest(config, conn.id, { ...result, testedBy: req.user.id });
    res.json(result);
  } catch (err) {
    const result = { success: false, type: conn.type, error: err.message };
    await recordConnectionTest(config, conn.id, { ...result, testedBy: req.user.id });
    res.json(result);
  }
});

// Fetch tables from a SQL or Teable connection (with source columns)
app.get('/api/connections/:id/tables', async (req, res) => {
  const config = loadConfig();
  const conn = config.connections.find((c) => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (!canReadConnection(req.user, conn)) return res.status(403).json({ error: '无权访问此连接' });

  try {
    if (conn.type === 'teable') {
      const { getTeableBases, getTeableTables, getTeableFields, teableFieldToSourceColumn } = await import('./services/teableService.js');
      const bases = await getTeableBases(conn);
      const tablesWithSchema = [];
      for (const base of bases) {
        let tables = [];
        try {
          tables = await getTeableTables(conn, base.id);
        } catch {
          tables = [];
        }
        for (const table of tables) {
          try {
            const fields = await getTeableFields(conn, table.id);
            tablesWithSchema.push({
              ...table,
              name: table.id,
              displayName: table.name,
              baseId: base.id,
              baseName: base.name,
              type: 'TEABLE_TABLE',
              columns: fields.map(teableFieldToSourceColumn),
            });
          } catch {
            tablesWithSchema.push({ ...table, name: table.id, displayName: table.name, baseId: base.id, baseName: base.name, type: 'TEABLE_TABLE', columns: [] });
          }
        }
      }
      return res.json(tablesWithSchema);
    }

    const { getTables, getTableSchema } = await import('./services/dbService.js');
    const database = req.query.database || null;
    const tables = await getTables(conn, database);
    const tablesWithSchema = [];
    for (const t of tables) {
      try {
        const schema = await getTableSchema(conn, t.name, database);
        tablesWithSchema.push({ ...t, columns: schema });
      } catch (e) {
        tablesWithSchema.push({ ...t, columns: [] });
      }
    }
    res.json(tablesWithSchema);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Smart field mapping suggestions
app.get('/api/mapping-suggestions', async (req, res) => {
  const config = loadConfig();
  const { sourceConnectionId, sourceTable, targetTableId, sourceDatabase } = req.query;
  if (!sourceConnectionId || !sourceTable || !targetTableId) {
    return res.status(400).json({ error: 'sourceConnectionId, sourceTable, targetTableId required' });
  }

  // targetConnectionId is for the Teable connection, targetTableId is the table
  const srcConn = config.connections.find((c) => c.id === sourceConnectionId);
  const tgtConn2 = config.connections.find((c) => c.id === req.query.targetConnectionId);
  if (!srcConn) return res.status(404).json({ error: 'Source connection not found' });
  if (!tgtConn2) return res.status(404).json({ error: 'Target connection not found' });
  if (!canReadConnection(req.user, srcConn)) return res.status(403).json({ error: '无权访问源连接' });
  if (!canReadConnection(req.user, tgtConn2)) return res.status(403).json({ error: '无权访问目标连接' });

  try {
    const { getTableSchema } = await import('./services/dbService.js');
    const { getTeableFields, teableFieldToSourceColumn } = await import('./services/teableService.js');
    const { suggestMappings } = await import('./services/mappingSuggester.js');

    const sourceColumns = srcConn.type === 'teable'
      ? (await getTeableFields(srcConn, sourceTable)).map((field) => ({ ...teableFieldToSourceColumn(field), type: 'teable:' + field.type }))
      : await getTableSchema(srcConn, sourceTable, sourceDatabase || null);
    const targetFields = await getTeableFields(tgtConn2, targetTableId);

    // Normalize Teable field types for compatibility checking
    // Teable uses: singleLineText, longText, number, date, checkbox, attachment, singleSelect, etc.
    const normalizedTargetFields = targetFields.map(f => ({ name: f.name, type: f.type }));

    const result = suggestMappings(sourceColumns, normalizedTargetFields);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detect watermark candidates for a source table
app.get('/api/connections/:id/watermark-candidates', async (req, res) => {
  const config = loadConfig();
  const conn = config.connections.find((c) => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (!canReadConnection(req.user, conn)) return res.status(403).json({ error: '无权访问此连接' });

  const { table, database } = req.query;
  if (!table) return res.status(400).json({ error: 'table query param required' });

  try {
    const { detectWatermarkCandidates } = await import('./services/syncEngine.js');
    const result = await detectWatermarkCandidates(conn, table, database || null);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Teable: list spaces
app.get('/api/teable/spaces', async (req, res) => {
  try {
    const { getTeableSpaces } = await import('./services/teableService.js');
    const config = loadConfig();
    const conn = req.query.connectionId
      ? config.connections.find((c) => c.id === req.query.connectionId)
      : config.connections.find((c) => c.type === 'teable');
    if (!conn) return res.status(400).json({ error: 'No Teable connection found' });
    if (!canReadConnection(req.user, conn)) return res.status(403).json({ error: '无权访问此连接' });
    const spaces = await getTeableSpaces(conn);
    res.json(spaces);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Teable: list bases (optionally filtered by space)
app.get('/api/teable/bases', async (req, res) => {
  try {
    const { getTeableBases, getTeableBasesBySpace, getTeableTables } = await import('./services/teableService.js');
    const config = loadConfig();
    const conn = req.query.connectionId
      ? config.connections.find((c) => c.id === req.query.connectionId)
      : config.connections.find((c) => c.type === 'teable');
    if (!conn) return res.status(400).json({ error: 'No Teable connection found' });
    if (!canReadConnection(req.user, conn)) return res.status(403).json({ error: '无权访问此连接' });

    let bases;
    if (req.query.spaceId) {
      bases = await getTeableBasesBySpace(conn, req.query.spaceId);
    } else {
      bases = await getTeableBases(conn);
    }

    // Fetch tables for each base (limit to avoid slow response)
    if (bases.length <= 30) {
      for (const base of bases) {
        try {
          base.tables = await getTeableTables(conn, base.id);
        } catch (e) {
          base.tables = [];
        }
      }
    }
    res.json(bases);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Teable: list tables in a base
app.get('/api/teable/bases/:baseId/tables', async (req, res) => {
  try {
    const { getTeableTables } = await import('./services/teableService.js');
    const config = loadConfig();
    const conn = req.query.connectionId
      ? config.connections.find((c) => c.id === req.query.connectionId)
      : config.connections.find((c) => c.type === 'teable');
    if (!conn) return res.status(400).json({ error: 'No Teable connection found' });
    if (!canReadConnection(req.user, conn)) return res.status(403).json({ error: '无权访问此连接' });
    const tables = await getTeableTables(conn, req.params.baseId);
    res.json(tables);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Teable: list fields in a table
app.get('/api/teable/tables/:tableId/fields', async (req, res) => {
  try {
    const { getTeableFields } = await import('./services/teableService.js');
    const config = loadConfig();
    const conn = req.query.connectionId
      ? config.connections.find((c) => c.id === req.query.connectionId)
      : config.connections.find((c) => c.type === 'teable');
    if (!conn) return res.status(400).json({ error: 'No Teable connection found' });
    if (!canReadConnection(req.user, conn)) return res.status(403).json({ error: '无权访问此连接' });
    const fields = await getTeableFields(conn, req.params.tableId);
    res.json(fields);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Teable: test connection with arbitrary host+token (not saved yet)
app.post('/api/teable/test', async (req, res) => {
  try {
    const { getTeableSpaces } = await import('./services/teableService.js');
    const { host, token } = req.body;
    if (!host || !token) return res.status(400).json({ error: 'host and token required' });
    const conn = { type: 'teable', host, token };
    const spaces = await getTeableSpaces(conn);
    res.json({ success: true, spaces: spaces.length, message: `连接成功，共 ${spaces.length} 个空间` });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Sync Tasks CRUD
app.get('/api/tasks', (req, res) => {
  const config = loadConfig();
  const { role, id: userId } = req.user;
  const includeDeleted = req.query.includeDeleted === 'true';
  const visible = config.syncTasks.filter((t) => {
    if (!includeDeleted && t.deletedAt) return false;
    return isAdmin({ role }) || t.userId === userId;
  });
  res.json(visible.map((task) => taskDto(config, req.user, task)));
});

app.post('/api/tasks', async (req, res) => {
  const config = loadConfig();
  const validation = validateTaskConnections(config, req.user, req.body, { requireTested: true });
  if (validation.error) return res.status(400).json({ error: validation.error });
  const body = cleanTaskInput(req.body);
  const task = {
    ...body,
    id: crypto.randomUUID(),
    syncMode: body.syncMode || 'manual',
    syncDirection: body.syncDirection || 'one_way',
    conflictStrategy: body.conflictStrategy || 'upsert',
    enabled: false,
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
    status: 'idle',
    userId: req.user.id, // 任务归属当前用户
  };
  await attachSchemaSnapshot(task, validation.srcConn, validation.tgtConn);
  config.syncTasks.push(task);
  saveConfig(config);
  appendAuditLog(req.user, 'task.create', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: task.name,
    message: `创建任务 ${task.name || task.id}`,
    metadata: { syncMode: task.syncMode, sourceTable: task.sourceTable, targetTableId: task.targetTableId },
  });
  res.json(taskDto(config, req.user, task));
});

app.post('/api/tasks/:id/copy', async (req, res) => {
  const config = loadConfig();
  const source = config.syncTasks.find((t) => t.id === req.params.id);
  if (!source || source.deletedAt) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && source.userId !== req.user.id) {
    return res.status(403).json({ error: '无权复制此任务' });
  }
  const overrides = cleanTaskInput(req.body || {});
  const task = buildCopiedTask(source, {
    ...overrides,
    name: overrides.name || `${source.name || '同步任务'} 副本`,
  });
  task.userId = req.user.id;
  const validation = validateTaskConnections(config, req.user, task, { requireTested: true });
  if (validation.error) return res.status(400).json({ error: validation.error });
  await attachSchemaSnapshot(task, validation.srcConn, validation.tgtConn);
  config.syncTasks.push(task);
  saveConfig(config);
  appendAuditLog(req.user, 'task.copy', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: task.name,
    message: `复制任务 ${source.name || source.id} → ${task.name}`,
    metadata: { sourceTaskId: source.id },
  });
  res.json(taskDto(config, req.user, task));
});

app.get('/api/task-templates', (req, res) => {
  const config = loadConfig();
  const templates = (config.taskTemplates || []).filter((template) => canUseTemplate(req.user, template));
  res.json(templates);
});

app.post('/api/task-templates', (req, res) => {
  const config = loadConfig();
  const sourceTaskId = req.body?.sourceTaskId;
  const source = sourceTaskId ? config.syncTasks.find((t) => t.id === sourceTaskId) : null;
  if (sourceTaskId) {
    if (!source || source.deletedAt) return res.status(404).json({ error: '源任务不存在' });
    if (!isAdmin(req.user) && source.userId !== req.user.id) return res.status(403).json({ error: '无权保存此任务为模板' });
  }
  const rawConfig = source ? taskConfigSnapshot(source) : cleanTaskInput(req.body?.config || req.body || {});
  const template = {
    id: crypto.randomUUID(),
    name: (req.body?.name || rawConfig.name || '同步任务模板').trim(),
    description: (req.body?.description || '').trim(),
    shared: isAdmin(req.user) && req.body?.shared === true,
    config: {
      ...rawConfig,
      name: rawConfig.name || req.body?.name || '同步任务',
      syncMode: rawConfig.syncMode || 'manual',
      syncDirection: rawConfig.syncDirection || 'one_way',
      conflictStrategy: rawConfig.conflictStrategy || 'upsert',
    },
    userId: req.user.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  config.taskTemplates = config.taskTemplates || [];
  config.taskTemplates.push(template);
  saveConfig(config);
  appendAuditLog(req.user, 'task_template.create', {
    resourceType: 'task_template',
    resourceId: template.id,
    resourceName: template.name,
    message: `创建任务模板 ${template.name}`,
    metadata: { sourceTaskId: sourceTaskId || null },
  });
  res.json(template);
});

app.post('/api/task-templates/:id/create-task', async (req, res) => {
  const config = loadConfig();
  const template = (config.taskTemplates || []).find((item) => item.id === req.params.id);
  if (!canUseTemplate(req.user, template)) return res.status(404).json({ error: '模板不存在或无权使用' });
  const overrides = cleanTaskInput(req.body || {});
  const task = buildCopiedTask({ ...template.config, userId: req.user.id }, {
    ...overrides,
    name: overrides.name || `${template.config?.name || template.name} 副本`,
  });
  task.userId = req.user.id;
  const validation = validateTaskConnections(config, req.user, task, { requireTested: true });
  if (validation.error) return res.status(400).json({ error: validation.error });
  await attachSchemaSnapshot(task, validation.srcConn, validation.tgtConn);
  config.syncTasks.push(task);
  saveConfig(config);
  appendAuditLog(req.user, 'task_template.create_task', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: task.name,
    message: `从模板 ${template.name} 创建任务 ${task.name}`,
    metadata: { templateId: template.id },
  });
  res.json(taskDto(config, req.user, task));
});

app.delete('/api/task-templates/:id', (req, res) => {
  const config = loadConfig();
  const template = (config.taskTemplates || []).find((item) => item.id === req.params.id);
  if (!template || template.deletedAt) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && template.userId !== req.user.id) return res.status(403).json({ error: '无权删除此模板' });
  template.deletedAt = new Date().toISOString();
  template.updatedAt = template.deletedAt;
  saveConfig(config);
  appendAuditLog(req.user, 'task_template.delete', {
    resourceType: 'task_template',
    resourceId: template.id,
    resourceName: template.name,
    message: `删除任务模板 ${template.name}`,
  });
  res.json({ success: true });
});

app.put('/api/tasks/:id', async (req, res) => {
  const config = loadConfig();
  const idx = config.syncTasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const task = config.syncTasks[idx];
  if (task.deletedAt) return res.status(400).json({ error: '该任务已删除，请先恢复' });
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权编辑此任务' });
  }
  const updates = cleanTaskInput(req.body);
  const nextTask = { ...task, ...updates, id: task.id, userId: task.userId, createdAt: task.createdAt };
  const configChanged = ['sourceConnectionId', 'sourceId', 'sourceTable', 'sourceDatabase', 'sourceBaseId', 'targetConnectionId', 'targetId', 'targetBaseId', 'targetTableId', 'columnMapping'].some((field) => Object.prototype.hasOwnProperty.call(updates, field));
  const validation = validateTaskConnections(config, req.user, nextTask, { requireTested: configChanged });
  if (validation.error) return res.status(400).json({ error: validation.error });
  if (configChanged) await attachSchemaSnapshot(nextTask, validation.srcConn, validation.tgtConn);
  if (!isAutoSyncMode(nextTask.syncMode)) {
    if (syncScheduler.has(task.id)) {
      clearInterval(syncScheduler.get(task.id).intervalId);
      syncScheduler.delete(task.id);
    }
    nextTask.enabled = false;
    nextTask.status = 'idle';
  }
  config.syncTasks[idx] = nextTask;
  saveConfig(config);
  appendAuditLog(req.user, 'task.update', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: nextTask.name,
    message: `更新任务 ${nextTask.name || task.id}`,
    metadata: { fields: Object.keys(updates) },
  });
  res.json(taskDto(config, req.user, config.syncTasks[idx]));
});

app.delete('/api/tasks/:id', (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权删除此任务' });
  }
  if (syncScheduler.has(req.params.id)) {
    clearInterval(syncScheduler.get(req.params.id).intervalId);
    syncScheduler.delete(req.params.id);
  }
  // 软删除：标记 deletedAt，不物理删除
  task.deletedAt = new Date().toISOString();
  saveConfig(config);
  appendAuditLog(req.user, 'task.delete', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: task.name,
    message: `删除任务 ${task.name || task.id}`,
  });
  res.json({ ok: true });
});

// POST /api/tasks/:id/restore — 恢复已删除的任务
app.post('/api/tasks/:id/restore', (req, res) => {
  const config = loadConfig();
  const idx = config.syncTasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const task = config.syncTasks[idx];
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此任务' });
  }
  if (!task.deletedAt) return res.status(400).json({ error: '该任务未被删除' });
  delete config.syncTasks[idx].deletedAt;
  saveConfig(config);
  appendAuditLog(req.user, 'task.restore', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: task.name,
    message: `恢复任务 ${task.name || task.id}`,
  });
  res.json(taskDto(config, req.user, config.syncTasks[idx]));
});

// Preview source data before sync
app.get('/api/tasks/:id/preview', async (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问此任务' });
  }
  
  const limit = Math.min(parseInt(req.query.limit) || 10, 100); // max 100 rows
  
  try {
    const { getTableSchema, query } = await import('./services/dbService.js');
    const { getTeableFields, getTeableRecords, normalizeTeableRecordsResponse, teableFieldToSourceColumn } = await import('./services/teableService.js');
    
    // Find source connection
    const srcConn = config.connections.find((c) => c.id === (task.sourceConnectionId || task.sourceId));
    if (!srcConn) return res.status(400).json({ error: '源连接不存在' });
    const validation = validateTaskRunnable(config, req.user, task, { requireTarget: false });
    if (validation.error) return res.status(400).json({ error: validation.error });
    
    if (srcConn.type === 'teable') {
      const columns = (await getTeableFields(srcConn, task.sourceTable)).map(teableFieldToSourceColumn);
      const result = await getTeableRecords(srcConn, task.sourceTable, { skip: 0, take: limit });
      const rows = normalizeTeableRecordsResponse(result).map((rec) => rec.fields || rec);
      return res.json({
        columns: columns.map(c => ({ name: c.name, type: c.type })),
        rows,
        totalPreviewed: rows.length,
        limit,
      });
    }

    // Normalize db name
    const db = task.sourceDatabase || null;
    
    // Get table schema
    const columns = await getTableSchema(srcConn, task.sourceTable, db);
    
    // Build SELECT query with LIMIT
    const tableName = quoteSqlIdentifier(srcConn.type, task.sourceTable);
    const colNames = columns.map(c => quoteSqlIdentifier(srcConn.type, c.name)).join(', ');
    let querySql;
    let params = [];
    
    if (srcConn.type === 'mssql') {
      const fullTableName = db
        ? `${quoteSqlIdentifier(srcConn.type, db)}.dbo.${tableName}`
        : tableName;
      querySql = `SELECT TOP (${sqlPlaceholder(srcConn.type, 0)}) ${colNames} FROM ${fullTableName}`;
      params = [limit];
    } else if (srcConn.type === 'mysql') {
      const fullTableName = db
        ? `${quoteSqlIdentifier(srcConn.type, db)}.${tableName}`
        : tableName;
      querySql = `SELECT ${colNames} FROM ${fullTableName} LIMIT ${sqlPlaceholder(srcConn.type, 0)}`;
      params = [limit];
    } else if (srcConn.type === 'pg') {
      querySql = `SELECT ${colNames} FROM ${tableName} LIMIT ${sqlPlaceholder(srcConn.type, 0)}`;
      params = [limit];
    } else {
      return res.status(400).json({ error: '不支持的数据库类型' });
    }
    
    const rows = await query(srcConn, querySql, params, db);
    
    // Normalize values for JSON safety (Date→ISO, Buffer→null)
    const safeRows = rows.map(row => {
      const safe = {};
      for (const [key, val] of Object.entries(row)) {
        if (val instanceof Date) safe[key] = val.toISOString();
        else if (Buffer.isBuffer(val)) safe[key] = null;
        else safe[key] = val;
      }
      return safe;
    });
    
    res.json({
      columns: columns.map(c => ({ name: c.name, type: c.type })),
      rows: safeRows,
      totalPreviewed: safeRows.length,
      limit,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start auto-sync for a task (scheduled / realtime)
app.post('/api/tasks/:id/start', async (req, res) => {
  try {
    res.json(await startTaskScheduler(req.params.id, req.user, { audit: true, runImmediately: true }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Stop auto-sync for a task
app.post('/api/tasks/:id/stop', async (req, res) => {
  const config = loadConfig();
  const taskIdx = config.syncTasks.findIndex((t) => t.id === req.params.id);
  if (taskIdx === -1) return res.status(404).json({ error: 'Not found' });
  const task = config.syncTasks[taskIdx];
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此任务' });
  }

  if (syncScheduler.has(req.params.id)) {
    clearInterval(syncScheduler.get(req.params.id).intervalId);
    syncScheduler.delete(req.params.id);
  }
  const run = syncRuns.get(req.params.id);
  if (run?.state.status === 'queued') {
    removeQueuedInitialization(req.params.id, '停止任务时已取消排队中的初始化');
  } else if (run?.state.status === 'running') {
    run.controller.abort();
    run.state = { ...run.state, status: 'cancelling', phase: 'cancelling', updatedAt: new Date().toISOString() };
    syncRuns.set(req.params.id, run);
  }

  config.syncTasks[taskIdx].status = 'idle';
  config.syncTasks[taskIdx].enabled = false;
  await saveConfig(config);

  broadcastLogUser({ taskId: req.params.id, level: 'info', message: '已停止自动同步', ts: new Date().toISOString() }, task.userId);
  appendAuditLog(req.user, 'task.stop', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: task.name,
    message: `停止任务 ${task.name || task.id}`,
  });
  res.json({ stopped: true });
});

app.get('/api/tasks/:id/progress', (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问此任务' });
  }
  res.json(getRunState(req.params.id));
});

app.get('/api/tasks/:id/initialization', (req, res) => {
  try {
    const config = loadConfig();
    const task = config.syncTasks.find((t) => t.id === req.params.id);
    assertTaskAccess(req.user, task);
    res.json({
      ...getTaskInitializationState(req.params.id),
      runState: getRunState(req.params.id),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/cancel', (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此任务' });
  }
  const run = syncRuns.get(req.params.id);
  if (!run || !['running', 'queued', 'cancelling'].includes(run.state.status)) {
    return res.status(409).json({ error: '当前没有正在执行的同步' });
  }
  if (run.state.status === 'queued') {
    run.controller.abort();
    removeQueuedInitialization(req.params.id, '已取消排队中的初始化');
    const cfg = loadConfig();
    const idx = cfg.syncTasks.findIndex((x) => x.id === req.params.id);
    if (idx !== -1) cfg.syncTasks[idx].status = syncScheduler.has(req.params.id) ? 'scheduled' : 'idle';
    saveConfig(cfg, { backup: false });
    broadcastLogUser({ taskId: req.params.id, level: 'warn', message: '已取消排队中的初始化任务', ts: new Date().toISOString() }, task.userId);
    return res.json({ cancelling: false, cancelled: true, queued: true });
  }
  run.controller.abort();
  run.state = { ...run.state, status: 'cancelling', phase: 'cancelling', updatedAt: new Date().toISOString() };
  syncRuns.set(req.params.id, run);
  broadcastLogUser({ taskId: req.params.id, level: 'warn', message: '已请求取消正在执行的同步', ts: new Date().toISOString() }, task.userId);
  appendAuditLog(req.user, 'task.cancel', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: task.name,
    message: `取消任务 ${task.name || task.id}`,
  });
  res.json({ cancelling: true });
});

app.get('/api/tasks/:id/failures', (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问此任务' });
  }
  res.json(getSyncFailures(req.params.id).map(sanitizeFailureForApi));
});

app.get('/api/sync-failures/counts', (req, res) => {
  const config = loadConfig();
  const counts = getSyncFailureCounts();
  if (isAdmin(req.user)) return res.json(counts);
  const allowedTaskIds = new Set(config.syncTasks.filter((t) => t.userId === req.user.id).map((t) => t.id));
  const filtered = {};
  for (const [taskId, count] of Object.entries(counts)) {
    if (allowedTaskIds.has(taskId)) filtered[taskId] = count;
  }
  res.json(filtered);
});

app.delete('/api/tasks/:id/failures', (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此任务' });
  }
  const removed = clearSyncFailures(req.params.id);
  appendAuditLog(req.user, 'task.failures.clear', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: task.name,
    message: `清除任务失败记录 ${task.name || task.id}`,
    metadata: { removed },
  });
  res.json({ removed });
});

async function retryFailureBatchForTask(config, user, task, failure) {
  assertTaskAccess(user, task, '操作');
  if (!failure || failure.taskId !== task.id) {
    const err = new Error('失败批次不存在');
    err.status = 404;
    throw err;
  }
  const validation = validateTaskRunnable(config, user, task);
  if (validation.error) {
    const err = new Error(validation.error);
    err.status = 400;
    throw err;
  }
  const tgtConn = validation.tgtConn || config.connections.find((c) => c.id === (task.targetConnectionId || task.targetId));
  if (!tgtConn) {
    const err = new Error('Target connection not found');
    err.status = 400;
    throw err;
  }
  if (!failure.hasPayload && !failure.records && !failure.recordIds) {
    const err = new Error('失败批次缺少可重放载荷，只能清理记录后重新运行任务');
    err.status = 400;
    throw err;
  }
  return replayFailureBatch(tgtConn, task, failure);
}

app.post('/api/tasks/:id/failures/:failureId/retry', async (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  const failure = getSyncFailure(req.params.failureId);
  try {
    const stats = await retryFailureBatchForTask(config, req.user, task, failure);
    removeSyncFailures([failure.id]);
    appendAuditLog(req.user, 'task.failures.retry_one', {
      resourceType: 'task',
      resourceId: task.id,
      resourceName: task.name,
      message: `重试单个失败批次 ${task.name || task.id}`,
      metadata: { failureId: failure.id, ...stats },
    });
    res.json({ retried: 1, failed: 0, failureId: failure.id, ...stats });
  } catch (err) {
    if (failure?.id) markSyncFailureRetried(failure.id, err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/retry-failures', async (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此任务' });
  }
  const validation = validateTaskRunnable(config, req.user, task);
  if (validation.error) return res.status(400).json({ error: validation.error });

  const failures = getSyncFailures(req.params.id);
  const retried = [];
  const stillFailed = [];
  const replayStats = { inserted: 0, updated: 0, deleted: 0 };
  for (const failure of failures) {
    try {
      const stats = await retryFailureBatchForTask(config, req.user, task, failure);
      replayStats.inserted += stats.inserted || 0;
      replayStats.updated += stats.updated || 0;
      replayStats.deleted += stats.deleted || 0;
      retried.push(failure.id);
    } catch (err) {
      markSyncFailureRetried(failure.id, err);
      stillFailed.push({ id: failure.id, error: err.message });
    }
  }
  if (retried.length > 0) removeSyncFailures(retried);
  appendAuditLog(req.user, 'task.failures.retry', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: task.name,
    message: `重试任务失败记录 ${task.name || task.id}`,
    metadata: { retried: retried.length, failed: stillFailed.length, ...replayStats },
  });
  res.json({ retried: retried.length, failed: stillFailed.length, errors: stillFailed, ...replayStats });
});

app.get('/api/tasks/:id/health', (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问此任务' });
  }
  res.json(getTaskHealth(task));
});

app.get('/api/tasks-health', (req, res) => {
  const config = loadConfig();
  const { role, id: userId } = req.user;
  const tasks = config.syncTasks.filter((task) => {
    if (task.deletedAt) return false;
    return isAdmin({ role }) || task.userId === userId;
  });
  res.json(getTaskHealthMap(tasks));
});

app.post('/api/tasks/:id/reconcile', async (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问此任务' });
  }
  const validation = validateTaskRunnable(config, req.user, task);
  if (validation.error) return res.status(400).json({ error: validation.error });
  const srcConn = config.connections.find((c) => c.id === (task.sourceConnectionId || task.sourceId));
  const tgtConn = config.connections.find((c) => c.id === (task.targetConnectionId || task.targetId));
  if (!srcConn || !tgtConn) return res.status(400).json({ error: 'Connection not found' });
  try {
    const result = await reconcileTask(task, srcConn, tgtConn, req.body || {});
    appendAuditLog(req.user, 'task.reconcile', {
      resourceType: 'task',
      resourceId: task.id,
      resourceName: task.name,
      message: `校验任务 ${task.name || task.id}`,
      metadata: {
        missingInTarget: result.missingInTarget,
        extraInTarget: result.extraInTarget,
        mismatched: result.mismatched,
        limited: result.limited,
      },
    });
    res.json(result);
  } catch (err) {
    logger.error(`Reconcile task ${task.id} failed:`, err);
    const message = err?.message || '一致性校验失败';
    const status = /connect|timeout|ECONN|ENOTFOUND|EAI_AGAIN|Teable API/i.test(message)
      ? 502
      : /主键|配置|非法|缺少|Connection not found/i.test(message)
        ? 400
        : 500;
    res.status(status).json({ error: message });
  }
});


app.post('/api/tasks/:id/preflight', async (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问此任务' });
  }
  const validation = validateTaskRunnable(config, req.user, task);
  if (validation.error) return res.status(400).json({ error: validation.error });
  const srcConn = config.connections.find((c) => c.id === (task.sourceConnectionId || task.sourceId));
  const tgtConn = config.connections.find((c) => c.id === (task.targetConnectionId || task.targetId));
  if (!srcConn || !tgtConn) return res.status(400).json({ error: 'Connection not found' });
  try {
    const result = await runTaskPreflightCheck(task, srcConn, tgtConn);
    appendAuditLog(req.user, 'task.preflight', {
      resourceType: 'task',
      resourceId: task.id,
      resourceName: task.name,
      message: `预检任务 ${task.name || task.id}`,
      metadata: { status: result.status, errors: result.summary.error, warnings: result.summary.warn },
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tasks/:id/schema-drift', async (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task || task.deletedAt) return res.status(404).json({ error: 'Not found' });
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问此任务' });
  }
  const validation = validateTaskRunnable(config, req.user, task);
  if (validation.error) return res.status(400).json({ error: validation.error });
  try {
    const result = await detectTaskSchemaDrift(task, validation.srcConn, validation.tgtConn);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tasks/:id/schema-snapshot', async (req, res) => {
  const config = loadConfig();
  const idx = config.syncTasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1 || config.syncTasks[idx].deletedAt) return res.status(404).json({ error: 'Not found' });
  const task = config.syncTasks[idx];
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此任务' });
  }
  const validation = validateTaskRunnable(config, req.user, task);
  if (validation.error) return res.status(400).json({ error: validation.error });
  try {
    config.syncTasks[idx].schemaSnapshot = await getCurrentTaskSchema(task, validation.srcConn, validation.tgtConn);
    delete config.syncTasks[idx].schemaSnapshotError;
    await saveConfig(config);
    appendAuditLog(req.user, 'task.schema_snapshot', {
      resourceType: 'task',
      resourceId: task.id,
      resourceName: task.name,
      message: `刷新字段快照 ${task.name || task.id}`,
    });
    res.json({ success: true, schemaSnapshot: config.syncTasks[idx].schemaSnapshot });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scheduler status
app.get('/api/scheduler/status', (req, res) => {
  const config = loadConfig();
  const visibleTaskIds = new Set(config.syncTasks
    .filter((task) => !task.deletedAt && (isAdmin(req.user) || task.userId === req.user.id))
    .map((task) => task.id));
  const status = {};
  for (const [taskId, info] of syncScheduler) {
    if (visibleTaskIds.has(taskId)) {
      status[taskId] = { syncMode: info.syncMode, intervalSec: info.intervalSec };
    }
  }
  res.json(status);
});

// Run sync task manually
app.post('/api/tasks/:id/run', async (req, res) => {
  const config = loadConfig();
  const taskIdx = config.syncTasks.findIndex((t) => t.id === req.params.id);
  if (taskIdx === -1) return res.status(404).json({ error: 'Not found' });
  const task = config.syncTasks[taskIdx];
  if (!isAdmin(req.user) && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此任务' });
  }

  const srcConn = config.connections.find((c) => c.id === (task.sourceConnectionId || task.sourceId));
  const tgtConn = config.connections.find((c) => c.id === (task.targetConnectionId || task.targetId));
  const validation = validateTaskRunnable(config, req.user, task);
  if (validation.error) return res.status(400).json({ error: validation.error });
  if (!srcConn || !tgtConn) return res.status(400).json({ error: 'Connection not found' });

  let preflightForRun = null;
  try {
    const preflight = await runTaskPreflightCheck(task, validation.srcConn || srcConn, validation.tgtConn || tgtConn);
    preflightForRun = preflight;
    const gateError = preflightError(preflight);
    if (gateError) return res.status(gateError.status || 400).json({ error: gateError.message, preflight });
    if (preflight.status === 'warn') {
      await persistUserSyncLog({ taskId: task.id, level: 'warn', message: `手动同步预检有 ${preflight.summary.warn} 个警告，继续执行`, ts: new Date().toISOString() }, task.userId);
    }
  } catch (err) {
    return res.status(400).json({ error: `同步前预检失败: ${err.message}` });
  }

  const resetState = req.body?.resetState === true;
  const initializationMode = shouldUseInitializationMode(preflightForRun, req.body?.initializationMode === true || resetState);
  if (req.body?.initializationMode === true && !resetState && !preflightForRun?.initialization?.shouldUseInitializationQueue && !getTaskInitializationState(task.id).hasCheckpoint) {
    return res.status(400).json({ error: '当前任务没有可继续的初始化断点，请使用“重跑全量”重新开始。' });
  }
  if (resetState) clearTaskSyncState(task.id);
  const runControl = startTrackedRun(task, initializationMode ? 'initialization' : 'manual');
  if (!runControl.owned) return res.status(409).json({ error: '任务正在执行' });

  const cfg0 = loadConfig();
  const idx0 = cfg0.syncTasks.findIndex((x) => x.id === task.id);
  if (idx0 !== -1) {
    cfg0.syncTasks[idx0].status = initializationMode ? 'queued' : 'running';
    await saveConfig(cfg0);
  }

  if (initializationMode) {
    enqueueInitializationRun({
      task,
      srcConn,
      tgtConn,
      runControl,
      persistLog: (entry) => {
        const enhanced = { ...entry, userId: task.userId };
        broadcastLogUser(enhanced, task.userId);
        const cfg = loadConfig();
        cfg.syncLogs.push(enhanced);
        if (cfg.syncLogs.length > 500) cfg.syncLogs = cfg.syncLogs.slice(-500);
        return saveConfig(cfg, { backup: false });
      },
      resetState,
      initializationMode: true,
      trigger: resetState ? 'manual_reset' : 'initialization',
      actorUser: req.user,
    });
    const queueMeta = buildInitializationQueueMeta(task.id);
    res.json({ started: true, queued: true, initializationMode: true, queue: queueMeta });
  } else {
    res.json({ started: true, queued: false, initializationMode: false });
  }
  appendAuditLog(req.user, 'task.run', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: task.name,
    message: `${resetState ? '重新开始全量同步' : initializationMode ? '继续初始化同步' : '手动运行任务'} ${task.name || task.id}`,
    metadata: { resetState, initializationMode },
  });

  if (initializationMode) {
    await persistUserSyncLog({ taskId: task.id, level: 'info', message: `初始化任务已进入队列，当前位置 ${buildInitializationQueueMeta(task.id).position || 1}，并发上限 ${INITIALIZATION_CONCURRENCY}`, ts: new Date().toISOString() }, task.userId);
    return;
  }

  // Run async — persist logs and update task status
  try {
    const userId = task.userId;
    const persistLogUser = (entry) => {
      const enhanced = { ...entry, userId };
      broadcastLogUser(enhanced, userId);
      const cfg = loadConfig();
      cfg.syncLogs.push(enhanced);
      if (cfg.syncLogs.length > 500) cfg.syncLogs = cfg.syncLogs.slice(-500);
      return saveConfig(cfg, { backup: false });
    };

    let result;
    try {
      const { runSyncWithControl } = await import('./services/syncEngine.js');
      result = await runSyncWithControl(task, srcConn, tgtConn, persistLogUser, { ...runControl, resetState, initializationMode, trigger: resetState ? 'manual_reset' : initializationMode ? 'initialization' : 'manual' });
      runControl.finish({ status: result?.status || 'success', phase: result?.status === 'skipped' ? 'skipped' : 'completed', cancellable: false });
    } catch (err) {
      runControl.finish({
        status: err.code === 'SYNC_INITIALIZATION_PAUSED' ? 'paused' : err.code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed',
        phase: err.code === 'SYNC_INITIALIZATION_PAUSED' ? 'paused' : err.code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed',
        errorMessage: err.message,
        cancellable: false,
      });
      throw err;
    }
    if (result?.status === 'skipped') {
      const cfgSkip = loadConfig();
      const idxSkip = cfgSkip.syncTasks.findIndex((x) => x.id === task.id);
      if (idxSkip !== -1) cfgSkip.syncTasks[idxSkip].status = syncScheduler.has(task.id) ? 'scheduled' : 'idle';
      await saveConfig(cfgSkip);
      return;
    }

    // Mark done
    await finalizeTaskRun(task, result);
  } catch (err) {
    const cancelled = err.code === 'SYNC_CANCELLED';
    const paused = err.code === 'SYNC_INITIALIZATION_PAUSED';
    const entry = { taskId: task.id, level: cancelled || paused ? 'warn' : 'error', message: err.message, ts: new Date().toISOString(), userId: task.userId };
    broadcastLogUser(entry, task.userId);
    const cfg = loadConfig();
    cfg.syncLogs.push(entry);
    if (cfg.syncLogs.length > 500) cfg.syncLogs = cfg.syncLogs.slice(-500);
    await saveConfig(cfg, { backup: false });
    await failTaskRun(task, err);
  }
});

// Sync Logs
// P2-1: Support level filter ?level=info|warn|error
app.get('/api/logs', (req, res) => {
  const config = loadConfig();
  const { role, id: userId } = req.user;
  const level = req.query.level;
  const taskId = req.query.taskId;
  // Super admin sees all logs; regular users only see their own task logs
  const filtered = isAdmin({ role })
    ? config.syncLogs
    : config.syncLogs.filter((l) => !l.userId || l.userId === userId);
  let logs = level ? filtered.filter((l) => l.level === level) : filtered;
  if (taskId) logs = logs.filter((l) => l.taskId === taskId);
  res.json(logs.slice(-100));
});

app.delete('/api/logs', (req, res) => {
  const config = loadConfig();
  if (isAdmin(req.user)) {
    config.syncLogs = [];
  } else {
    config.syncLogs = config.syncLogs.filter((log) => log.userId && log.userId !== req.user.id);
  }
  saveConfig(config, { backup: false });
  res.json({ ok: true });
});

// --- Sync History API ---
import { getSyncHistory, getSyncHistoryRecord } from './services/syncHistory.js';

app.get('/api/sync-history', (req, res) => {
  const { role, id: userId } = req.user;
  const taskId = req.query.taskId;
  const limit = parseInt(req.query.limit) || 50;
  // Regular users only see their own task history
  let history;
  if (isAdmin({ role })) {
    history = getSyncHistory(taskId, limit);
  } else {
    // Filter by userId - only show tasks created by this user
    const config = loadConfig();
    const userTaskIds = config.syncTasks.filter(t => t.userId === userId).map(t => t.id);
    history = getSyncHistory(null, limit).filter(h => userTaskIds.includes(h.taskId));
    if (taskId) {
      history = history.filter(h => h.taskId === taskId);
    }
  }
  res.json(history);
});

app.get('/api/sync-history/:id', (req, res) => {
  const record = getSyncHistoryRecord(req.params.id);
  if (!record) {
    return res.status(404).json({ error: '记录不存在' });
  }
  // Check access
  const { role, id: userId } = req.user;
  const config = loadConfig();
  const task = config.syncTasks.find(t => t.id === record.taskId);
  if (!isAdmin({ role }) && task?.userId !== userId) {
    return res.status(403).json({ error: '无权访问' });
  }
  res.json(record);
});

// --- Global error handling ---
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  broadcastLog({ level: 'error', message: `系统异常: ${err.message}`, ts: new Date().toISOString() });
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
  broadcastLog({ level: 'error', message: `未处理的Promise异常: ${reason}`, ts: new Date().toISOString() });
});

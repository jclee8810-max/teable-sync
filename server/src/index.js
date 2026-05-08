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
import { getSyncFailures, getSyncFailureCounts, clearSyncFailures, removeSyncFailures, markSyncFailureRetried } from './services/syncFailures.js';
import { createTeableRecords, updateTeableRecords, deleteTeableRecords } from './services/teableService.js';
import { runSystemDoctor } from './services/systemDoctor.js';
import { getTaskHealth, getTaskHealthMap } from './services/taskHealth.js';
import { reconcileTask } from './services/reconcileService.js';
import { appendAuditLog, getAuditLogs } from './services/auditLog.js';
import { createConfigBackup, getConfigBackups } from './services/configBackup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const CONFIG_FILE = join(DATA_DIR, 'config.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3101;
const APP_VERSION = process.env.APP_VERSION || '1.0.0';
const GIT_COMMIT = process.env.GIT_COMMIT || 'unknown';
const BUILD_TIME = process.env.BUILD_TIME || 'unknown';

// --- Scheduler state (in-memory) ---
const syncScheduler = new Map(); // taskId -> { intervalId, syncMode, intervalSec }
const syncRuns = new Map(); // taskId -> { controller, state }

app.use(cors());
app.use(expressStatic(join(__dirname, '..', '..', 'client', 'dist')));
app.use(express.json({ limit: '50mb' }));

// --- Config persistence (with write lock for concurrency safety) ---
let _writeLock = Promise.resolve();

function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    return decryptConfigSecrets(JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')));
  }
  const defaults = { connections: [], syncTasks: [], syncLogs: [] };
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
    console.error('❌ Config write error:', err.message);
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
  const { id, userId, createdAt, deletedAt, status, enabled, lastSyncAt, connectionStatus, ...cleaned } = body;
  cleaned.pageSize = clampInt(cleaned.pageSize, 1000, 100, 5000);
  cleaned.batchSize = clampInt(cleaned.batchSize, 500, 50, 1000);
  cleaned.retryCount = clampInt(cleaned.retryCount, 3, 1, 8);
  if ('syncMode' in cleaned && !['manual', 'scheduled', 'realtime', 'incremental'].includes(cleaned.syncMode)) cleaned.syncMode = 'manual';
  if (!['ignore', 'soft_delete', 'hard_delete'].includes(cleaned.deletionMode)) cleaned.deletionMode = 'ignore';
  if (!/^[a-zA-Z0-9_]+$/.test(cleaned.softDeleteField || 'deleted')) cleaned.softDeleteField = 'deleted';
  return cleaned;
}

function connectionLabel(conn, fallbackId) {
  return conn?.name || fallbackId || '未配置';
}

function buildTaskConnectionStatus(config, user, task) {
  const sourceId = task.sourceConnectionId || task.sourceId;
  const targetId = task.targetConnectionId || task.targetId;
  const srcConnRaw = sourceId ? config.connections.find((c) => c.id === sourceId) : null;
  const tgtConnRaw = targetId ? config.connections.find((c) => c.id === targetId) : null;
  const validation = validateTaskConnections(config, user, task);
  const issues = [];

  if (!sourceId) issues.push({ field: 'sourceConnectionId', level: 'error', message: '未配置源数据库连接' });
  if (!targetId) issues.push({ field: 'targetConnectionId', level: 'error', message: '未配置 Teable 目标连接' });
  if (sourceId && !srcConnRaw) issues.push({ field: 'sourceConnectionId', level: 'error', message: `源连接不存在: ${sourceId}` });
  else if (srcConnRaw?.deletedAt) issues.push({ field: 'sourceConnectionId', level: 'error', message: `源连接已删除: ${connectionLabel(srcConnRaw, sourceId)}` });
  if (targetId && !tgtConnRaw) issues.push({ field: 'targetConnectionId', level: 'error', message: `目标连接不存在: ${targetId}` });
  else if (tgtConnRaw?.deletedAt) issues.push({ field: 'targetConnectionId', level: 'error', message: `目标连接已删除: ${connectionLabel(tgtConnRaw, targetId)}` });
  if (srcConnRaw && srcConnRaw.type === 'teable') issues.push({ field: 'sourceConnectionId', level: 'error', message: `源连接类型错误: ${connectionLabel(srcConnRaw, sourceId)} 是 Teable，源端必须是 SQL 数据库` });
  if (tgtConnRaw && tgtConnRaw.type !== 'teable') issues.push({ field: 'targetConnectionId', level: 'error', message: `目标连接类型错误: ${connectionLabel(tgtConnRaw, targetId)} 不是 Teable` });
  if (validation.error && issues.length === 0) issues.push({ field: 'connections', level: 'error', message: validation.error });

  for (const [field, conn] of [['sourceConnectionId', srcConnRaw], ['targetConnectionId', tgtConnRaw]]) {
    if (!conn || conn.deletedAt) continue;
    if (conn.lastTest?.success === false) {
      issues.push({ field, level: 'warn', message: `${connectionLabel(conn)} 最近测试失败: ${conn.lastTest.error || '未知错误'}` });
    }
  }

  return {
    ok: issues.filter((issue) => issue.level === 'error').length === 0,
    source: sourceId ? {
      id: sourceId,
      name: connectionLabel(srcConnRaw, sourceId),
      type: srcConnRaw?.type || null,
      readable: Boolean(validation.srcConn),
      lastTest: srcConnRaw?.lastTest || null,
    } : null,
    target: targetId ? {
      id: targetId,
      name: connectionLabel(tgtConnRaw, targetId),
      type: tgtConnRaw?.type || null,
      readable: Boolean(validation.tgtConn),
      lastTest: tgtConnRaw?.lastTest || null,
    } : null,
    issues,
  };
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

function startTrackedRun(task, trigger) {
  const existing = syncRuns.get(task.id);
  if (['running', 'cancelling'].includes(existing?.state.status)) {
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
  return syncRuns.get(taskId)?.state || { taskId, status: 'idle', phase: 'idle', cancellable: false };
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
  console.log(`🚀 TeableSync Server running on http://localhost:${PORT}`);
  resumeEnabledTasks().catch((err) => console.warn(`↻ 自动恢复检查失败: ${err.message}`));
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

function persistSyncLog(entry) {
  broadcastLog(entry);
  const cfg = loadConfig();
  cfg.syncLogs.push(entry);
  if (cfg.syncLogs.length > 500) cfg.syncLogs = cfg.syncLogs.slice(-500);
  saveConfig(cfg, { backup: false });
}

function persistUserSyncLog(entry, userId) {
  const enhanced = { ...entry, userId };
  broadcastLogUser(enhanced, userId);
  const cfg = loadConfig();
  cfg.syncLogs.push(enhanced);
  if (cfg.syncLogs.length > 500) cfg.syncLogs = cfg.syncLogs.slice(-500);
  saveConfig(cfg, { backup: false });
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
  const validation = validateTaskConnections(config, { id: task.userId, role: 'user' }, task);
  if (validation.error || !srcConn || !tgtConn) return { status: 'invalid', error: validation.error || 'Connection not found' };

  const c1 = loadConfig();
  const idx1 = c1.syncTasks.findIndex((x) => x.id === task.id);
  if (idx1 === -1) return { status: 'missing' };
  c1.syncTasks[idx1].status = 'running';
  saveConfig(c1);

  const { runSyncWithControl } = await import('./services/syncEngine.js');
  const runControl = startTrackedRun(task, trigger);
  if (!runControl.owned) {
    persistUserSyncLog({ taskId: task.id, level: 'warn', message: `[${mode}] 上一次同步仍在执行，本轮已跳过`, ts: new Date().toISOString() }, task.userId);
    return { status: 'skipped' };
  }

  try {
    const result = await runSyncWithControl(
      task,
      srcConn,
      tgtConn,
      (entry) => persistUserSyncLog(entry, task.userId),
      runControl,
    );
    runControl.finish({ status: result?.status || 'success', phase: result?.status === 'skipped' ? 'skipped' : 'completed', cancellable: false });

    const done = loadConfig();
    const idxDone = done.syncTasks.findIndex((x) => x.id === task.id);
    if (idxDone !== -1) {
      done.syncTasks[idxDone].status = 'scheduled';
      if (result?.status !== 'skipped') done.syncTasks[idxDone].lastSyncAt = new Date().toISOString();
      saveConfig(done);
    }
    if (result?.status === 'skipped') {
      persistUserSyncLog({ taskId: task.id, level: 'warn', message: `[${mode}] 上一次同步仍在执行，本轮已跳过`, ts: new Date().toISOString() }, task.userId);
    } else {
      persistUserSyncLog({ taskId: task.id, level: 'info', message: `[${mode}] 同步完成，下次同步: ${intervalSec}s 后`, ts: new Date().toISOString() }, task.userId);
    }
    return result || { status: 'success' };
  } catch (err) {
    runControl.finish({ status: err.code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed', phase: err.code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed', errorMessage: err.message, cancellable: false });
    const failed = loadConfig();
    const idxFailed = failed.syncTasks.findIndex((x) => x.id === task.id);
    if (idxFailed !== -1) {
      failed.syncTasks[idxFailed].status = 'scheduled';
      saveConfig(failed);
    }
    persistUserSyncLog({ taskId: task.id, level: 'error', message: `[${mode}] 同步失败: ${err.message}`, ts: new Date().toISOString() }, task.userId);
    return { status: 'failed', error: err.message };
  }
}

async function startTaskScheduler(taskId, actorUser, options = {}) {
  const { audit = true, runImmediately = true, resume = false } = options;
  const config = loadConfig();
  const taskIdx = config.syncTasks.findIndex((t) => t.id === taskId);
  if (taskIdx === -1) throw Object.assign(new Error('Not found'), { status: 404 });
  const task = config.syncTasks[taskIdx];
  if (actorUser.role !== 'super_admin' && task.userId !== actorUser.id) {
    throw Object.assign(new Error('无权操作此任务'), { status: 403 });
  }

  const missingFields = getTaskStartMissingFields(task);
  if (missingFields.length > 0) {
    throw Object.assign(new Error(`缺少必要字段: ${missingFields.join(', ')}`), { status: 400 });
  }
  const validation = validateTaskConnections(config, actorUser, task);
  if (validation.error) throw Object.assign(new Error(validation.error), { status: 400 });

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
  saveConfig(cfg);

  const intervalId = setInterval(() => {
    runScheduledTask(task.id, mode, mode, intervalSec).catch((err) => {
      persistUserSyncLog({ taskId: task.id, level: 'error', message: `[${mode}] 调度失败: ${err.message}`, ts: new Date().toISOString() }, task.userId);
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

  persistUserSyncLog({ taskId: task.id, level: 'info', message: `已${resume ? '恢复' : '启动'}${mode === 'realtime' ? '实时' : '定时'}同步，间隔 ${intervalSec}s`, ts: new Date().toISOString() }, task.userId);

  if (runImmediately) {
    await runScheduledTask(task.id, resume ? 'resume' : 'initial', mode, intervalSec);
  }
  return { started: true, syncMode: mode, intervalSec };
}

async function resumeEnabledTasks() {
  if (process.env.AUTO_RESUME_TASKS !== 'true') {
    console.log('💡 自动恢复已关闭，设置 AUTO_RESUME_TASKS=true 可启用');
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
      console.warn(`↻ 自动恢复失败: ${task.name || task.id}: ${err.message}`);
    }
  }
  console.log(`↻ 自动恢复完成: ${restored}/${resumable.length} 个任务`);
}

// --- Routes ---

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/system/doctor', (req, res) => {
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '仅管理员可执行系统检查' });
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
  if (req.user.role !== 'super_admin') return res.status(403).json({ error: '仅管理员可查看配置备份' });
  res.json(getConfigBackups(CONFIG_FILE, req.query.limit));
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
    return role === 'super_admin' || c.ownerId === userId || c.shared === true;
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
  if (req.user.role !== 'super_admin' && conn.ownerId !== req.user.id) {
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
  if (req.user.role !== 'super_admin' && conn.ownerId !== req.user.id) {
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
  if (req.user.role !== 'super_admin' && conn.ownerId !== req.user.id) {
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
  if (req.user.role !== 'super_admin' && conn.ownerId !== req.user.id) {
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

// Fetch tables from a SQL connection (with watermark candidates)
app.get('/api/connections/:id/tables', async (req, res) => {
  const config = loadConfig();
  const conn = config.connections.find((c) => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (!canReadConnection(req.user, conn)) return res.status(403).json({ error: '无权访问此连接' });

  try {
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
    const { getTeableFields } = await import('./services/teableService.js');
    const { suggestMappings } = await import('./services/mappingSuggester.js');

    const sourceColumns = await getTableSchema(srcConn, sourceTable, sourceDatabase || null);
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
    return role === 'super_admin' || t.userId === userId;
  });
  res.json(visible.map((task) => taskDto(config, req.user, task)));
});

app.post('/api/tasks', (req, res) => {
  const config = loadConfig();
  const validation = validateTaskConnections(config, req.user, req.body);
  if (validation.error) return res.status(400).json({ error: validation.error });
  const body = cleanTaskInput(req.body);
  const task = {
    ...body,
    id: crypto.randomUUID(),
    syncMode: body.syncMode || 'manual',
    enabled: false,
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
    status: 'idle',
    userId: req.user.id, // 任务归属当前用户
  };
  config.syncTasks.push(task);
  saveConfig(config);
  appendAuditLog(req.user, 'task.create', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: task.name,
    message: `创建任务 ${task.name || task.id}`,
    metadata: { syncMode: task.syncMode, sourceTable: task.sourceTable, targetTableId: task.targetTableId },
  });
  res.json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const config = loadConfig();
  const idx = config.syncTasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const task = config.syncTasks[idx];
  if (task.deletedAt) return res.status(400).json({ error: '该任务已删除，请先恢复' });
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权编辑此任务' });
  }
  const updates = cleanTaskInput(req.body);
  const nextTask = { ...task, ...updates, id: task.id, userId: task.userId, createdAt: task.createdAt };
  const validation = validateTaskConnections(config, req.user, nextTask);
  if (validation.error) return res.status(400).json({ error: validation.error });
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
  res.json(config.syncTasks[idx]);
});

app.delete('/api/tasks/:id', (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
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
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
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
  res.json(config.syncTasks[idx]);
});

// Preview source data before sync
app.get('/api/tasks/:id/preview', async (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问此任务' });
  }
  
  const limit = Math.min(parseInt(req.query.limit) || 10, 100); // max 100 rows
  
  try {
    const { getTableSchema, query } = await import('./services/dbService.js');
    
    // Find source connection
    const srcConn = config.connections.find((c) => c.id === (task.sourceConnectionId || task.sourceId));
    if (!srcConn) return res.status(400).json({ error: '源连接不存在' });
    const validation = validateTaskConnections(config, req.user, task);
    if (validation.error) return res.status(400).json({ error: validation.error });
    
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
app.post('/api/tasks/:id/stop', (req, res) => {
  const config = loadConfig();
  const taskIdx = config.syncTasks.findIndex((t) => t.id === req.params.id);
  if (taskIdx === -1) return res.status(404).json({ error: 'Not found' });
  const task = config.syncTasks[taskIdx];
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此任务' });
  }

  if (syncScheduler.has(req.params.id)) {
    clearInterval(syncScheduler.get(req.params.id).intervalId);
    syncScheduler.delete(req.params.id);
  }
  const run = syncRuns.get(req.params.id);
  if (run?.state.status === 'running') {
    run.controller.abort();
    run.state = { ...run.state, status: 'cancelling', phase: 'cancelling', updatedAt: new Date().toISOString() };
    syncRuns.set(req.params.id, run);
  }

  config.syncTasks[taskIdx].status = 'idle';
  config.syncTasks[taskIdx].enabled = false;
  saveConfig(config);

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
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问此任务' });
  }
  res.json(getRunState(req.params.id));
});

app.post('/api/tasks/:id/cancel', (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此任务' });
  }
  const run = syncRuns.get(req.params.id);
  if (!run || !['running', 'cancelling'].includes(run.state.status)) {
    return res.status(409).json({ error: '当前没有正在执行的同步' });
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
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问此任务' });
  }
  res.json(getSyncFailures(req.params.id).map((f) => ({
    ...f,
    records: undefined,
    recordIds: undefined,
    hasPayload: Boolean(f.records || f.recordIds),
  })));
});

app.get('/api/sync-failures/counts', (req, res) => {
  const config = loadConfig();
  const counts = getSyncFailureCounts();
  if (req.user.role === 'super_admin') return res.json(counts);
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
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
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

app.post('/api/tasks/:id/retry-failures', async (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此任务' });
  }
  const tgtConn = config.connections.find((c) => c.id === (task.targetConnectionId || task.targetId));
  if (!tgtConn) return res.status(400).json({ error: 'Target connection not found' });

  const failures = getSyncFailures(req.params.id);
  const retried = [];
  const stillFailed = [];
  for (const failure of failures) {
    try {
      if (failure.operation === 'insert') {
        await createTeableRecords(tgtConn, failure.tableId || task.targetTableId, failure.records || []);
      } else if (failure.operation === 'update' || failure.operation === 'soft_delete') {
        await updateTeableRecords(tgtConn, failure.tableId || task.targetTableId, failure.records || []);
      } else if (failure.operation === 'hard_delete') {
        await deleteTeableRecords(tgtConn, failure.tableId || task.targetTableId, failure.recordIds || []);
      } else {
        throw new Error('Unsupported failure operation: ' + failure.operation);
      }
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
    metadata: { retried: retried.length, failed: stillFailed.length },
  });
  res.json({ retried: retried.length, failed: stillFailed.length, errors: stillFailed });
});

app.get('/api/tasks/:id/health', (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问此任务' });
  }
  res.json(getTaskHealth(task));
});

app.get('/api/tasks-health', (req, res) => {
  const config = loadConfig();
  const { role, id: userId } = req.user;
  const tasks = config.syncTasks.filter((task) => {
    if (task.deletedAt) return false;
    return role === 'super_admin' || task.userId === userId;
  });
  res.json(getTaskHealthMap(tasks));
});

app.post('/api/tasks/:id/reconcile', async (req, res) => {
  const config = loadConfig();
  const task = config.syncTasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权访问此任务' });
  }
  const validation = validateTaskConnections(config, req.user, task);
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
    res.status(500).json({ error: err.message });
  }
});

// Scheduler status
app.get('/api/scheduler/status', (req, res) => {
  const config = loadConfig();
  const visibleTaskIds = new Set(config.syncTasks
    .filter((task) => !task.deletedAt && (req.user.role === 'super_admin' || task.userId === req.user.id))
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
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此任务' });
  }

  const srcConn = config.connections.find((c) => c.id === (task.sourceConnectionId || task.sourceId));
  const tgtConn = config.connections.find((c) => c.id === (task.targetConnectionId || task.targetId));
  const validation = validateTaskConnections(config, req.user, task);
  if (validation.error) return res.status(400).json({ error: validation.error });
  if (!srcConn || !tgtConn) return res.status(400).json({ error: 'Connection not found' });

  const { runSyncWithControl } = await import('./services/syncEngine.js');
  const runControl = startTrackedRun(task, 'manual');
  if (!runControl.owned) return res.status(409).json({ error: '任务正在执行' });

  const cfg0 = loadConfig();
  const idx0 = cfg0.syncTasks.findIndex((x) => x.id === task.id);
  if (idx0 !== -1) {
    cfg0.syncTasks[idx0].status = 'running';
    saveConfig(cfg0);
  }

  res.json({ started: true });
  appendAuditLog(req.user, 'task.run', {
    resourceType: 'task',
    resourceId: task.id,
    resourceName: task.name,
    message: `手动运行任务 ${task.name || task.id}`,
  });

  // Run async — persist logs and update task status
  try {
    const userId = task.userId;
    const persistLogUser = (entry) => {
      const enhanced = { ...entry, userId };
      broadcastLogUser(enhanced, userId);
      const cfg = loadConfig();
      cfg.syncLogs.push(enhanced);
      if (cfg.syncLogs.length > 500) cfg.syncLogs = cfg.syncLogs.slice(-500);
      saveConfig(cfg, { backup: false });
    };

    let result;
    try {
      result = await runSyncWithControl(task, srcConn, tgtConn, persistLogUser, runControl);
      runControl.finish({ status: result?.status || 'success', phase: result?.status === 'skipped' ? 'skipped' : 'completed', cancellable: false });
    } catch (err) {
      runControl.finish({ status: err.code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed', phase: err.code === 'SYNC_CANCELLED' ? 'cancelled' : 'failed', errorMessage: err.message, cancellable: false });
      throw err;
    }
    if (result?.status === 'skipped') {
      const cfgSkip = loadConfig();
      const idxSkip = cfgSkip.syncTasks.findIndex((x) => x.id === task.id);
      if (idxSkip !== -1) cfgSkip.syncTasks[idxSkip].status = syncScheduler.has(task.id) ? 'scheduled' : 'idle';
      saveConfig(cfgSkip);
      return;
    }

    // Mark done
    const cfg1 = loadConfig();
    const idx1 = cfg1.syncTasks.findIndex((x) => x.id === task.id);
    if (idx1 !== -1) {
      cfg1.syncTasks[idx1].status = syncScheduler.has(task.id) ? 'scheduled' : 'idle';
      cfg1.syncTasks[idx1].lastSyncAt = new Date().toISOString();
      saveConfig(cfg1);
    }
  } catch (err) {
    const cancelled = err.code === 'SYNC_CANCELLED';
    const entry = { taskId: task.id, level: cancelled ? 'warn' : 'error', message: err.message, ts: new Date().toISOString(), userId: task.userId };
    broadcastLogUser(entry, task.userId);
    const cfg = loadConfig();
    cfg.syncLogs.push(entry);
    const idx = cfg.syncTasks.findIndex((x) => x.id === task.id);
    if (idx !== -1) cfg.syncTasks[idx].status = syncScheduler.has(task.id) ? 'scheduled' : (cancelled ? 'idle' : 'error');
    saveConfig(cfg, { backup: false });
  }
});

// Sync Logs
// P2-1: Support level filter ?level=info|warn|error
app.get('/api/logs', (req, res) => {
  const config = loadConfig();
  const { role, id: userId } = req.user;
  const level = req.query.level;
  // Super admin sees all logs; regular users only see their own task logs
  const filtered = role === 'super_admin'
    ? config.syncLogs
    : config.syncLogs.filter((l) => !l.userId || l.userId === userId);
  const logs = level ? filtered.filter((l) => l.level === level) : filtered;
  res.json(logs.slice(-100));
});

app.delete('/api/logs', (req, res) => {
  const config = loadConfig();
  if (req.user.role === 'super_admin') {
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
  if (role === 'super_admin') {
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
  if (role !== 'super_admin' && task?.userId !== userId) {
    return res.status(403).json({ error: '无权访问' });
  }
  res.json(record);
});

// --- Global error handling ---
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err);
  broadcastLog({ level: 'error', message: `系统异常: ${err.message}`, ts: new Date().toISOString() });
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
  broadcastLog({ level: 'error', message: `未处理的Promise异常: ${reason}`, ts: new Date().toISOString() });
});

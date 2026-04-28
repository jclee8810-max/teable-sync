import express from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import authRouter from './routes/auth.js';
import oauthRouter from './routes/oauth.js';
import { authMiddleware } from './middleware/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const CONFIG_FILE = join(DATA_DIR, 'config.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3100;

// --- Scheduler state (in-memory) ---
const syncScheduler = new Map(); // taskId -> { intervalId, syncMode, intervalSec }

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- Config persistence (with write lock for concurrency safety) ---
let _writeLock = Promise.resolve();

function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  }
  const defaults = { connections: [], syncTasks: [], syncLogs: [] };
  saveConfig(defaults);
  return defaults;
}

function saveConfig(config) {
  _writeLock = _writeLock.then(() => {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  }).catch(err => {
    console.error('❌ Config write error:', err.message);
  });
  return _writeLock;
}

// --- Auth routes (public) ---
app.use('/api/auth', authRouter);
// --- OAuth routes ---
app.use('/api/oauth', oauthRouter);

// --- Public health (before auth middleware) ---
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// --- Protected API routes ---
app.use('/api', authMiddleware);
const server = app.listen(PORT, () => {
  console.log(`🚀 TeableSync Server running on http://localhost:${PORT}`);
    // 启动时自动恢复定时任务（默认关闭，通过环境变量 AUTO_RESUME_TASKS=true 开启）
  if (process.env.AUTO_RESUME_TASKS === 'true') {
    const config = loadConfig();
    for (const task of config.syncTasks) {
      if (task.enabled && (task.syncMode === 'scheduled' || task.syncMode === 'realtime' || task.syncMode === 'incremental')) {
        fetch(`http://127.0.0.1:${PORT}/api/tasks/${task.id}/start`, { method: 'POST' })
          .then(() => console.log(`↻ 自动恢复: ${task.name} (${task.syncMode})`))
          .catch(() => {});
      }
    }
  } else {
    console.log('💡 自动恢复已关闭，设置 AUTO_RESUME_TASKS=true 可启用');
  }
});

const wss = new WebSocketServer({ server });
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.on('close', () => wsClients.delete(ws));
});

function broadcastLog(log) {
  const msg = JSON.stringify({ type: 'sync_log', data: log });
  wsClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

// --- Routes ---

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Connections CRUD (multi-tenant: owner can see/edit + shared connections)
app.get('/api/connections', (req, res) => {
  const config = loadConfig();
  const { role, id: userId } = req.user;
  const visible = config.connections.filter(
    (c) => role === 'super_admin' || c.ownerId === userId || c.shared === true
  );
  res.json(visible);
});

app.post('/api/connections', (req, res) => {
  const config = loadConfig();
  const conn = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ownerId: req.user.id,
    shared: false, // 默认为私有
    ...req.body,
  };
  config.connections.push(conn);
  saveConfig(config);
  res.json(conn);
});

app.put('/api/connections/:id', (req, res) => {
  const config = loadConfig();
  const idx = config.connections.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const conn = config.connections[idx];
  // 非 super_admin 只能编辑自己的
  if (req.user.role !== 'super_admin' && conn.ownerId !== req.user.id) {
    return res.status(403).json({ error: '无权编辑此连接' });
  }
  config.connections[idx] = { ...conn, ...req.body, id: conn.id, ownerId: conn.ownerId };
  saveConfig(config);
  res.json(config.connections[idx]);
});

app.delete('/api/connections/:id', (req, res) => {
  const config = loadConfig();
  const conn = config.connections.find((c) => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'super_admin' && conn.ownerId !== req.user.id) {
    return res.status(403).json({ error: '无权删除此连接' });
  }
  config.connections = config.connections.filter((c) => c.id !== req.params.id);
  saveConfig(config);
  res.json({ ok: true });
});

// Test connection (supports both SQL databases and Teable)
app.post('/api/connections/:id/test', async (req, res) => {
  const config = loadConfig();
  const conn = config.connections.find((c) => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });

  try {
    if (conn.type === 'teable') {
      const { getTeableSpaces } = await import('./services/teableService.js');
      const spaces = await getTeableSpaces(conn);
      res.json({ success: true, type: 'teable', spaces: spaces.length, message: `连接成功，共 ${spaces.length} 个空间` });
    } else {
      const { testConnection } = await import('./services/dbService.js');
      const result = await testConnection(conn);
      res.json({ success: true, type: conn.type, ...result });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Fetch tables from a SQL connection
app.get('/api/connections/:id/tables', async (req, res) => {
  const config = loadConfig();
  const conn = config.connections.find((c) => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });

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

// Teable: list spaces
app.get('/api/teable/spaces', async (req, res) => {
  try {
    const { getTeableSpaces } = await import('./services/teableService.js');
    const config = loadConfig();
    const conn = req.query.connectionId
      ? config.connections.find((c) => c.id === req.query.connectionId)
      : config.connections.find((c) => c.type === 'teable');
    if (!conn) return res.status(400).json({ error: 'No Teable connection found' });
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
  const visible = role === 'super_admin'
    ? config.syncTasks
    : config.syncTasks.filter((t) => t.userId === userId);
  res.json(visible);
});

app.post('/api/tasks', (req, res) => {
  const config = loadConfig();
  const task = {
    id: crypto.randomUUID(),
    enabled: false,
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
    status: 'idle',
    userId: req.user.id, // 任务归属当前用户
    ...req.body,
  };
  config.syncTasks.push(task);
  saveConfig(config);
  res.json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const config = loadConfig();
  const idx = config.syncTasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const task = config.syncTasks[idx];
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权编辑此任务' });
  }
  config.syncTasks[idx] = { ...task, ...req.body, id: task.id, userId: task.userId };
  saveConfig(config);
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
  config.syncTasks = config.syncTasks.filter((t) => t.id !== req.params.id);
  saveConfig(config);
  res.json({ ok: true });
});

// Start auto-sync for a task (scheduled / realtime)
app.post('/api/tasks/:id/start', async (req, res) => {
  const config = loadConfig();
  const taskIdx = config.syncTasks.findIndex((t) => t.id === req.params.id);
  if (taskIdx === -1) return res.status(404).json({ error: 'Not found' });
  const task = config.syncTasks[taskIdx];
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作此任务' });
  }

  // P2-3: Validate required fields before starting scheduler
  const missingFields = [];
  if (!task.sourceTable) missingFields.push('sourceTable');
  if (!task.targetTableId) missingFields.push('targetTableId');
  if (!task.sourceConnectionId && !task.sourceId) missingFields.push('sourceConnectionId');
  if (!task.targetConnectionId && !task.targetId) missingFields.push('targetConnectionId');
  if (missingFields.length > 0) {
    return res.status(400).json({ error: `缺少必要字段: ${missingFields.join(', ')}` });
  }

  // Stop existing timer if any
  if (syncScheduler.has(task.id)) {
    clearInterval(syncScheduler.get(task.id).intervalId);
    syncScheduler.delete(task.id);
  }

  const intervalSec = task.syncInterval || 300; // default 5 min
  const mode = task.syncMode || 'scheduled';

  // Mark as running in config
  const cfg = loadConfig();
  cfg.syncTasks[taskIdx].status = 'scheduled';
  cfg.syncTasks[taskIdx].enabled = true;
  saveConfig(cfg);

  const intervalId = setInterval(async () => {
    // Check if task still exists and is enabled
    const c = loadConfig();
    const t = c.syncTasks.find((x) => x.id === task.id);
    if (!t || !t.enabled) {
      clearInterval(intervalId);
      syncScheduler.delete(task.id);
      return;
    }
    // Skip if already running
    if (t.status === 'running') return;

    // Trigger sync
    try {
      const srcConn = c.connections.find((cn) => cn.id === (t.sourceConnectionId || t.sourceId));
      const tgtConn = c.connections.find((cn) => cn.id === (t.targetConnectionId || t.targetId));
      if (!srcConn || !tgtConn) return;

      const { runSync } = await import('./services/syncEngine.js');
      const persistLog = (entry) => {
        broadcastLog(entry);
        const cfg2 = loadConfig();
        cfg2.syncLogs.push(entry);
        if (cfg2.syncLogs.length > 500) cfg2.syncLogs = cfg2.syncLogs.slice(-500);
        saveConfig(cfg2);
      };

      const c1 = loadConfig();
      const idx1 = c1.syncTasks.findIndex((x) => x.id === task.id);
      if (idx1 === -1) return;
      c1.syncTasks[idx1].status = 'running';
      saveConfig(c1);

      await runSync(t, srcConn, tgtConn, persistLog);

      const c2 = loadConfig();
      const idx2 = c2.syncTasks.findIndex((x) => x.id === task.id);
      if (idx2 === -1) return;
      c2.syncTasks[idx2].status = 'scheduled';
      c2.syncTasks[idx2].lastSyncAt = new Date().toISOString();
      saveConfig(c2);
      broadcastLog({ taskId: task.id, level: 'info', message: `[${mode}] 同步完成，下次同步: ${intervalSec}s 后`, ts: new Date().toISOString() });
    } catch (err) {
      const c3 = loadConfig();
      const idx3 = c3.syncTasks.findIndex((x) => x.id === task.id);
      if (idx3 !== -1) {
        c3.syncTasks[idx3].status = 'scheduled'; // keep running on schedule even if one run fails
        saveConfig(c3);
      }
      broadcastLog({ taskId: task.id, level: 'error', message: `[${mode}] 同步失败: ${err.message}`, ts: new Date().toISOString() });
    }
  }, intervalSec * 1000);

  syncScheduler.set(task.id, { intervalId, syncMode: mode, intervalSec });

  broadcastLog({ taskId: task.id, level: 'info', message: `已启动${mode === 'realtime' ? '实时' : '定时'}同步，间隔 ${intervalSec}s`, ts: new Date().toISOString() });

  // Run first sync immediately
  try {
    const c0 = loadConfig();
    const srcConn = c0.connections.find((cn) => cn.id === (task.sourceConnectionId || task.sourceId));
    const tgtConn = c0.connections.find((cn) => cn.id === (task.targetConnectionId || task.targetId));
    if (srcConn && tgtConn) {
      const { runSync } = await import('./services/syncEngine.js');
      const persistLog = (entry) => {
        broadcastLog(entry);
        const cfg3 = loadConfig();
        cfg3.syncLogs.push(entry);
        if (cfg3.syncLogs.length > 500) cfg3.syncLogs = cfg3.syncLogs.slice(-500);
        saveConfig(cfg3);
      };
      const cInit = loadConfig();
      const idxInit = cInit.syncTasks.findIndex((x) => x.id === task.id);
      if (idxInit !== -1) {
        cInit.syncTasks[idxInit].status = 'running';
        saveConfig(cInit);
        await runSync(task, srcConn, tgtConn, persistLog);
        const cDone = loadConfig();
        const idxDone = cDone.syncTasks.findIndex((x) => x.id === task.id);
        if (idxDone !== -1) {
          cDone.syncTasks[idxDone].status = 'scheduled';
          cDone.syncTasks[idxDone].lastSyncAt = new Date().toISOString();
          saveConfig(cDone);
        }
      }
    }
  } catch (err) {
    broadcastLog({ taskId: task.id, level: 'error', message: `首次同步失败: ${err.message}`, ts: new Date().toISOString() });
  }

  res.json({ started: true, syncMode: mode, intervalSec });
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

  config.syncTasks[taskIdx].status = 'idle';
  config.syncTasks[taskIdx].enabled = false;
  saveConfig(config);

  broadcastLog({ taskId: req.params.id, level: 'info', message: '已停止自动同步', ts: new Date().toISOString() });
  res.json({ stopped: true });
});

// Scheduler status
app.get('/api/scheduler/status', (req, res) => {
  const status = {};
  for (const [taskId, info] of syncScheduler) {
    status[taskId] = { syncMode: info.syncMode, intervalSec: info.intervalSec };
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
  if (!srcConn || !tgtConn) return res.status(400).json({ error: 'Connection not found' });

  res.json({ started: true });

  // Run async — persist logs and update task status
  try {
    const { runSync } = await import('./services/syncEngine.js');

    const persistLog = (entry) => {
      broadcastLog(entry);
      // Persist to config
      const cfg = loadConfig();
      cfg.syncLogs.push(entry);
      if (cfg.syncLogs.length > 500) cfg.syncLogs = cfg.syncLogs.slice(-500);
      saveConfig(cfg);
    };

    // Mark running
    const cfg0 = loadConfig();
    cfg0.syncTasks[taskIdx].status = 'running';
    saveConfig(cfg0);

    await runSync(task, srcConn, tgtConn, persistLog);

    // Mark done
    const cfg1 = loadConfig();
    cfg1.syncTasks[taskIdx].status = syncScheduler.has(task.id) ? 'scheduled' : 'idle';
    cfg1.syncTasks[taskIdx].lastSyncAt = new Date().toISOString();
    saveConfig(cfg1);
  } catch (err) {
    const entry = { taskId: task.id, level: 'error', message: err.message, ts: new Date().toISOString() };
    broadcastLog(entry);
    const cfg = loadConfig();
    cfg.syncLogs.push(entry);
    cfg.syncTasks[taskIdx].status = syncScheduler.has(task.id) ? 'scheduled' : 'error';
    saveConfig(cfg);
  }
});

// Sync Logs
// P2-1: Support level filter ?level=info|warn|error
app.get('/api/logs', (req, res) => {
  const config = loadConfig();
  const level = req.query.level;
  const logs = level ? config.syncLogs.filter(l => l.level === level) : config.syncLogs;
  res.json(logs.slice(-100));
});

app.delete('/api/logs', (req, res) => {
  const config = loadConfig();
  config.syncLogs = [];
  saveConfig(config);
  res.json({ ok: true });
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

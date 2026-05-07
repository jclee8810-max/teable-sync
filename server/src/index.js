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

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const CONFIG_FILE = join(DATA_DIR, 'config.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const PORT = process.env.PORT || 3100;

// --- Scheduler state (in-memory) ---
const syncScheduler = new Map(); // taskId -> { intervalId, syncMode, intervalSec }

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

function saveConfig(config) {
  _writeLock = _writeLock.then(() => {
    const tmpFile = `${CONFIG_FILE}.tmp`;
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
  return safe;
}

function cleanConnectionInput(body = {}) {
  const { id, ownerId, createdAt, deletedAt, ...cleaned } = body;
  for (const field of CONNECTION_DTO_ONLY_FIELDS) delete cleaned[field];
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
  const { id, userId, createdAt, deletedAt, status, enabled, lastSyncAt, ...cleaned } = body;
  cleaned.pageSize = clampInt(cleaned.pageSize, 1000, 100, 5000);
  cleaned.batchSize = clampInt(cleaned.batchSize, 500, 50, 1000);
  cleaned.retryCount = clampInt(cleaned.retryCount, 3, 1, 8);
  if (!['ignore', 'soft_delete', 'hard_delete'].includes(cleaned.deletionMode)) cleaned.deletionMode = 'ignore';
  if (!/^[a-zA-Z0-9_]+$/.test(cleaned.softDeleteField || 'deleted')) cleaned.softDeleteField = 'deleted';
  return cleaned;
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

// --- Routes ---

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

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
  res.json(sanitizeConnection(config.connections[idx]));
});

// Test connection (supports both SQL databases and Teable)
app.post('/api/connections/:id/test', async (req, res) => {
  const config = loadConfig();
  const conn = config.connections.find((c) => c.id === req.params.id);
  if (!conn) return res.status(404).json({ error: 'Not found' });
  if (!canReadConnection(req.user, conn)) return res.status(403).json({ error: '无权访问此连接' });

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

  const srcConn = config.connections.find((c) => c.id === sourceConnectionId);
  const tgtConn = config.connections.find((c) => c.id === targetTableId ? c : c.id === (req.query.targetConnectionId));
  // targetConnectionId is for the Teable connection, targetTableId is the table
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
  res.json(visible);
});

app.post('/api/tasks', (req, res) => {
  const config = loadConfig();
  const validation = validateTaskConnections(config, req.user, req.body);
  if (validation.error) return res.status(400).json({ error: validation.error });
  const body = cleanTaskInput(req.body);
  const task = {
    ...body,
    id: crypto.randomUUID(),
    enabled: false,
    createdAt: new Date().toISOString(),
    lastSyncAt: null,
    status: 'idle',
    userId: req.user.id, // 任务归属当前用户
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
  if (task.deletedAt) return res.status(400).json({ error: '该任务已删除，请先恢复' });
  if (req.user.role !== 'super_admin' && task.userId !== req.user.id) {
    return res.status(403).json({ error: '无权编辑此任务' });
  }
  const updates = cleanTaskInput(req.body);
  const nextTask = { ...task, ...updates, id: task.id, userId: task.userId, createdAt: task.createdAt };
  const validation = validateTaskConnections(config, req.user, nextTask);
  if (validation.error) return res.status(400).json({ error: validation.error });
  config.syncTasks[idx] = nextTask;
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
  // 软删除：标记 deletedAt，不物理删除
  task.deletedAt = new Date().toISOString();
  saveConfig(config);
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
  const startValidation = validateTaskConnections(config, req.user, task);
  if (startValidation.error) return res.status(400).json({ error: startValidation.error });

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
      const runValidation = validateTaskConnections(c, { id: t.userId, role: 'user' }, t);
      if (runValidation.error || !srcConn || !tgtConn) return;

      const { runSync } = await import('./services/syncEngine.js');
      const persistLog = (entry) => {
        broadcastLog(entry);
        const cfg2 = loadConfig();
        cfg2.syncLogs.push(entry);
        if (cfg2.syncLogs.length > 500) cfg2.syncLogs = cfg2.syncLogs.slice(-500);
        saveConfig(cfg2);
      };
      const userId = task.userId;
      const persistLogUser = (entry) => {
        persistLog({ ...entry, userId });
      };

      const c1 = loadConfig();
      const idx1 = c1.syncTasks.findIndex((x) => x.id === task.id);
      if (idx1 === -1) return;
      c1.syncTasks[idx1].status = 'running';
      saveConfig(c1);

      await runSync(t, srcConn, tgtConn, persistLogUser);

      const c2 = loadConfig();
      const idx2 = c2.syncTasks.findIndex((x) => x.id === task.id);
      if (idx2 === -1) return;
      c2.syncTasks[idx2].status = 'scheduled';
      c2.syncTasks[idx2].lastSyncAt = new Date().toISOString();
      saveConfig(c2);
      broadcastLogUser({ taskId: task.id, level: 'info', message: `[${mode}] 同步完成，下次同步: ${intervalSec}s 后`, ts: new Date().toISOString() }, userId);
    } catch (err) {
      const c3 = loadConfig();
      const idx3 = c3.syncTasks.findIndex((x) => x.id === task.id);
      if (idx3 !== -1) {
        c3.syncTasks[idx3].status = 'scheduled'; // keep running on schedule even if one run fails
        saveConfig(c3);
      }
      broadcastLogUser({ taskId: task.id, level: 'error', message: `[${mode}] 同步失败: ${err.message}`, ts: new Date().toISOString() }, userId);
    }
  }, intervalSec * 1000);

  syncScheduler.set(task.id, { intervalId, syncMode: mode, intervalSec });

  broadcastLogUser({ taskId: task.id, level: 'info', message: `已启动${mode === 'realtime' ? '实时' : '定时'}同步，间隔 ${intervalSec}s`, ts: new Date().toISOString() }, task.userId);

  // Run first sync immediately
  try {
    const c0 = loadConfig();
    const srcConn = c0.connections.find((cn) => cn.id === (task.sourceConnectionId || task.sourceId));
    const tgtConn = c0.connections.find((cn) => cn.id === (task.targetConnectionId || task.targetId));
    const initValidation = validateTaskConnections(c0, req.user, task);
    if (srcConn && tgtConn && !initValidation.error) {
      const { runSync } = await import('./services/syncEngine.js');
      const persistLog = (entry) => {
        broadcastLog(entry);
        const cfg3 = loadConfig();
        cfg3.syncLogs.push(entry);
        if (cfg3.syncLogs.length > 500) cfg3.syncLogs = cfg3.syncLogs.slice(-500);
        saveConfig(cfg3);
      };
      const userId = task.userId;
      const persistLogUser = (entry) => {
        persistLog({ ...entry, userId });
      };
      const cInit = loadConfig();
      const idxInit = cInit.syncTasks.findIndex((x) => x.id === task.id);
      if (idxInit !== -1) {
        cInit.syncTasks[idxInit].status = 'running';
        saveConfig(cInit);
        await runSync(task, srcConn, tgtConn, persistLogUser);
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
    broadcastLogUser({ taskId: task.id, level: 'error', message: `首次同步失败: ${err.message}`, ts: new Date().toISOString() }, task.userId);
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

  broadcastLogUser({ taskId: req.params.id, level: 'info', message: '已停止自动同步', ts: new Date().toISOString() }, task.userId);
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
  const validation = validateTaskConnections(config, req.user, task);
  if (validation.error) return res.status(400).json({ error: validation.error });
  if (!srcConn || !tgtConn) return res.status(400).json({ error: 'Connection not found' });

  res.json({ started: true });

  // Run async — persist logs and update task status
  try {
    const { runSync } = await import('./services/syncEngine.js');
    const userId = task.userId;
    const persistLogUser = (entry) => {
      const enhanced = { ...entry, userId };
      broadcastLogUser(enhanced, userId);
      const cfg = loadConfig();
      cfg.syncLogs.push(enhanced);
      if (cfg.syncLogs.length > 500) cfg.syncLogs = cfg.syncLogs.slice(-500);
      saveConfig(cfg);
    };

    // Mark running
    const cfg0 = loadConfig();
    cfg0.syncTasks[taskIdx].status = 'running';
    saveConfig(cfg0);

    await runSync(task, srcConn, tgtConn, persistLogUser);

    // Mark done
    const cfg1 = loadConfig();
    cfg1.syncTasks[taskIdx].status = syncScheduler.has(task.id) ? 'scheduled' : 'idle';
    cfg1.syncTasks[taskIdx].lastSyncAt = new Date().toISOString();
    saveConfig(cfg1);
  } catch (err) {
    const entry = { taskId: task.id, level: 'error', message: err.message, ts: new Date().toISOString(), userId: task.userId };
    broadcastLogUser(entry, task.userId);
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
  config.syncLogs = [];
  saveConfig(config);
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

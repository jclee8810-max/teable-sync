const MIGRATION_FORMAT = 'teable-sync.config';
const MIGRATION_VERSION = 1;
const SECRET_FIELDS = ['password', 'token', 'oauthClientSecret', 'teableOAuthToken'];
const CONFIG_ARRAYS = ['connections', 'syncTasks', 'taskTemplates'];
const RUNTIME_TASK_FIELDS = ['status', 'enabled', 'lastSyncAt', 'connectionStatus', '_running'];

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function stripSecretsFromConnection(conn = {}) {
  const next = clone(conn) || {};
  for (const field of SECRET_FIELDS) {
    if (next[field]) next[`has${field[0].toUpperCase()}${field.slice(1)}`] = true;
    delete next[field];
  }
  if (next.config && typeof next.config === 'object') {
    for (const field of SECRET_FIELDS) delete next.config[field];
  }
  return next;
}

function normalizeExportConfig(config = {}, options = {}) {
  const includeSecrets = options.includeSecrets === true;
  const includeLogs = options.includeLogs === true;
  const next = {
    connections: clone(config.connections || []),
    syncTasks: clone(config.syncTasks || []),
    taskTemplates: clone(config.taskTemplates || []),
  };
  if (!includeSecrets) next.connections = next.connections.map(stripSecretsFromConnection);
  if (includeLogs) next.syncLogs = clone(config.syncLogs || []);
  for (const task of next.syncTasks) {
    for (const field of RUNTIME_TASK_FIELDS) delete task[field];
  }
  return next;
}

export function buildConfigExport(config, options = {}) {
  return {
    format: MIGRATION_FORMAT,
    version: MIGRATION_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: options.exportedBy || null,
    includeSecrets: options.includeSecrets === true,
    includeLogs: options.includeLogs === true,
    data: normalizeExportConfig(config, options),
  };
}

function migrationData(payload) {
  if (payload?.format === MIGRATION_FORMAT && payload?.data) return payload.data;
  return payload || {};
}

function validateConfigShape(data) {
  const errors = [];
  for (const key of CONFIG_ARRAYS) {
    if (data[key] !== undefined && !Array.isArray(data[key])) errors.push(`${key} 必须是数组`);
  }
  if (data.syncLogs !== undefined && !Array.isArray(data.syncLogs)) errors.push('syncLogs 必须是数组');
  return errors;
}

function summarizeItems(items = [], existingItems = []) {
  const existingIds = new Set(existingItems.map((item) => item.id).filter(Boolean));
  const incomingIds = new Set();
  let missingId = 0;
  let duplicateId = 0;
  let conflicts = 0;
  for (const item of items) {
    if (!item?.id) missingId += 1;
    else {
      if (incomingIds.has(item.id)) duplicateId += 1;
      incomingIds.add(item.id);
      if (existingIds.has(item.id)) conflicts += 1;
    }
  }
  return { count: items.length, missingId, duplicateId, conflicts };
}

export function previewConfigImport(payload, currentConfig = {}) {
  const data = migrationData(payload);
  const errors = validateConfigShape(data);
  const connections = data.connections || [];
  const syncTasks = data.syncTasks || [];
  const taskTemplates = data.taskTemplates || [];
  const syncLogs = data.syncLogs || [];
  const connectionIds = new Set(connections.map((conn) => conn.id).filter(Boolean));
  const warnings = [];

  for (const task of syncTasks) {
    const sourceId = task.sourceConnectionId || task.sourceId;
    const targetId = task.targetConnectionId || task.targetId;
    const existingSource = (currentConfig.connections || []).some((conn) => conn.id === sourceId && !conn.deletedAt);
    const existingTarget = (currentConfig.connections || []).some((conn) => conn.id === targetId && !conn.deletedAt);
    if (sourceId && !connectionIds.has(sourceId) && !existingSource) warnings.push(`任务「${task.name || task.id}」引用的源连接不在迁移包中`);
    if (targetId && !connectionIds.has(targetId) && !existingTarget) warnings.push(`任务「${task.name || task.id}」引用的目标连接不在迁移包中`);
  }

  const secretHints = connections.reduce((sum, conn) => {
    return sum + SECRET_FIELDS.filter((field) => conn[field] || conn[`has${field[0].toUpperCase()}${field.slice(1)}`]).length;
  }, 0);
  if (secretHints === 0) warnings.push('迁移包不包含连接密钥，导入后需要重新填写密码或 Token 并测试连接');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    package: {
      format: payload?.format || 'raw-config',
      version: payload?.version || null,
      exportedAt: payload?.exportedAt || null,
      includeSecrets: payload?.includeSecrets === true,
      includeLogs: payload?.includeLogs === true || Array.isArray(data.syncLogs),
    },
    summary: {
      connections: summarizeItems(connections, currentConfig.connections || []),
      syncTasks: summarizeItems(syncTasks, currentConfig.syncTasks || []),
      taskTemplates: summarizeItems(taskTemplates, currentConfig.taskTemplates || []),
      syncLogs: { count: syncLogs.length },
    },
  };
}

function mergeById(existing = [], incoming = []) {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    if (!item?.id) continue;
    byId.set(item.id, { ...byId.get(item.id), ...item });
  }
  return Array.from(byId.values());
}

function prepareImportedConfig(payload, currentConfig = {}, options = {}) {
  const mode = options.mode === 'replace' ? 'replace' : 'merge';
  const includeLogs = options.includeLogs === true;
  const disableImportedTasks = options.disableImportedTasks !== false;
  const data = clone(migrationData(payload)) || {};
  for (const task of data.syncTasks || []) {
    for (const field of RUNTIME_TASK_FIELDS) delete task[field];
    if (disableImportedTasks) {
      task.enabled = false;
      task.status = 'idle';
    }
  }
  const base = mode === 'replace'
    ? { connections: [], syncTasks: [], syncLogs: [], taskTemplates: [] }
    : clone(currentConfig);
  const next = {
    ...base,
    connections: mode === 'replace' ? (data.connections || []) : mergeById(base.connections || [], data.connections || []),
    syncTasks: mode === 'replace' ? (data.syncTasks || []) : mergeById(base.syncTasks || [], data.syncTasks || []),
    taskTemplates: mode === 'replace' ? (data.taskTemplates || []) : mergeById(base.taskTemplates || [], data.taskTemplates || []),
    syncLogs: includeLogs
      ? (mode === 'replace' ? (data.syncLogs || []) : [...(base.syncLogs || []), ...(data.syncLogs || [])].slice(-500))
      : (mode === 'replace' ? [] : (base.syncLogs || [])),
  };
  return next;
}

export function applyConfigImport(payload, currentConfig = {}, options = {}) {
  const preview = previewConfigImport(payload, currentConfig);
  if (!preview.valid) {
    const err = new Error(preview.errors.join('; '));
    err.preview = preview;
    throw err;
  }
  return {
    preview,
    config: prepareImportedConfig(payload, currentConfig, options),
  };
}

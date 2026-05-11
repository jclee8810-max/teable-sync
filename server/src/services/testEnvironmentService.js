const DEFAULT_BASELINE_NAMES = ['SalesDB', 'InventoryDB', 'HRDB', 'Teable'];

function normalizeList(value, fallback) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return fallback;
}

export function getBaselineConnectionNames() {
  return normalizeList(process.env.TEST_BASELINE_CONNECTION_NAMES, DEFAULT_BASELINE_NAMES);
}

function lower(value) {
  return String(value || '').toLowerCase();
}

function tempScore(value) {
  const text = lower(value);
  if (!text) return 0;
  const strong = [
    'ui-e2e-',
    'codex-e2e',
    'contract-',
    'ready-',
    'stale-',
    'expired-',
    'untested-',
    'failed-',
    'targeted-batch-',
    'codex-batch-',
    'codex-t2t-',
    'smoke-',
  ];
  if (strong.some((marker) => text.startsWith(marker) || text.includes(marker))) return 2;
  const names = ['legacy task', 'contract task', 'stale accepted task', 'ready sql', 'ready teable', 'untested sql', 'failed sql'];
  return names.some((marker) => text.includes(marker)) ? 1 : 0;
}

function isTemporaryItem(item) {
  return Math.max(tempScore(item?.id), tempScore(item?.name), tempScore(item?.email)) > 0;
}

function active(items = []) {
  return items.filter((item) => !item.deletedAt);
}

export function buildTestEnvironmentPlan(config, options = {}) {
  const baselineNames = normalizeList(options.baselineConnectionNames, getBaselineConnectionNames());
  const baselineSet = new Set(baselineNames.map((name) => lower(name)));
  const connections = config.connections || [];
  const tasks = config.syncTasks || [];
  const templates = config.taskTemplates || [];
  const logs = config.syncLogs || [];
  const activeTasks = active(tasks);
  const nonTemporaryActiveTasks = activeTasks.filter((task) => !isTemporaryItem(task));
  const protectedConnectionIds = new Set();
  for (const task of nonTemporaryActiveTasks) {
    if (task.sourceConnectionId || task.sourceId) protectedConnectionIds.add(task.sourceConnectionId || task.sourceId);
    if (task.targetConnectionId || task.targetId) protectedConnectionIds.add(task.targetConnectionId || task.targetId);
  }

  const baselineConnections = active(connections).filter((conn) => baselineSet.has(lower(conn.name)));
  const readyBaselineConnections = baselineConnections.filter((conn) => conn.lastTest?.success === true);
  const removableConnections = active(connections).filter((conn) => {
    if (baselineSet.has(lower(conn.name))) return false;
    if (protectedConnectionIds.has(conn.id)) return false;
    return isTemporaryItem(conn);
  });
  const blockedTemporaryConnections = active(connections).filter((conn) => isTemporaryItem(conn) && protectedConnectionIds.has(conn.id));
  const removableTasks = activeTasks.filter((task) => isTemporaryItem(task));
  const removableTemplates = active(templates).filter((template) => isTemporaryItem(template) || isTemporaryItem(template?.config));
  const tempTaskIds = new Set(removableTasks.map((task) => task.id));
  const removableLogs = logs.filter((log) => isTemporaryItem(log) || tempTaskIds.has(log.taskId));
  const maxLogs = Math.max(50, Math.min(500, Number(options.keepRecentLogs || 200) || 200));
  const overflowLogs = logs.length > maxLogs ? logs.slice(0, logs.length - maxLogs) : [];

  const warnings = [];
  if (baselineConnections.length === 0) warnings.push('未找到基准数据源，请确认 SalesDB / InventoryDB / HRDB / Teable 是否存在。');
  if (readyBaselineConnections.length < baselineConnections.length) warnings.push('部分基准数据源最近测试未通过，清理后仍需要重新测试。');
  if (blockedTemporaryConnections.length > 0) warnings.push(`${blockedTemporaryConnections.length} 个临时数据源被非临时任务引用，已跳过清理。`);

  return {
    generatedAt: new Date().toISOString(),
    baselineConnectionNames: baselineNames,
    summary: {
      activeConnections: active(connections).length,
      activeTasks: activeTasks.length,
      baselineConnections: baselineConnections.length,
      readyBaselineConnections: readyBaselineConnections.length,
      removableConnections: removableConnections.length,
      removableTasks: removableTasks.length,
      removableTemplates: removableTemplates.length,
      removableLogs: removableLogs.length + overflowLogs.length,
      blockedTemporaryConnections: blockedTemporaryConnections.length,
    },
    baselineConnections: baselineConnections.map((conn) => ({
      id: conn.id,
      name: conn.name,
      type: conn.type,
      host: conn.host,
      lastTest: conn.lastTest || null,
      ready: conn.lastTest?.success === true,
    })),
    removable: {
      connections: removableConnections.map((conn) => ({ id: conn.id, name: conn.name, type: conn.type, host: conn.host })),
      tasks: removableTasks.map((task) => ({ id: task.id, name: task.name, status: task.status, enabled: task.enabled === true })),
      templates: removableTemplates.map((template) => ({ id: template.id, name: template.name })),
      logs: removableLogs.length + overflowLogs.length,
    },
    blocked: {
      connections: blockedTemporaryConnections.map((conn) => ({ id: conn.id, name: conn.name })),
    },
    warnings,
  };
}

export function applyTestEnvironmentCleanup(config, options = {}) {
  const plan = buildTestEnvironmentPlan(config, options);
  const now = new Date().toISOString();
  const removableConnectionIds = new Set(plan.removable.connections.map((item) => item.id));
  const removableTaskIds = new Set(plan.removable.tasks.map((item) => item.id));
  const removableTemplateIds = new Set(plan.removable.templates.map((item) => item.id));

  for (const conn of config.connections || []) {
    if (removableConnectionIds.has(conn.id)) conn.deletedAt = conn.deletedAt || now;
  }
  for (const task of config.syncTasks || []) {
    if (removableTaskIds.has(task.id)) {
      task.deletedAt = task.deletedAt || now;
      task.enabled = false;
      task.status = 'idle';
    }
  }
  for (const template of config.taskTemplates || []) {
    if (removableTemplateIds.has(template.id)) template.deletedAt = template.deletedAt || now;
  }

  const keepRecentLogs = Math.max(50, Math.min(500, Number(options.keepRecentLogs || 200) || 200));
  config.syncLogs = (config.syncLogs || [])
    .filter((log) => !isTemporaryItem(log) && !removableTaskIds.has(log.taskId))
    .slice(-keepRecentLogs);

  const removedAlertStates = [];
  const alertStates = config.alertStates || {};
  config.alertStates = {};
  for (const [id, state] of Object.entries(alertStates)) {
    if (Array.from(removableTaskIds).some((taskId) => id.includes(taskId))) {
      removedAlertStates.push(id);
    } else {
      config.alertStates[id] = state;
    }
  }

  return {
    ...plan,
    appliedAt: now,
    applied: true,
    removed: {
      connections: removableConnectionIds.size,
      tasks: removableTaskIds.size,
      templates: removableTemplateIds.size,
      logs: plan.removable.logs,
      alertStates: removedAlertStates.length,
    },
  };
}

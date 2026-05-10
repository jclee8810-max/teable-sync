import { getSyncFailureCounts } from './syncFailures.js';
import { getSyncHistory } from './syncHistory.js';
import { getTaskHealth } from './taskHealth.js';
import { isAdmin } from './roles.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function toTime(value) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function isAutoSyncMode(mode) {
  return ['scheduled', 'realtime', 'incremental'].includes(mode || 'manual');
}

function alert(id, severity, type, title, message, task = null, metadata = {}) {
  return {
    id,
    severity,
    type,
    title,
    message,
    taskId: task?.id || null,
    taskName: task?.name || null,
    createdAt: new Date().toISOString(),
    metadata,
  };
}

function decorateAlertState(item, alertStates = {}, now = Date.now()) {
  const state = alertStates?.[item.id] || {};
  const mutedUntilMs = toTime(state.mutedUntil);
  const muted = mutedUntilMs && mutedUntilMs > now;
  const acknowledged = Boolean(state.acknowledgedAt);
  return {
    ...item,
    state: muted ? 'muted' : acknowledged ? 'acknowledged' : 'open',
    acknowledgedAt: state.acknowledgedAt || null,
    acknowledgedBy: state.acknowledgedBy || null,
    mutedUntil: muted ? state.mutedUntil : null,
    mutedBy: muted ? state.mutedBy || null : null,
  };
}

function visibleLogs(config, user) {
  const logs = Array.isArray(config.syncLogs) ? config.syncLogs : [];
  if (isAdmin(user)) return logs;
  return logs.filter((log) => !log.userId || log.userId === user.id);
}

function visibleConnections(config, user, tasks) {
  const ids = new Set();
  for (const task of tasks) {
    if (task.sourceConnectionId || task.sourceId) ids.add(task.sourceConnectionId || task.sourceId);
    if (task.targetConnectionId || task.targetId) ids.add(task.targetConnectionId || task.targetId);
  }
  return (config.connections || []).filter((conn) => {
    if (conn.deletedAt) return false;
    return isAdmin(user) || conn.ownerId === user.id || conn.shared === true || ids.has(conn.id);
  });
}

function latestRunTime(task, health) {
  return toTime(health.latestRunAt || task.lastSyncAt);
}

function buildTaskAlertSet(task, health, schedulerStatus, runState) {
  const alerts = [];
  const pendingFailures = Number(health.pendingFailureRows || 0);
  const autoMode = isAutoSyncMode(task.syncMode);
  const intervalSec = Number(task.syncInterval || 300);
  const schedule = schedulerStatus[task.id];

  if (task.connectionStatus?.issues?.length) {
    for (const issue of task.connectionStatus.issues) {
      alerts.push(alert(
        `task-${task.id}-connection-${issue.field}`,
        issue.level === 'error' ? 'critical' : 'warning',
        'connection',
        '连接状态异常',
        issue.message,
        task,
        {
          field: issue.field,
          errorType: 'connection',
          suggestedAction: '前往数据源页面重新测试连接；如果失败，请修复地址、账号、密码或 Token。',
          actionTarget: 'connections',
        },
      ));
    }
  }

  if (pendingFailures > 0) {
    alerts.push(alert(
      `task-${task.id}-pending-failures`,
      'critical',
      'sync_failure',
      '存在待处理失败批次',
      `还有 ${pendingFailures} 个失败批次未重试或清理`,
      task,
      {
        pendingFailures,
        errorType: 'failure_batch',
        suggestedAction: '打开失败批次页面，先重试单批；确认无效数据后再清理记录。',
        actionTarget: 'task_failures',
      },
    ));
  }

  if (health.latestStatus === 'failed') {
    alerts.push(alert(
      `task-${task.id}-latest-failed`,
      'critical',
      'recent_failed',
      '最近一次同步失败',
      health.latestError || '最近一次同步失败，请查看任务日志',
      task,
      {
        latestRunId: health.latestRunId,
        errorType: health.latestErrorType,
        errorSummary: health.latestErrorSummary,
        suggestedAction: health.latestSuggestedAction,
        actionTarget: health.latestActionTarget,
      },
    ));
  }

  if (health.successRate !== null && health.recentRuns >= 5 && health.successRate < 80) {
    alerts.push(alert(
      `task-${task.id}-low-success-rate`,
      'warning',
      'low_success_rate',
      '近期成功率偏低',
      `最近 ${health.recentRuns} 次完成运行成功率为 ${health.successRate}%`,
      task,
      { successRate: health.successRate, recentRuns: health.recentRuns },
    ));
  }

  if (autoMode && task.enabled && !schedule) {
    alerts.push(alert(
      `task-${task.id}-scheduler-missing`,
      'critical',
      'scheduler_missing',
      '自动任务未进入调度器',
      '任务已启用自动同步，但当前调度器没有对应实例',
      task,
    ));
  }

  if (autoMode && task.enabled) {
    const lastRun = latestRunTime(task, health);
    const staleMs = Math.max(intervalSec * 2500, 30 * 60 * 1000);
    if (!lastRun) {
      alerts.push(alert(
        `task-${task.id}-never-ran`,
        'warning',
        'never_ran',
        '自动任务尚未产生运行记录',
        '任务已启用自动同步，但还没有成功或失败的运行记录',
        task,
      ));
    } else if (Date.now() - lastRun > staleMs) {
      alerts.push(alert(
        `task-${task.id}-stale`,
        'warning',
        'stale_task',
        '自动任务长时间未同步',
        `距离最近一次运行已超过 ${Math.round((Date.now() - lastRun) / 60000)} 分钟`,
        task,
        { staleMinutes: Math.round((Date.now() - lastRun) / 60000), intervalSec },
      ));
    }
  }

  if (['running', 'cancelling'].includes(runState?.status)) {
    const startedAt = toTime(runState.startedAt);
    const maxRunMs = Math.max(intervalSec * 2000, 15 * 60 * 1000);
    if (startedAt && Date.now() - startedAt > maxRunMs) {
      alerts.push(alert(
        `task-${task.id}-long-running`,
        'warning',
        'long_running',
        '同步运行时间偏长',
        `本次运行已持续 ${Math.round((Date.now() - startedAt) / 60000)} 分钟`,
        task,
        { runningMinutes: Math.round((Date.now() - startedAt) / 60000) },
      ));
    }
  }

  if (task.schemaSnapshotError) {
    alerts.push(alert(
      `task-${task.id}-schema-snapshot`,
      'warning',
      'schema_snapshot',
      '字段快照失败',
      task.schemaSnapshotError,
      task,
    ));
  }

  return alerts;
}

export function buildObservabilitySnapshot({ config, user, tasks, schedulerStatus = {}, runStates = {}, version = {}, alertStates = {} }) {
  const now = Date.now();
  const logs = visibleLogs(config, user);
  const recentLogs = logs
    .slice(-200)
    .reverse()
    .filter((log) => ['warn', 'error'].includes(log.level))
    .slice(0, 30);
  const errorLogs24h = logs.filter((log) => log.level === 'error' && toTime(log.ts) && now - toTime(log.ts) <= DAY_MS).length;
  const warningLogs24h = logs.filter((log) => log.level === 'warn' && toTime(log.ts) && now - toTime(log.ts) <= DAY_MS).length;
  const history = getSyncHistory(null, 1000).filter((record) => tasks.some((task) => task.id === record.taskId));
  const completed = history.filter((record) => record.status !== 'running');
  const recent24h = completed.filter((record) => toTime(record.endTime || record.startTime) && now - toTime(record.endTime || record.startTime) <= DAY_MS);
  const successes24h = recent24h.filter((record) => record.status === 'success').length;
  const failedRuns24h = recent24h.filter((record) => record.status === 'failed').length;
  const durations = completed.map((record) => Number(record.durationMs || 0)).filter((value) => value > 0);
  const failureCounts = getSyncFailureCounts();
  const taskHealth = {};
  const taskRows = [];
  const alerts = [];

  for (const task of tasks) {
    const health = getTaskHealth(task);
    const runState = runStates[task.id] || null;
    taskHealth[task.id] = health;
    alerts.push(...buildTaskAlertSet(task, health, schedulerStatus, runState));
    taskRows.push({
      id: task.id,
      name: task.name,
      status: task.status,
      enabled: task.enabled === true,
      syncMode: task.syncMode || 'manual',
      intervalSec: task.syncInterval || 300,
      schedulerActive: Boolean(schedulerStatus[task.id]),
      running: ['running', 'cancelling'].includes(runState?.status) || task.status === 'running',
      health,
      pendingFailures: failureCounts[task.id] || 0,
      connectionOk: task.connectionStatus?.ok !== false,
      lastSyncAt: task.lastSyncAt || health.latestRunAt || null,
    });
  }

  for (const conn of visibleConnections(config, user, tasks)) {
    if (conn.lastTest?.success === false) {
      alerts.push(alert(
        `connection-${conn.id}-last-test`,
        'critical',
        'connection_test',
        '连接最近测试失败',
        `${conn.name || conn.id}: ${conn.lastTest.error || '未知错误'}`,
        null,
        {
          connectionId: conn.id,
          connectionName: conn.name || conn.id,
          errorType: 'connection',
          suggestedAction: '前往数据源页面重新测试连接；如果失败，请修复地址、账号、密码或 Token。',
          actionTarget: 'connections',
        },
      ));
    }
  }

  const decoratedAlerts = alerts.map((item) => decorateAlertState(item, alertStates, now));
  decoratedAlerts.sort((a, b) => {
    const stateRank = { open: 0, acknowledged: 1, muted: 2 };
    const rank = { critical: 0, warning: 1, info: 2 };
    return (stateRank[a.state] ?? 9) - (stateRank[b.state] ?? 9)
      || (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)
      || String(a.taskName || '').localeCompare(String(b.taskName || ''));
  });

  const activeAlerts = decoratedAlerts.filter((item) => item.state === 'open');
  const scheduledTasks = tasks.filter((task) => isAutoSyncMode(task.syncMode)).length;
  const activeSchedules = Object.keys(schedulerStatus).filter((taskId) => tasks.some((task) => task.id === taskId)).length;
  const runningTasks = taskRows.filter((task) => task.running).length;
  const unhealthyTasks = taskRows.filter((task) => ['has_failures', 'recent_failed'].includes(task.health.status) || !task.connectionOk).length;
  const pendingFailureRows = Object.entries(failureCounts)
    .filter(([taskId]) => tasks.some((task) => task.id === taskId))
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    version,
    summary: {
      totalTasks: tasks.length,
      scheduledTasks,
      activeSchedules,
      runningTasks,
      unhealthyTasks,
      openAlerts: decoratedAlerts.length,
      activeAlerts: activeAlerts.length,
      acknowledgedAlerts: decoratedAlerts.filter((item) => item.state === 'acknowledged').length,
      mutedAlerts: decoratedAlerts.filter((item) => item.state === 'muted').length,
      criticalAlerts: activeAlerts.filter((item) => item.severity === 'critical').length,
      warningAlerts: activeAlerts.filter((item) => item.severity === 'warning').length,
      runs24h: recent24h.length,
      successes24h,
      failedRuns24h,
      successRate24h: recent24h.length ? Math.round((successes24h / recent24h.length) * 100) : null,
      errorLogs24h,
      warningLogs24h,
      pendingFailureRows,
      averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    },
    alerts: decoratedAlerts,
    tasks: taskRows.sort((a, b) => {
      const aTime = toTime(a.lastSyncAt) || 0;
      const bTime = toTime(b.lastSyncAt) || 0;
      return bTime - aTime;
    }),
    recentLogs,
  };
}

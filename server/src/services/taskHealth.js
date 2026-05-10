import { getSyncHistory } from './syncHistory.js';
import { getSyncFailureCounts } from './syncFailures.js';

function healthStatus(task, recent, pendingFailures) {
  if (task.deletedAt) return 'deleted';
  if (!recent.length) return 'never_run';
  const latest = recent[0];
  if (pendingFailures > 0) return 'has_failures';
  if (latest.status === 'success') return 'healthy';
  if (latest.status === 'cancelled') return 'cancelled';
  if (latest.status === 'paused') return 'paused';
  if (latest.status === 'failed') return 'recent_failed';
  if (latest.status === 'running') return 'running';
  return 'unknown';
}

export function getTaskHealth(task, limit = 20) {
  const recent = getSyncHistory(task.id, limit);
  const completed = recent.filter((r) => r.status !== 'running');
  const successes = completed.filter((r) => r.status === 'success');
  const failures = completed.filter((r) => r.status === 'failed');
  const cancelled = completed.filter((r) => r.status === 'cancelled');
  const paused = completed.filter((r) => r.status === 'paused');
  const durations = completed.map((r) => Number(r.durationMs || 0)).filter((n) => n > 0);
  const failureCounts = getSyncFailureCounts();
  const pendingFailures = failureCounts[task.id] || 0;
  const latest = recent[0] || null;

  return {
    taskId: task.id,
    taskName: task.name,
    status: healthStatus(task, recent, pendingFailures),
    latestStatus: latest?.status || 'never_run',
    latestRunId: latest?.runId || latest?.id || null,
    latestTrigger: latest?.trigger || 'unknown',
    latestRunAt: latest?.endTime || latest?.startTime || null,
    latestError: latest?.errorMessage || null,
    latestErrorType: latest?.errorType || null,
    latestErrorSummary: latest?.errorSummary || null,
    latestSuggestedAction: latest?.suggestedAction || null,
    latestActionTarget: latest?.actionTarget || null,
    latestDurationMs: latest?.durationMs || 0,
    successRate: completed.length ? Math.round((successes.length / completed.length) * 100) : null,
    recentRuns: completed.length,
    successCount: successes.length,
    failureCount: failures.length,
    cancelledCount: cancelled.length,
    pausedCount: paused.length,
    pendingFailureRows: pendingFailures,
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length) : 0,
  };
}

export function getTaskHealthMap(tasks, limit = 20) {
  const result = {};
  for (const task of tasks) {
    result[task.id] = getTaskHealth(task, limit);
  }
  return result;
}

export const AUTO_SYNC_MODES = ['scheduled', 'realtime', 'incremental']
export const RUN_ACTIONS = ['manualRun', 'restartFullSync', 'continueInitialization']
export const ACTIVE_RUN_STATUSES = ['running', 'queued']
export const ACTIVE_PROGRESS_STATUSES = ['running', 'queued', 'cancelling']

export function isAutoSyncMode(mode) {
  return AUTO_SYNC_MODES.includes(mode || 'manual')
}

export function isRealtimeTask(task) {
  return (task?.syncMode || 'manual') === 'realtime'
}

export function idOf(entity) {
  return typeof entity === 'object' ? entity?.id : entity
}

export function actionKey(entity, action) {
  const id = idOf(entity)
  return id ? `${id}:${action}` : ''
}

export function isActionBusy(locks = {}, entity, action) {
  return Boolean(locks[actionKey(entity, action)])
}

export function setActionBusy(locks = {}, entity, action, busy) {
  const key = actionKey(entity, action)
  if (!key) return locks
  const next = { ...locks }
  if (busy) next[key] = true
  else delete next[key]
  return next
}

export function getTaskProgress(task, progressByTask = {}) {
  return task?.id ? progressByTask[task.id] : null
}

export function isTaskRunning(task, progressByTask = {}) {
  if (!task?.id) return false
  const progress = getTaskProgress(task, progressByTask)
  return ACTIVE_RUN_STATUSES.includes(task.status)
    || Boolean(task._running)
    || ACTIVE_PROGRESS_STATUSES.includes(progress?.status)
}

export function isCancellingTask(task, progressByTask = {}) {
  return getTaskProgress(task, progressByTask)?.status === 'cancelling'
}

export function isRunActionPending(task, locks = {}) {
  return RUN_ACTIONS.some(action => isActionBusy(locks, task, action))
}

export function isDetailTask(task, detailTask) {
  return Boolean(task?.id && detailTask?.id === task.id)
}

export function hasKnownInitializationCheckpoint(task, detailTask, initializationState) {
  return !isDetailTask(task, detailTask) || initializationState?.hasCheckpoint === true
}

export function buildTaskUiState(task, context = {}) {
  const {
    progressByTask = {},
    schedulerStatus = {},
    actionLocks = {},
    detailTask = null,
    initializationState = null,
  } = context

  const connectionOk = task?.connectionStatus?.ok === true
  const running = isTaskRunning(task, progressByTask)
  const cancelling = isCancellingTask(task, progressByTask)
  const runActionPending = isRunActionPending(task, actionLocks)
  const realtime = isRealtimeTask(task)
  const autoSync = isAutoSyncMode(task?.syncMode)
  const scheduled = Boolean(task?.id && schedulerStatus[task.id]) || task?.status === 'scheduled'
  const hasCheckpoint = hasKnownInitializationCheckpoint(task, detailTask, initializationState)

  let manualRunTitle = '立即执行一次同步'
  if (realtime) manualRunTitle = '准实时同步任务由启动/停止调度控制，不支持手动同步'
  else if (!connectionOk) manualRunTitle = '连接异常，需先修复数据源后再同步'
  else if (runActionPending) manualRunTitle = '同步启动请求处理中'
  else if (running) manualRunTitle = '任务正在同步或排队中'

  return {
    autoSync,
    realtime,
    scheduled,
    connectionOk,
    running,
    cancelling,
    runActionPending,
    manualRunDisabled: realtime || runActionPending || running || !connectionOk,
    manualRunTitle,
    restartFullSyncDisabled: !connectionOk || running || runActionPending,
    continueInitializationDisabled: !connectionOk || !hasCheckpoint || running || runActionPending,
    scheduleActionDisabled: !autoSync || isActionBusy(actionLocks, task, 'schedule') || running || !connectionOk,
    cancelDisabled: isActionBusy(actionLocks, task, 'cancel') || cancelling,
    previewDisabled: isActionBusy(actionLocks, task, 'preview'),
    preflightDisabled: isActionBusy(actionLocks, task, 'preflight'),
    schemaDriftDisabled: isActionBusy(actionLocks, task, 'schemaDrift'),
    reconcileDisabled: isActionBusy(actionLocks, task, 'reconcile'),
    copyDisabled: isActionBusy(actionLocks, task, 'copy'),
    saveTemplateDisabled: isActionBusy(actionLocks, task, 'saveTemplate'),
    deleteDisabled: isActionBusy(actionLocks, task, 'delete'),
  }
}

<template>
  <div class="tasks-page">
    <div class="task-overview">
      <button class="summary-tile" :class="{ active: taskFilter === 'all' }" type="button" @click="taskFilter = 'all'">
        <span>全部任务</span>
        <strong>{{ taskSummary.total }}</strong>
      </button>
      <button class="summary-tile" :class="{ active: taskFilter === 'attention' }" type="button" @click="taskFilter = 'attention'">
        <span>需要处理</span>
        <strong>{{ taskSummary.attention }}</strong>
      </button>
      <button class="summary-tile" :class="{ active: taskFilter === 'running' }" type="button" @click="taskFilter = 'running'">
        <span>运行中</span>
        <strong>{{ taskSummary.running }}</strong>
      </button>
      <button class="summary-tile" :class="{ active: taskFilter === 'scheduled' }" type="button" @click="taskFilter = 'scheduled'">
        <span>已调度</span>
        <strong>{{ taskSummary.scheduled }}</strong>
      </button>
    </div>

    <div class="task-toolbar">
      <el-input
        v-model="taskSearch"
        class="task-search"
        clearable
        placeholder="搜索任务、连接或表名"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
      <button class="fs-btn fs-btn-primary" @click="openDialog()">
        <el-icon><Plus /></el-icon>新建任务
      </button>
      <button class="fs-btn fs-btn-ghost" @click="openTemplateDialog">
        从模板
      </button>
    </div>

    <div class="task-list" v-if="filteredTasks.length > 0">
      <div v-for="task in filteredTasks" :key="task.id" class="fs-card task-card" :class="{ attention: taskNeedsAttention(task), invalid: !task.connectionStatus?.ok, running: isTaskRunning(task) }">
        <div class="task-card-top">
          <div class="task-info">
            <div class="task-name">{{ task.name }}</div>
            <div class="task-flow">
              <span class="flow-source">{{ connName(task.sourceConnectionId) }}</span>
              <span class="flow-arrow">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M4 10H14M14 10L10 6M14 10L10 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
              <span class="flow-target">{{ connName(task.targetConnectionId) }}</span>
            </div>
          </div>
          <div class="task-actions">
            <div class="task-badges">
              <span v-if="taskHealth[task.id]" class="health-badge" :class="taskHealth[task.id].status">{{ healthLabel(taskHealth[task.id].status) }}</span>
              <span v-if="!task.connectionStatus?.ok" class="health-badge invalid">连接异常</span>
              <span class="status-badge" :class="statusClass(task.status)">{{ statusLabel(task.status) }}</span>
            </div>
            <div class="task-primary-actions">
              <button class="fs-btn fs-btn-ghost" @click="openTaskDetail(task)">
                <el-icon><View /></el-icon>详情
              </button>
              <button class="fs-btn fs-btn-primary" @click="manualRun(task)" :disabled="isManualRunDisabled(task)" :title="manualRunTitle(task)">
                <el-icon v-if="!isRunActionPending(task) && !task._running && task.status !== 'running'"><VideoPlay /></el-icon>
                <el-icon v-else class="is-loading"><Loading /></el-icon>
                {{ (isRunActionPending(task) || task._running || task.status === 'running') ? '同步中' : '同步' }}
              </button>
              <button v-if="isTaskRunning(task)" class="fs-btn fs-btn-danger" @click="cancelRunningTask(task)" :disabled="isTaskActionBusy(task, 'cancel') || isCancellingTask(task)">
                {{ (isTaskActionBusy(task, 'cancel') || isCancellingTask(task)) ? '取消中' : '取消' }}
              </button>
              <button v-else-if="isAutoSyncMode(task.syncMode)" class="fs-btn" :class="schedulerStatus[task.id] ? 'fs-btn-danger' : 'fs-btn-success'" @click="toggleSync(task)" :disabled="isScheduleActionDisabled(task)">
                {{ isTaskActionBusy(task, 'schedule') ? '处理中' : (schedulerStatus[task.id] ? '停止调度' : '启动调度') }}
              </button>
              <button v-if="failureCounts[task.id]" class="fs-btn fs-btn-danger" @click="openFailures(task)">
                失败 {{ failureCounts[task.id] }}
              </button>
              <el-dropdown trigger="click">
                <button class="fs-btn fs-btn-ghost more-action" type="button">更多</button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click="restartFullSync(task)" :disabled="isRestartFullSyncDisabled(task)">重跑全量</el-dropdown-item>
                    <el-dropdown-item @click="continueInitialization(task)" :disabled="isContinueInitializationDisabled(task)">继续初始化</el-dropdown-item>
                    <el-dropdown-item divided @click="handlePreview(task.id)" :disabled="isTaskActionBusy(task, 'preview')">预览数据</el-dropdown-item>
                    <el-dropdown-item @click="runPreflight(task)" :disabled="preflightLoading || isTaskActionBusy(task, 'preflight')">预检</el-dropdown-item>
                    <el-dropdown-item @click="checkSchemaDrift(task)" :disabled="schemaDriftLoading || isTaskActionBusy(task, 'schemaDrift')">字段变更</el-dropdown-item>
                    <el-dropdown-item @click="runReconcile(task)" :disabled="reconcileLoading || isTaskActionBusy(task, 'reconcile')">一致性校验</el-dropdown-item>
                    <el-dropdown-item @click="openTaskLogs(task)">近期日志</el-dropdown-item>
                    <el-dropdown-item divided @click="duplicateTask(task)" :disabled="copyingTaskId === task.id || isTaskActionBusy(task, 'copy')">复制任务</el-dropdown-item>
                    <el-dropdown-item @click="saveTaskAsTemplate(task)" :disabled="templateSavingId === task.id || isTaskActionBusy(task, 'saveTemplate')">存为模板</el-dropdown-item>
                    <el-dropdown-item @click="openDialog(task)" :disabled="!isOwner(task)">编辑配置</el-dropdown-item>
                    <el-dropdown-item @click="removeTask(task.id)" :disabled="!isOwner(task) || isTaskActionBusy(task, 'delete')">删除任务</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </div>
          </div>
        </div>

        <div class="task-card-summary">
          <div class="summary-row">
            <span><strong>源表</strong>{{ task.sourceTable || '-' }}</span>
            <span><strong>模式</strong>{{ compactSyncLabel(task) }}</span>
            <span><strong>最近</strong>{{ latestRunLabel(task) }}</span>
            <span v-if="taskHealth[task.id]"><strong>成功率</strong>{{ healthRate(taskHealth[task.id]) }}</span>
          </div>
          <div v-if="task.connectionStatus?.issues?.length" class="connection-issues">
            <span v-for="issue in task.connectionStatus.issues" :key="issue.field + issue.message" :class="['connection-issue', issue.level]">
              {{ issue.message }}
            </span>
          </div>
          <div v-if="taskHealth[task.id]?.latestError || task.schemaSnapshotError" class="task-warning-line">
            <span v-if="taskHealth[task.id]?.latestError" :title="taskHealth[task.id].latestError">最近错误：{{ latestErrorLabel(task) }}</span>
            <span v-if="latestSuggestedAction(task)" class="task-suggestion-line" :title="latestSuggestedAction(task)">建议：{{ latestSuggestedAction(task) }}</span>
            <button v-if="latestSuggestedAction(task)" class="inline-action-btn" type="button" @click="resolveTaskGuidance(task)">
              {{ guidanceActionLabel(latestActionTarget(task)) }}
            </button>
            <span v-if="task.schemaSnapshotError" :title="task.schemaSnapshotError">字段快照失败：{{ task.schemaSnapshotError }}</span>
          </div>
          <div v-if="taskProgress[task.id] && taskProgress[task.id].status !== 'idle'" class="progress-panel">
            <div class="progress-line">
              <span class="progress-phase">{{ progressPhaseLabel(taskProgress[task.id].phase) }}</span>
              <span class="progress-meta">{{ progressSummary(taskProgress[task.id]) }}</span>
            </div>
            <el-progress
              :percentage="progressPercent(taskProgress[task.id])"
              :indeterminate="['running', 'queued', 'cancelling'].includes(taskProgress[task.id].status)"
              :status="progressStatus(taskProgress[task.id])"
              :stroke-width="8"
            />
          </div>
        </div>
      </div>
    </div>

    <el-empty v-if="tasks.length === 0" description="暂无同步任务" />
    <el-empty v-else-if="filteredTasks.length === 0" description="没有匹配的任务" />

    <el-dialog
      v-model="taskDetailDialogVisible"
      :title="detailTask ? `任务详情 · ${detailTask.name}` : '任务详情'"
      width="min(1120px, 92vw)"
      top="5vh"
      destroy-on-close
      class="task-detail-dialog"
    >
      <div v-if="detailTask" class="task-detail-shell">
        <div class="detail-hero">
          <div>
            <div class="detail-hero-title">{{ detailTask.name }}</div>
            <div class="detail-hero-flow">
              <span>{{ connName(detailTask.sourceConnectionId || detailTask.sourceId) }}</span>
              <span class="flow-arrow-inline">→</span>
              <span>{{ connName(detailTask.targetConnectionId || detailTask.targetId) }}</span>
            </div>
          </div>
          <div class="detail-hero-badges">
            <span v-if="taskHealth[detailTask.id]" class="health-badge" :class="taskHealth[detailTask.id].status">{{ healthLabel(taskHealth[detailTask.id].status) }}</span>
            <span v-if="!detailTask.connectionStatus?.ok" class="health-badge invalid">连接异常</span>
            <span class="status-badge" :class="statusClass(detailTask.status)">{{ statusLabel(detailTask.status) }}</span>
          </div>
        </div>

        <el-tabs class="detail-tabs">
          <el-tab-pane label="概览">
            <div class="detail-panel-grid">
              <div class="detail-metric" :class="runStateClass(detailTask)">
                <span>当前运行</span>
                <strong>{{ runStateLabel(detailTask) }}</strong>
              </div>
              <div class="detail-metric" :class="scheduleStateClass(detailTask)">
                <span>调度状态</span>
                <strong>{{ scheduleStateLabel(detailTask) }}</strong>
              </div>
              <div class="detail-metric" :class="latestStateClass(detailTask)">
                <span>最近结果</span>
                <strong>{{ latestRunLabel(detailTask) }}</strong>
              </div>
              <div class="detail-metric">
                <span>失败批次</span>
                <strong>{{ failureCounts[detailTask.id] || 0 }}</strong>
              </div>
            </div>

            <div v-if="taskProgress[detailTask.id] && taskProgress[detailTask.id].status !== 'idle'" class="progress-panel detail-progress">
              <div class="progress-line">
                <span class="progress-phase">{{ progressPhaseLabel(taskProgress[detailTask.id].phase) }}</span>
                <span class="progress-meta">{{ progressSummary(taskProgress[detailTask.id]) }}</span>
              </div>
              <el-progress
                :percentage="progressPercent(taskProgress[detailTask.id])"
                :indeterminate="['running', 'queued', 'cancelling'].includes(taskProgress[detailTask.id].status)"
                :status="progressStatus(taskProgress[detailTask.id])"
                :stroke-width="8"
              />
            </div>

            <div v-if="taskInitialization?.hasCheckpoint" class="detail-section init-resume-box">
              <div class="detail-section-bar">
                <div class="detail-section-title">初始化断点</div>
                <button class="fs-btn fs-btn-ghost" style="padding:6px 12px;font-size:12px" @click="refreshTaskInitialization" :disabled="taskInitializationLoading">
                  刷新
                </button>
              </div>
              <div class="detail-kv-grid">
                <div><span>已处理</span><strong>{{ formatNumber(taskInitialization.checkpoint?.processedRows || 0) }} 行</strong></div>
                <div><span>最近批次</span><strong>{{ taskInitialization.checkpoint?.batchNo || '-' }}</strong></div>
                <div><span>最近保存</span><strong>{{ formatTime(taskInitialization.checkpoint?.savedAt) }}</strong></div>
                <div><span>水位策略</span><strong>{{ watermarkLabel(taskInitialization.watermarkType) }}</strong></div>
              </div>
              <div class="detail-action-row">
                <button class="fs-btn fs-btn-primary" @click="continueInitialization(detailTask)" :disabled="isContinueInitializationDisabled(detailTask)">
                  {{ isTaskActionBusy(detailTask, 'continueInitialization') ? '继续中' : '继续初始化' }}
                </button>
                <button class="fs-btn fs-btn-ghost" @click="restartFullSync(detailTask)" :disabled="isRestartFullSyncDisabled(detailTask)">
                  {{ isTaskActionBusy(detailTask, 'restartFullSync') ? '启动中' : '重新开始全量' }}
                </button>
              </div>
            </div>

            <div class="detail-section">
              <div class="detail-section-title">运行健康</div>
              <div v-if="taskHealth[detailTask.id]" class="detail-kv-grid">
                <div><span>成功率</span><strong>{{ healthRate(taskHealth[detailTask.id]) }}</strong></div>
                <div><span>平均耗时</span><strong>{{ formatDuration(taskHealth[detailTask.id].averageDurationMs) }}</strong></div>
                <div><span>最近状态</span><strong>{{ latestStatusLabel(taskHealth[detailTask.id].latestStatus) }}</strong></div>
                <div><span>最近运行</span><strong>{{ taskHealth[detailTask.id].latestRunAt ? formatTime(taskHealth[detailTask.id].latestRunAt) : '-' }}</strong></div>
                <div><span>最近触发</span><strong>{{ triggerLabel(taskHealth[detailTask.id].latestTrigger) }}</strong></div>
                <div><span>最近 Run ID</span><strong>{{ shortRunId(taskHealth[detailTask.id].latestRunId) }}</strong></div>
              </div>
              <div v-else class="detail-empty-line">暂无健康数据</div>
              <div v-if="taskHealth[detailTask.id]?.latestError" class="detail-error-line">
                <div>{{ latestErrorLabel(detailTask) }}</div>
                <div v-if="latestSuggestedAction(detailTask)" class="detail-suggestion-line">
                  <span>建议：{{ latestSuggestedAction(detailTask) }}</span>
                  <button class="inline-action-btn" type="button" @click="resolveTaskGuidance(detailTask)">
                    {{ guidanceActionLabel(latestActionTarget(detailTask)) }}
                  </button>
                </div>
              </div>
            </div>

            <div class="detail-section">
              <div class="detail-section-title">连接状态</div>
              <div v-if="detailTask.connectionStatus?.issues?.length" class="connection-issues">
                <span v-for="issue in detailTask.connectionStatus.issues" :key="issue.field + issue.message" :class="['connection-issue', issue.level]">
                  {{ issue.message }}
                </span>
              </div>
              <div v-else class="detail-empty-line">源端和目标端连接未发现异常</div>
            </div>
          </el-tab-pane>

          <el-tab-pane label="运行历史">
            <div class="detail-section">
              <div class="detail-section-bar">
                <div class="detail-section-title">最近运行趋势</div>
                <button class="fs-btn fs-btn-ghost" style="padding:6px 12px;font-size:12px" @click="refreshTaskHistory" :disabled="taskHistoryLoading">
                  刷新
                </button>
              </div>
              <div class="detail-panel-grid history-metrics">
                <div class="detail-metric">
                  <span>最近运行</span>
                  <strong>{{ taskHistorySummary.total }}</strong>
                </div>
                <div class="detail-metric success">
                  <span>成功</span>
                  <strong>{{ taskHistorySummary.success }}</strong>
                </div>
                <div class="detail-metric neutral">
                  <span>无变更</span>
                  <strong>{{ taskHistorySummary.noop }}</strong>
                </div>
                <div class="detail-metric danger">
                  <span>失败/取消</span>
                  <strong>{{ taskHistorySummary.failed }}</strong>
                </div>
                <div class="detail-metric">
                  <span>平均耗时</span>
                  <strong>{{ formatDuration(taskHistorySummary.averageDurationMs) }}</strong>
                </div>
              </div>
              <div class="run-trend" v-if="taskHistory.length">
                <span
                  v-for="run in taskHistory.slice().reverse()"
                  :key="run.id"
                  :class="['run-dot', normalizedRunStatus(run)]"
                  :title="`${runStatusLabel(run)} · ${triggerLabel(run.trigger)} · ${formatTime(run.endTime || run.startTime)}`"
                ></span>
              </div>
            </div>

            <div class="detail-section">
              <div class="detail-section-title">运行记录</div>
              <div v-if="taskHistoryLoading" style="text-align:center;padding:32px">
                <el-icon class="is-loading" :size="24"><Loading /></el-icon>
              </div>
              <el-table v-else :data="taskHistory" size="small" border max-height="420" empty-text="暂无运行历史">
                <el-table-column label="Run ID" width="110">
                  <template #default="{ row }">{{ shortRunId(row.runId || row.id) }}</template>
                </el-table-column>
                <el-table-column label="触发" width="100">
                  <template #default="{ row }">{{ triggerLabel(row.trigger) }}</template>
                </el-table-column>
                <el-table-column label="状态" width="100">
                  <template #default="{ row }">
                    <el-tag size="small" :type="runStatusTagType(row)">{{ runStatusLabel(row) }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="开始时间" width="170">
                  <template #default="{ row }">{{ formatTime(row.startTime) }}</template>
                </el-table-column>
                <el-table-column label="耗时" width="90">
                  <template #default="{ row }">{{ formatDuration(row.durationMs) }}</template>
                </el-table-column>
                <el-table-column label="处理/新增/更新/跳过/失败" min-width="190">
                  <template #default="{ row }">
                    {{ formatNumber(row.sourceRows || 0) }} / {{ formatNumber(row.inserted || 0) }} / {{ formatNumber(row.updated || 0) }} / {{ formatNumber(row.skipped || 0) }} / {{ formatNumber(row.failed || 0) }}
                  </template>
                </el-table-column>
                <el-table-column label="删除" width="110">
                  <template #default="{ row }">{{ formatNumber((row.deleted || 0) + (row.softDeleted || 0)) }}</template>
                </el-table-column>
                <el-table-column prop="errorMessage" label="最近错误 / 建议" min-width="260" show-overflow-tooltip>
                  <template #default="{ row }">
                    <div v-if="row.errorMessage" class="history-error-cell">
                      <div>{{ historyErrorLabel(row) }}</div>
                      <div v-if="row.suggestedAction" class="history-suggestion-line">建议：{{ row.suggestedAction }}</div>
                    </div>
                    <span v-else>-</span>
                  </template>
                </el-table-column>
              </el-table>
              <div class="history-hint">“无变更”表示任务正常执行，但本轮源端没有可写入或更新的数据。</div>
            </div>
          </el-tab-pane>

          <el-tab-pane label="配置">
            <div class="detail-kv-grid wide">
              <div><span>源连接</span><strong>{{ connName(detailTask.sourceConnectionId || detailTask.sourceId) }}</strong></div>
              <div><span>源表</span><strong>{{ detailTask.sourceTable || '-' }}</strong></div>
              <div><span>源库/Base</span><strong>{{ detailTask.sourceDatabase || detailTask.sourceBaseId || '-' }}</strong></div>
              <div><span>目标连接</span><strong>{{ connName(detailTask.targetConnectionId || detailTask.targetId) }}</strong></div>
              <div><span>目标 Base</span><strong>{{ detailTask.targetBaseId || '-' }}</strong></div>
              <div><span>目标表</span><strong>{{ detailTask.targetTableId || '-' }}</strong></div>
              <div><span>同步模式</span><strong>{{ syncModeLabel(detailTask.syncMode || 'manual') }}</strong></div>
              <div><span>同步间隔</span><strong>{{ isAutoSyncMode(detailTask.syncMode) ? intervalLabel(detailTask.syncInterval || 300) : '-' }}</strong></div>
              <div><span>同步方向</span><strong>{{ syncDirectionLabel(detailTask.syncDirection) }}</strong></div>
              <div><span>冲突策略</span><strong>{{ conflictLabel(detailTask.conflictStrategy) }}</strong></div>
              <div><span>增量策略</span><strong>{{ watermarkLabel(detailTask.watermarkType) }}</strong></div>
              <div><span>增量列</span><strong>{{ detailTask.watermarkColumn || detailTask.sourceTimestampColumn || '-' }}</strong></div>
              <div><span>主键列</span><strong>{{ detailTask.sourcePrimaryKey || '-' }}</strong></div>
              <div><span>源分页大小</span><strong>{{ detailTask.pageSize || 1000 }}</strong></div>
              <div><span>Teable 写入批量</span><strong>{{ detailTask.batchSize || 500 }}</strong></div>
              <div><span>失败重试次数</span><strong>{{ detailTask.retryCount || 3 }}</strong></div>
              <div><span>初始全量上限</span><strong>{{ formatNumber(detailTask.maxInitialRows || 100000) }} 行</strong></div>
              <div><span>删除同步</span><strong>{{ deletionModeLabel(detailTask.deletionMode) }}</strong></div>
              <div><span>软删除字段</span><strong>{{ detailTask.softDeleteField || '-' }}</strong></div>
            </div>
          </el-tab-pane>

          <el-tab-pane label="字段映射">
            <div class="detail-section">
              <div class="detail-section-bar">
                <div class="detail-section-title">字段映射</div>
                <span class="detail-count">{{ mappingRowsForTask(detailTask).length }} 个字段</span>
              </div>
              <el-table :data="mappingRowsForTask(detailTask)" size="small" border max-height="420" empty-text="暂无字段映射">
                <el-table-column prop="source" label="源字段" min-width="180" show-overflow-tooltip />
                <el-table-column prop="target" label="目标字段" min-width="180" show-overflow-tooltip />
                <el-table-column prop="forceInclude" label="处理方式" width="120">
                  <template #default="{ row }">{{ row.forceInclude ? '强制包含' : '同步' }}</template>
                </el-table-column>
              </el-table>
            </div>
          </el-tab-pane>

          <el-tab-pane label="字段变更">
            <div class="detail-section">
              <div class="detail-section-bar">
                <div class="detail-section-title">字段快照</div>
                <button class="fs-btn fs-btn-ghost" style="padding:6px 12px;font-size:12px" @click="checkSchemaDrift(detailTask)" :disabled="schemaDriftLoading || isTaskActionBusy(detailTask, 'schemaDrift')">
                  {{ isTaskActionBusy(detailTask, 'schemaDrift') ? '检测中' : '立即检测' }}
                </button>
              </div>
              <div v-if="detailTask.schemaSnapshot" class="detail-kv-grid">
                <div><span>源字段数</span><strong>{{ snapshotFieldCount(detailTask.schemaSnapshot?.source) }}</strong></div>
                <div><span>目标字段数</span><strong>{{ snapshotFieldCount(detailTask.schemaSnapshot?.target) }}</strong></div>
                <div><span>快照时间</span><strong>{{ formatTime(detailTask.schemaSnapshot?.capturedAt || detailTask.schemaSnapshot?.createdAt) }}</strong></div>
                <div><span>任务保存时间</span><strong>{{ detailTask.updatedAt ? formatTime(detailTask.updatedAt) : '-' }}</strong></div>
              </div>
              <div v-else class="detail-empty-line">此任务还没有字段快照，可点击“立即检测”或编辑保存任务后生成。</div>
              <div v-if="detailTask.schemaSnapshotError" class="detail-error-line">字段快照失败：{{ detailTask.schemaSnapshotError }}</div>
            </div>
          </el-tab-pane>

          <el-tab-pane label="近期日志">
            <div class="detail-section-bar">
              <div class="detail-section-title">近期日志</div>
              <button class="fs-btn fs-btn-ghost" style="padding:6px 12px;font-size:12px" @click="refreshTaskDetailLogs" :disabled="taskDetailLogsLoading">
                刷新
              </button>
            </div>
            <div v-if="taskDetailLogsLoading" style="text-align:center;padding:32px">
              <el-icon class="is-loading" :size="24"><Loading /></el-icon>
            </div>
            <div v-else class="task-log-list detail-log-list">
              <div v-for="(log, idx) in taskDetailLogs" :key="idx" class="task-log-row" :class="'log-' + log.level">
                <span class="task-log-time">{{ formatTime(log.ts) }}</span>
                <span class="task-log-level" :class="log.level">{{ logLevelLabel(log.level) }}</span>
                <span class="task-log-message">{{ log.message }}</span>
              </div>
              <el-empty v-if="taskDetailLogs.length === 0" description="暂无该任务日志" :image-size="72" />
            </div>
          </el-tab-pane>
        </el-tabs>
      </div>
      <template #footer>
        <button class="fs-btn fs-btn-ghost" @click="taskDetailDialogVisible = false">关闭</button>
        <button v-if="detailTask" class="fs-btn fs-btn-ghost" @click="openDialog(detailTask)" :disabled="!isOwner(detailTask)">编辑配置</button>
        <button v-if="detailTask" class="fs-btn fs-btn-ghost" @click="restartFullSync(detailTask)" :disabled="isRestartFullSyncDisabled(detailTask)">{{ isTaskActionBusy(detailTask, 'restartFullSync') ? '启动中' : '重跑全量' }}</button>
        <button v-if="detailTask" class="fs-btn fs-btn-ghost" @click="continueInitialization(detailTask)" :disabled="isContinueInitializationDisabled(detailTask)">{{ isTaskActionBusy(detailTask, 'continueInitialization') ? '继续中' : '继续初始化' }}</button>
        <button v-if="detailTask" class="fs-btn fs-btn-primary" @click="manualRun(detailTask)" :disabled="isManualRunDisabled(detailTask)" :title="manualRunTitle(detailTask)">立即同步</button>
      </template>
    </el-dialog>

    <!-- Task Dialog -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑任务' : '新建同步任务'" width="720px" destroy-on-close>
      <el-form :model="form" label-position="top">

        <el-form-item label="任务名称">
          <el-input v-model="form.name" placeholder="例如：用户表同步" />
        </el-form-item>

        <!-- Source -->
        <div class="section-divider">
          <span class="section-icon">⬡</span> 数据源
        </div>
        <el-alert
          v-if="!hasReadySourceConnections"
          type="warning"
          :closable="false"
          style="margin-bottom:12px"
        >
          没有可用于建任务的源连接。请先到“数据源”页面测试 SQL 或 Teable 连接，测试通过后才会出现在这里。
        </el-alert>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="源连接">
              <el-select v-model="form.sourceConnectionId" @change="onSourceChange" placeholder="选择 SQL 或 Teable" style="width:100%">
                <el-option-group label="SQL 数据库">
                  <el-option v-for="c in sqlConnections" :key="c.id" :label="connectionOptionLabel(c)" :value="c.id" :disabled="!isConnectionReady(c)" />
                </el-option-group>
                <el-option-group label="Teable">
                  <el-option v-for="c in teableConnections" :key="c.id" :label="connectionOptionLabel(c)" :value="c.id" :disabled="!isConnectionReady(c)" />
                </el-option-group>
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item :label="sourceIsTeable ? '源 Teable 表' : '源表'">
              <el-select v-model="form.sourceTable" @change="onSourceTableChange" placeholder="选择表" style="width:100%"
                :loading="sourceLoading" :disabled="!form.sourceConnectionId" filterable>
                <el-option v-for="t in sourceTables" :key="t.name" :label="sourceTableLabel(t)" :value="t.name" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="源库（可选）">
              <el-input v-model="form.sourceDatabase" placeholder="默认连接数据库" :disabled="sourceIsTeable" />
            </el-form-item>
          </el-col>
        </el-row>

        <!-- Target -->
        <div class="section-divider">
          <span class="section-icon">▦</span> 目标（Teable）
        </div>
        <el-alert
          v-if="!hasReadyTeableConnections"
          type="warning"
          :closable="false"
          style="margin-bottom:12px"
        >
          没有可用于写入的 Teable 连接。请先到“数据源”页面测试 Teable 连接，测试通过后才会出现在这里。
        </el-alert>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="Teable 连接">
              <el-select v-model="form.targetConnectionId" @change="onTeableConnChange" placeholder="选择Teable" style="width:100%">
                <el-option v-for="c in teableConnections" :key="c.id" :label="connectionOptionLabel(c)" :value="c.id" :disabled="!isConnectionReady(c)" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="Base（数据库）">
              <el-select v-model="form._baseId" @change="onBaseChange" placeholder="选择 Base" style="width:100%"
                :loading="basesLoading" :disabled="!form.targetConnectionId" filterable>
                <el-option v-for="b in teableBases" :key="b.id" :label="b.name" :value="b.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="目标表">
              <el-select v-model="form.targetTableId" @change="onTargetTableChange" placeholder="选择表" style="width:100%"
                :loading="tablesLoading" :disabled="!form._baseId" filterable>
                <el-option v-for="t in teableTables" :key="t.id" :label="t.name" :value="t.id" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <!-- Field Mapping -->
        <div class="section-divider">
          <span class="section-icon">⟐</span> 字段映射
          <el-tag v-if="mappingLoading" size="small" type="info" style="margin-left:8px">智能匹配中...</el-tag>
          <el-tag v-if="mappingSuggestions && !mappingLoading" size="small" :type="activeMappingCount > 0 ? 'success' : 'info'" style="margin-left:8px">
            {{ activeMappingCount }} 个将同步{{ skippedMappingCount > 0 ? `，${skippedMappingCount} 个已跳过` : '' }}
          </el-tag>
        </div>
        <div v-if="sourceColumns.length > 0 && targetFields.length > 0" class="mapping-area">
          <el-alert type="info" :closable="false" style="margin-bottom:12px">
            智能匹配会自动跳过不兼容字段。需要承担转换风险时，可手动强制包含。
          </el-alert>
          <el-alert v-if="skippedMappingCount > 0" type="warning" :closable="false" style="margin-bottom:12px">
            已跳过 {{ skippedMappingCount }} 个类型不兼容字段，保存后不会同步这些字段。
          </el-alert>
          <el-table :data="mappingRows" size="small" border row-key="source" :row-class-name="mappingRowClassName">
            <el-table-column :label="sourceIsTeable ? '源字段 (Teable)' : '源字段 (SQL)'" min-width="180">
              <template #default="{ row }">
                <el-select v-model="row.source" placeholder="选择源字段" style="width:100%" filterable @change="refreshMappingCompatibility(row)">
                  <el-option v-for="c in sourceColumns" :key="c.name" :label="`${c.name} (${c.type})`" :value="c.name" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column width="60" align="center">
              <template #default="{ row }">
                <span :class="confidenceClass(row)">{{ confidenceIcon(row) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="目标字段 (Teable)" min-width="180">
              <template #default="{ row }">
                <el-select v-model="row.target" placeholder="选择目标字段" style="width:100%" filterable @change="refreshMappingCompatibility(row)">
                  <el-option v-for="f in targetFields" :key="f.name" :label="`${f.name} (${f.type})`" :value="f.name" />
                  <!-- For auto-create: add the source name as option -->
                  <el-option v-if="!targetFields.find(f => f.name === row.source)" :key="'create-'+row.source" :label="`${row.source} (自动创建)`" :value="row.source" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column width="140" align="center" label="处理">
              <template #default="{ row }">
                <span v-if="row._typeSafe === undefined" class="compat-tag compat-unknown">手动</span>
                <span v-else-if="row._typeSafe" class="compat-tag compat-safe">将同步</span>
                <button
                  v-else
                  type="button"
                  class="compat-action"
                  :class="{ forced: row._forceInclude }"
                  :title="row._typeWarning"
                  @click="toggleForceMapping(row)"
                >
                  {{ row._forceInclude ? '强制同步' : '已跳过' }}
                </button>
              </template>
            </el-table-column>
            <el-table-column width="50" align="center">
              <template #default="{ $index }">
                <button class="icon-btn icon-btn-danger" @click="removeMapping($index)">
                  <el-icon :size="14"><Delete /></el-icon>
                </button>
              </template>
            </el-table-column>
          </el-table>
          <div style="margin-top:10px;display:flex;gap:8px">
            <button type="button" class="fs-btn fs-btn-ghost" @click="addMapping" style="padding:6px 14px;font-size:12px">
              <el-icon><Plus /></el-icon>添加映射
            </button>
            <button type="button" class="fs-btn fs-btn-ghost" @click="smartMap" :disabled="mappingLoading" style="padding:6px 14px;font-size:12px;border-color:var(--green);color:var(--green)">
              <el-icon><MagicStick /></el-icon>{{ mappingLoading ? '匹配中...' : '智能匹配' }}
            </button>
          </div>
        </div>
        <el-empty v-else description="请先选择源表和目标表" :image-size="60" />

        <!-- Settings -->
        <div class="section-divider">
          <span class="section-icon">⚙</span> 同步设置
        </div>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="同步模式">
              <el-select v-model="form.syncMode" style="width:100%">
                <el-option label="手动执行" value="manual" />
                <el-option label="定时同步" value="scheduled" />
                <el-option label="准实时同步（高频轮询）" value="realtime" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="同步方向">
              <el-select v-model="form.syncDirection" style="width:100%">
                <el-option label="单向同步" value="one_way" />
                <el-option label="双向同步（Teable ↔ Teable）" value="bidirectional" :disabled="!canUseBidirectional" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="冲突策略">
              <el-select v-model="form.conflictStrategy" style="width:100%">
                <template v-if="form.syncDirection === 'bidirectional'">
                  <el-option label="源优先" value="source_wins" />
                  <el-option label="目标优先" value="target_wins" />
                  <el-option label="最新修改优先" value="latest_wins" />
                  <el-option label="跳过冲突" value="skip_conflict" />
                </template>
                <template v-else>
                  <el-option label="覆盖（以源端为准）" value="upsert" />
                  <el-option label="跳过（保留目标数据）" value="skip" />
                  <el-option label="仅新增（不更新已有记录）" value="insert_only" />
                </template>
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8" v-if="form.syncMode !== 'manual'">
            <el-form-item :label="form.syncMode === 'realtime' ? '轮询间隔（秒）' : '同步间隔（秒）'">
              <el-select v-model="form.syncInterval" style="width:100%">
                <el-option v-if="form.syncMode === 'realtime'" label="30秒" :value="30" />
                <el-option v-if="form.syncMode === 'realtime'" label="1分钟" :value="60" />
                <el-option label="5分钟" :value="300" />
                <el-option label="15分钟" :value="900" />
                <el-option label="30分钟" :value="1800" />
                <el-option label="1小时" :value="3600" />
                <el-option label="6小时" :value="21600" />
                <el-option label="12小时" :value="43200" />
                <el-option label="24小时" :value="86400" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="源分页大小">
              <el-input-number v-model="form.pageSize" :min="100" :max="5000" :step="100" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="Teable 写入批量">
              <el-input-number v-model="form.batchSize" :min="10" :max="1000" :step="50" style="width:100%" />
              <div class="form-help">每次向 Teable 写入的记录数，建议 200-500；Teable 单次最多 1000 条。</div>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="失败重试次数">
              <el-input-number v-model="form.retryCount" :min="1" :max="8" style="width:100%" />
            </el-form-item>
          </el-col>
        </el-row>

        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="初始全量上限">
              <el-input-number v-model="form.maxInitialRows" :min="1000" :max="10000000" :step="10000" style="width:100%" />
              <div class="form-help">首次全量同步预估超过该行数会被后端阻断，避免大表误启动。</div>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="初始化读页/分钟">
              <el-input-number v-model="form.initialReadPagesPerMinute" :min="0" :max="100000" :step="10" style="width:100%" />
              <div class="form-help">0 表示不限速；用于大表首次初始化分段读取。</div>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="初始化写批/分钟">
              <el-input-number v-model="form.initialWriteBatchesPerMinute" :min="0" :max="100000" :step="10" style="width:100%" />
              <div class="form-help">0 表示不限速；用于控制 Teable 写入压力。</div>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="单次初始化分钟">
              <el-input-number v-model="form.initialMaxRunMinutes" :min="0" :max="1440" :step="10" style="width:100%" />
              <div class="form-help">0 表示不自动暂停；到时会保留断点，可继续初始化。</div>
            </el-form-item>
          </el-col>
        </el-row>

        <!-- Watermark Strategy -->
        <div class="section-divider">
          <span class="section-icon">⇌</span> 增量策略
          <el-tag v-if="watermarkLoading" size="small" type="info" style="margin-left:8px">检测中...</el-tag>
        </div>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="增量策略">
              <el-select v-model="form.watermarkType" style="width:100%" placeholder="自动检测">
                <el-option
                  v-for="wt in availableWatermarkTypes"
                  :key="wt.value"
                  :label="wt.label"
                  :value="wt.value"
                >
                  <div style="display:flex;justify-content:space-between;align-items:center">
                    <span>{{ wt.label }}</span>
                    <span style="color:var(--text-tertiary);font-size:11px">{{ wt.desc }}</span>
                  </div>
                </el-option>
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="增量列">
              <el-select
                v-model="form.watermarkColumn"
                placeholder="自动选择"
                clearable
                style="width:100%"
                :disabled="!form.watermarkType || form.watermarkType === 'full_scan' || watermarkColumnOptions.length === 0"
              >
                <el-option v-for="col in watermarkColumnOptions" :key="col" :label="col" :value="col" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="主键列">
              <el-input v-model="form.sourcePrimaryKey" :placeholder="watermarkCandidates.pkCol || '自动检测'" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert
          v-if="form.watermarkType === 'auto_pk'"
          type="warning"
          :closable="false"
          style="margin-bottom:12px"
        >
          ⚠️ 自增主键策略只能捕获新增记录，无法检测已有记录的更新和删除。
        </el-alert>
        <el-alert
          v-if="form.watermarkType === 'full_scan'"
          type="info"
          :closable="false"
          style="margin-bottom:12px"
        >
          ℹ️ 全量扫描模式每次同步都会拉取所有记录进行对比，适用于无时间戳/rowversion/自增主键的表，大数据量时可能较慢。
        </el-alert>

        <!-- Deletion Strategy -->
        <div class="section-divider">
          <span class="section-icon">⌫</span> 删除同步
        </div>
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="源端删除后的处理">
              <el-select v-model="form.deletionMode" style="width:100%">
                <el-option label="不处理删除" value="ignore" />
                <el-option label="软删除标记" value="soft_delete" />
                <el-option label="从 Teable 删除" value="hard_delete" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12" v-if="form.deletionMode === 'soft_delete'">
            <el-form-item label="软删除字段名">
              <el-input v-model="form.softDeleteField" placeholder="deleted" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert
          v-if="form.deletionMode !== 'ignore' && form.watermarkType !== 'full_scan'"
          type="warning"
          :closable="false"
          style="margin-bottom:12px"
        >
          删除检测需要全量扫描。当前增量策略下会跳过删除同步。
        </el-alert>
        <el-alert
          v-if="form.syncDirection === 'bidirectional' && form.deletionMode !== 'ignore'"
          type="warning"
          :closable="false"
          style="margin-bottom:12px"
        >
          双向删除只根据软删除字段传播；单侧缺失记录会优先修复，不会直接当作删除。
        </el-alert>
      </el-form>
      <template #footer>
        <button class="fs-btn fs-btn-ghost" @click="dialogVisible = false">取消</button>
        <button class="fs-btn fs-btn-primary" @click="saveTask" :disabled="saving || (editingId && !isOwner(tasks.find(t => t.id === editingId)))">
          保存{{ (editingId && !isOwner(tasks.find(t => t.id === editingId))) ? '（无权限）' : '' }}
        </button>
      </template>
    </el-dialog>

    <!-- Preview Dialog -->
    <el-dialog v-model="previewDialogVisible" title="数据预览" width="80%" top="5vh">
      <div v-if="previewLoading" style="text-align:center;padding:40px">
        <el-icon class="is-loading" :size="24"><Loading /></el-icon>
        <div style="margin-top:8px;color:var(--text-secondary)">加载中...</div>
      </div>
      <div v-else-if="previewData">
        <div style="margin-bottom:12px;display:flex;align-items:center;gap:12px">
          <span>预览行数:</span>
          <el-select v-model="previewLimit" style="width:100px" @change="handlePreview(editingId || $attrs.taskId)">
            <el-option :value="10" label="10 行" />
            <el-option :value="50" label="50 行" />
            <el-option :value="100" label="100 行" />
          </el-select>
          <el-tag type="info">共 {{ previewData.totalPreviewed }} 条</el-tag>
        </div>
        <el-table :data="previewData.rows" size="small" border max-height="500" style="width:100%">
          <el-table-column v-for="col in previewData.columns" :key="col.name" :label="col.name" :prop="col.name" min-width="120">
            <template #default="{ row }">
              <span :title="row[col.name]">{{ row[col.name] !== null && row[col.name] !== undefined ? String(row[col.name]).slice(0, 100) : '(null)' }}</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div v-else style="text-align:center;padding:40px;color:var(--text-tertiary)">暂无数据</div>
    </el-dialog>

    <el-dialog v-model="failuresDialogVisible" title="失败批次恢复" width="860px" top="8vh">
      <div v-if="failuresLoading" style="text-align:center;padding:32px">
        <el-icon class="is-loading" :size="24"><Loading /></el-icon>
      </div>
      <div v-else>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <span class="detail-value">共 {{ taskFailures.length }} 个失败批次</span>
          <div style="display:flex;gap:8px">
            <button class="fs-btn fs-btn-primary" @click="retryFailures" :disabled="failuresLoading || !selectedFailureTask || taskFailures.length === 0">{{ failuresLoading ? '处理中' : '全部重试' }}</button>
            <button class="fs-btn fs-btn-danger" @click="clearFailures" :disabled="failuresLoading || !selectedFailureTask || taskFailures.length === 0">清空记录</button>
          </div>
        </div>
        <el-table :data="taskFailures" size="small" border max-height="420" style="width:100%">
          <el-table-column prop="operation" label="操作" width="110" />
          <el-table-column prop="count" label="数量" width="80" />
          <el-table-column prop="batchNo" label="源批次" width="90" />
          <el-table-column label="源范围" width="120">
            <template #default="{ row }">
              {{ row.sourceRange ? `${row.sourceRange.start}-${row.sourceRange.end}` : '-' }}
            </template>
          </el-table-column>
          <el-table-column prop="retryCount" label="重试" width="80" />
          <el-table-column prop="createdAt" label="时间" width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column prop="errorMessage" label="错误" min-width="220" show-overflow-tooltip />
          <el-table-column label="操作" width="105" fixed="right">
            <template #default="{ row }">
              <button class="fs-btn fs-btn-ghost table-mini-btn" @click="retrySingleFailure(row)" :disabled="failureRetryingId === row.id || !row.hasPayload">
                {{ failureRetryingId === row.id ? '重试中' : '重试' }}
              </button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>

    <el-dialog v-model="preflightDialogVisible" title="同步前预检" width="760px" top="8vh">
      <div v-if="preflightLoading" style="text-align:center;padding:32px">
        <el-icon class="is-loading" :size="24"><Loading /></el-icon>
        <div style="margin-top:8px;color:var(--text-secondary)">正在检查...</div>
      </div>
      <div v-else-if="preflightResult">
        <div class="reconcile-summary">
          <div><span class="detail-label">状态</span><strong>{{ preflightStatusLabel(preflightResult.status) }}</strong></div>
          <div><span class="detail-label">错误</span><strong>{{ preflightResult.summary.error }}</strong></div>
          <div><span class="detail-label">警告</span><strong>{{ preflightResult.summary.warn }}</strong></div>
          <div><span class="detail-label">提示</span><strong>{{ preflightResult.summary.info || 0 }}</strong></div>
          <div><span class="detail-label">源字段</span><strong>{{ preflightResult.sourceFields }}</strong></div>
        </div>
        <div v-if="preflightResult.initialFullSync" class="reconcile-summary preflight-estimate">
          <div><span class="detail-label">源表行数</span><strong>{{ formatNumber(preflightResult.initialFullSync.sourceRows) }}{{ preflightResult.initialFullSync.exact ? '' : '+' }}</strong></div>
          <div><span class="detail-label">预计分页</span><strong>{{ formatNumber(preflightResult.initialFullSync.estimatedPages) }}</strong></div>
          <div><span class="detail-label">预计写入批次</span><strong>{{ formatNumber(preflightResult.initialFullSync.estimatedWriteBatches) }}</strong></div>
          <div><span class="detail-label">预计请求数</span><strong>{{ formatNumber(preflightResult.initialFullSync.estimatedTeableRequests) }}</strong></div>
          <div><span class="detail-label">预计耗时</span><strong>{{ preflightDurationLabel(preflightResult.initialFullSync) }}</strong></div>
          <div><span class="detail-label">保护上限</span><strong>{{ formatNumber(preflightResult.initialFullSync.maxRows) }} 行</strong></div>
        </div>
        <el-alert v-if="preflightResult.initialFullSync?.suggestions?.length" type="info" :closable="false" style="margin-bottom:12px">
          {{ preflightResult.initialFullSync.suggestions.join('；') }}
        </el-alert>
        <el-alert v-if="preflightResult.status === 'pass'" type="success" :closable="false" style="margin-bottom:12px">
          预检通过，可以运行同步。
        </el-alert>
        <el-alert v-else-if="preflightResult.status === 'warn'" type="warning" :closable="false" style="margin-bottom:12px">
          预检发现风险，建议确认后再运行。
        </el-alert>
        <el-alert v-else type="error" :closable="false" style="margin-bottom:12px">
          预检发现会阻断同步的问题，请先修复。
        </el-alert>
        <el-table :data="preflightResult.issues" size="small" border max-height="360" style="width:100%">
          <el-table-column label="级别" width="90">
            <template #default="{ row }">
              <el-tag size="small" :type="preflightIssueTagType(row.level)">{{ preflightIssueLevelLabel(row.level) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="code" label="代码" width="170" show-overflow-tooltip />
          <el-table-column prop="message" label="说明" min-width="260" show-overflow-tooltip />
          <el-table-column prop="source" label="源字段" width="130" show-overflow-tooltip />
          <el-table-column prop="target" label="目标字段" width="130" show-overflow-tooltip />
        </el-table>
      </div>
    </el-dialog>

    <el-dialog v-model="schemaDriftDialogVisible" title="字段变更检测" width="820px" top="7vh">
      <div v-if="schemaDriftLoading" style="text-align:center;padding:32px">
        <el-icon class="is-loading" :size="24"><Loading /></el-icon>
        <div style="margin-top:8px;color:var(--text-secondary)">正在检测...</div>
      </div>
      <div v-else-if="schemaDriftResult">
        <div class="reconcile-summary">
          <div><span class="detail-label">状态</span><strong>{{ schemaDriftStatusLabel(schemaDriftResult.status) }}</strong></div>
          <div><span class="detail-label">新增</span><strong>{{ schemaDriftResult.summary.added }}</strong></div>
          <div><span class="detail-label">删除</span><strong>{{ schemaDriftResult.summary.removed }}</strong></div>
          <div><span class="detail-label">类型变化</span><strong>{{ schemaDriftResult.summary.typeChanged }}</strong></div>
          <div><span class="detail-label">快照时间</span><strong>{{ schemaDriftResult.snapshotAt ? formatTime(schemaDriftResult.snapshotAt) : '未建立' }}</strong></div>
        </div>
        <el-alert v-if="schemaDriftResult.status === 'changed'" type="warning" :closable="false" style="margin-bottom:12px">
          检测到字段结构变化，建议检查字段映射并刷新快照。
        </el-alert>
        <el-alert v-else-if="schemaDriftResult.status === 'no_snapshot'" type="info" :closable="false" style="margin-bottom:12px">
          此任务还没有字段快照，可以先刷新快照作为后续比对基线。
        </el-alert>
        <el-alert v-else type="success" :closable="false" style="margin-bottom:12px">
          字段结构与快照一致。
        </el-alert>
        <el-tabs>
          <el-tab-pane label="源端变化">
            <el-table :data="schemaDriftRows(schemaDriftResult.source)" size="small" border max-height="280">
              <el-table-column prop="change" label="变化" width="100" />
              <el-table-column prop="name" label="字段" min-width="180" />
              <el-table-column prop="before" label="原类型" min-width="140" />
              <el-table-column prop="after" label="当前类型" min-width="140" />
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="目标变化">
            <el-table :data="schemaDriftRows(schemaDriftResult.target)" size="small" border max-height="280">
              <el-table-column prop="change" label="变化" width="100" />
              <el-table-column prop="name" label="字段" min-width="180" />
              <el-table-column prop="before" label="原类型" min-width="140" />
              <el-table-column prop="after" label="当前类型" min-width="140" />
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>
      <template #footer>
        <button class="fs-btn fs-btn-ghost" @click="schemaDriftDialogVisible = false">关闭</button>
        <button class="fs-btn fs-btn-primary" @click="refreshSchemaSnapshot" :disabled="!selectedSchemaTask || schemaSnapshotSaving">刷新快照</button>
      </template>
    </el-dialog>

    <el-dialog v-model="reconcileDialogVisible" title="一致性校验" width="760px" top="8vh">
      <div v-if="reconcileLoading" style="text-align:center;padding:32px">
        <el-icon class="is-loading" :size="24"><Loading /></el-icon>
        <div style="margin-top:8px;color:var(--text-secondary)">正在校验...</div>
      </div>
      <div v-else-if="reconcileResult">
        <div class="reconcile-summary">
          <div><span class="detail-label">源记录</span><strong>{{ reconcileResult.sourceRows }}</strong></div>
          <div><span class="detail-label">目标记录</span><strong>{{ reconcileResult.targetRows }}</strong></div>
          <div><span class="detail-label">目标缺失</span><strong>{{ reconcileResult.missingInTarget }}</strong></div>
          <div><span class="detail-label">目标多余</span><strong>{{ reconcileResult.extraInTarget }}</strong></div>
          <div><span class="detail-label">字段不一致</span><strong>{{ reconcileResult.mismatched }}</strong></div>
        </div>
        <el-alert v-if="reconcileResult.limited" type="warning" :closable="false" style="margin-bottom:12px">
          本次达到扫描上限 {{ reconcileResult.limit }} 行，结果为抽样校验。
        </el-alert>
        <el-tabs>
          <el-tab-pane label="目标缺失">
            <el-table :data="reconcileResult.samples.missingInTarget" size="small" border max-height="260">
              <el-table-column prop="pk" label="主键" />
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="目标多余">
            <el-table :data="reconcileResult.samples.extraInTarget" size="small" border max-height="260">
              <el-table-column prop="pk" label="主键" />
            </el-table>
          </el-tab-pane>
          <el-tab-pane label="字段不一致">
            <el-table :data="reconcileResult.samples.mismatched" size="small" border max-height="260">
              <el-table-column prop="pk" label="主键" width="160" />
              <el-table-column label="差异">
                <template #default="{ row }">
                  <div v-for="diff in row.diffs" :key="diff.field" class="diff-line">
                    {{ diff.field }}: {{ diff.source }} → {{ diff.target }}
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-dialog>

    <el-dialog v-model="taskLogsDialogVisible" :title="selectedLogTask ? `运行日志 · ${selectedLogTask.name}` : '运行日志'" width="820px" top="7vh">
      <div v-if="taskLogsLoading" style="text-align:center;padding:32px">
        <el-icon class="is-loading" :size="24"><Loading /></el-icon>
      </div>
      <div v-else class="task-log-list">
        <div v-for="(log, idx) in taskLogs" :key="idx" class="task-log-row" :class="'log-' + log.level">
          <span class="task-log-time">{{ formatTime(log.ts) }}</span>
          <span class="task-log-level" :class="log.level">{{ logLevelLabel(log.level) }}</span>
          <span class="task-log-message">{{ log.message }}</span>
        </div>
        <el-empty v-if="taskLogs.length === 0" description="暂无该任务日志" :image-size="72" />
      </div>
      <template #footer>
        <button class="fs-btn fs-btn-ghost" @click="taskLogsDialogVisible = false">关闭</button>
        <button class="fs-btn fs-btn-primary" @click="refreshTaskLogs" :disabled="!selectedLogTask || taskLogsLoading">刷新</button>
      </template>
    </el-dialog>

    <el-dialog v-model="templateDialogVisible" title="同步任务模板" width="760px" top="8vh">
      <div v-if="templatesLoading" style="text-align:center;padding:32px">
        <el-icon class="is-loading" :size="24"><Loading /></el-icon>
      </div>
      <div v-else>
        <el-table :data="taskTemplates" size="small" border style="width:100%" empty-text="暂无模板">
          <el-table-column prop="name" label="模板" min-width="180" show-overflow-tooltip />
          <el-table-column label="源表" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">{{ row.config?.sourceTable || '-' }}</template>
          </el-table-column>
          <el-table-column label="方向" width="100">
            <template #default="{ row }">{{ syncDirectionLabel(row.config?.syncDirection) }}</template>
          </el-table-column>
          <el-table-column label="策略" width="120">
            <template #default="{ row }">{{ conflictLabel(row.config?.conflictStrategy) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="180" align="center">
            <template #default="{ row }">
              <button class="fs-btn fs-btn-primary" style="padding:6px 12px;font-size:12px" @click="createFromTemplate(row)" :disabled="isTemplateActionBusy(row, 'create')">
                {{ isTemplateActionBusy(row, 'create') ? '创建中' : '创建' }}
              </button>
              <button class="fs-btn fs-btn-ghost" style="padding:6px 12px;font-size:12px" @click="removeTemplate(row)" :disabled="isTemplateActionBusy(row, 'delete')">
                {{ isTemplateActionBusy(row, 'delete') ? '删除中' : '删除' }}
              </button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer>
        <button class="fs-btn fs-btn-ghost" @click="templateDialogVisible = false">关闭</button>
        <button class="fs-btn fs-btn-primary" @click="loadTemplates" :disabled="templatesLoading">刷新</button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getConnections, getTables, getWatermarkCandidates, getMappingSuggestions, getTeableBases, getTeableTables, getTeableFields } from '../api'
import { getTasks, createTask, updateTask, deleteTask, copyTask, getTaskTemplates, createTaskTemplate, createTaskFromTemplate, deleteTaskTemplate, runTask, continueInitialSync, startTask, stopTask, cancelTask, getTaskProgress, getTaskInitialization, getFailureCounts, getTaskFailures, retryTaskFailures, retryTaskFailure, clearTaskFailures, getTasksHealth, reconcileTask, preflightTask, getTaskSchemaDrift, refreshTaskSchemaSnapshot, getSchedulerStatus, previewTaskData, getStoredUser, getLogs, getSyncHistory } from '../api'
import { buildTaskUiState, isActionBusy, isAutoSyncMode, setActionBusy } from '../utils/taskUiState'
import { getConnectionHealth, isConnectionReady } from '../utils/connectionHealth'

const props = defineProps({
  focusAction: { type: Object, default: null },
})
const emit = defineEmits(['resolve-action'])

// 当前用户身份
const currentUser = getStoredUser()
const currentUserId = currentUser?.id || null
const isSuperAdmin = ['owner', 'super_admin'].includes(currentUser?.role)

function isOwner(task) {
  return task && (task.userId === currentUserId || isSuperAdmin)
}

const connections = ref([])
const tasks = ref([])
const taskFilter = ref('all')
const taskSearch = ref('')
const dialogVisible = ref(false)
const editingId = ref(null)
const saving = ref(false)

const sourceLoading = ref(false)
const sourceTables = ref([])
const sourceColumns = ref([])

const basesLoading = ref(false)
const tablesLoading = ref(false)
const teableBases = ref([])
const teableTables = ref([])
const targetFields = ref([])
const mappingRows = ref([])
const mappingSuggestions = ref(null) // { mappings, unmatchedSource, unmatchedTarget }
const mappingLoading = ref(false)
const previewDialogVisible = ref(false)
const previewData = ref(null)
const previewLoading = ref(false)
const previewLimit = ref(10)

const schedulerStatus = ref({})
const taskProgress = ref({})
const taskHealth = ref({})
const failureCounts = ref({})
const failuresDialogVisible = ref(false)
const failuresLoading = ref(false)
const taskFailures = ref([])
const selectedFailureTask = ref(null)
const failureRetryingId = ref(null)
const preflightDialogVisible = ref(false)
const preflightLoading = ref(false)
const preflightResult = ref(null)
const schemaDriftDialogVisible = ref(false)
const schemaDriftLoading = ref(false)
const schemaSnapshotSaving = ref(false)
const schemaDriftResult = ref(null)
const selectedSchemaTask = ref(null)
const reconcileDialogVisible = ref(false)
const reconcileLoading = ref(false)
const reconcileResult = ref(null)
const taskLogsDialogVisible = ref(false)
const taskLogsLoading = ref(false)
const taskLogs = ref([])
const selectedLogTask = ref(null)
const taskDetailDialogVisible = ref(false)
const detailTask = ref(null)
const taskDetailLogsLoading = ref(false)
const taskDetailLogs = ref([])
const taskHistoryLoading = ref(false)
const taskHistory = ref([])
const taskInitializationLoading = ref(false)
const taskInitialization = ref(null)
const hydratingTaskForm = ref(false)
const copyingTaskId = ref(null)
const templateSavingId = ref(null)
const taskActionLocks = ref({})
const templateActionLocks = ref({})
const templateDialogVisible = ref(false)
const templatesLoading = ref(false)
const taskTemplates = ref([])
let progressTimer = null

const activeMappingCount = computed(() => mappingRows.value.filter(rowShouldSync).length)
const skippedMappingCount = computed(() => mappingRows.value.filter(row => row.source && row.target && row._typeSafe === false && !row._forceInclude).length)

const taskHistorySummary = computed(() => {
  const rows = taskHistory.value || []
  const completed = rows.filter(row => row.status !== 'running')
  const noop = completed.filter(row => normalizedRunStatus(row) === 'noop').length
  const success = completed.filter(row => normalizedRunStatus(row) === 'success').length
  const failed = completed.filter(row => ['failed', 'cancelled', 'paused'].includes(row.status)).length
  const durations = completed.map(row => Number(row.durationMs || 0)).filter(value => value > 0)
  return {
    total: rows.length,
    success,
    noop,
    failed,
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
  }
})

// Watermark candidates (fetched from API when source table changes)
const watermarkCandidates = ref({ pkCol: null, candidates: { timestamp: [], rowversion: [], auto_pk: [] } })
const watermarkLoading = ref(false)

const defaultForm = {
  name: '', sourceConnectionId: '', sourceTable: '', sourceDatabase: '', sourceBaseId: '',
  targetConnectionId: '', targetTableId: '', _baseId: '',
  columnMapping: {}, conflictStrategy: 'upsert',
  syncDirection: 'one_way',
  sourcePrimaryKey: '', watermarkType: '', watermarkColumn: '',
  syncMode: 'manual', syncInterval: 300,
  pageSize: 1000, batchSize: 500, retryCount: 3, maxInitialRows: 100000,
  initialReadPagesPerMinute: 0, initialWriteBatchesPerMinute: 0, initialMaxRunMinutes: 0,
  deletionMode: 'ignore', softDeleteField: 'deleted',
}
const form = ref({ ...defaultForm })

const sqlConnections = computed(() => connections.value.filter(c => c.type !== 'teable' && shouldShowConnectionOption(c)))
const teableConnections = computed(() => connections.value.filter(c => c.type === 'teable' && shouldShowConnectionOption(c)))
const hasReadySourceConnections = computed(() => connections.value.some(c => ['mssql', 'mysql', 'pg', 'teable'].includes(c.type) && isConnectionReady(c)))
const hasReadyTeableConnections = computed(() => connections.value.some(c => c.type === 'teable' && isConnectionReady(c)))
const sourceConnection = computed(() => connections.value.find(c => c.id === form.value.sourceConnectionId) || null)
const sourceIsTeable = computed(() => sourceConnection.value?.type === 'teable')
const targetConnection = computed(() => connections.value.find(c => c.id === form.value.targetConnectionId) || null)
const canUseBidirectional = computed(() => sourceConnection.value?.type === 'teable' && targetConnection.value?.type === 'teable')

const taskSummary = computed(() => ({
  total: tasks.value.length,
  attention: tasks.value.filter(taskNeedsAttention).length,
  running: tasks.value.filter(isTaskRunning).length,
  scheduled: tasks.value.filter(task => schedulerStatus.value[task.id] || task.status === 'scheduled').length,
}))

const filteredTasks = computed(() => {
  const q = taskSearch.value.trim().toLowerCase()
  return tasks.value.filter((task) => {
    if (taskFilter.value === 'attention' && !taskNeedsAttention(task)) return false
    if (taskFilter.value === 'running' && !isTaskRunning(task)) return false
    if (taskFilter.value === 'scheduled' && !(schedulerStatus.value[task.id] || task.status === 'scheduled')) return false
    if (!q) return true
    return [
      task.name,
      task.sourceTable,
      connName(task.sourceConnectionId || task.sourceId),
      connName(task.targetConnectionId || task.targetId),
      task.watermarkType,
      task.syncMode,
    ].filter(Boolean).some(value => String(value).toLowerCase().includes(q))
  })
})

// Available watermark types based on detected candidates
const availableWatermarkTypes = computed(() => {
  const c = watermarkCandidates.value.candidates || {}
  const types = [
    { value: '', label: '自动检测', desc: '按优先级自动选择' },
    { value: 'timestamp', label: '时间戳列', desc: c.timestamp.length ? `可用: ${c.timestamp.join(', ')}` : '无可用列' },
    { value: 'rowversion', label: 'Rowversion', desc: c.rowversion.length ? `可用: ${c.rowversion.join(', ')}` : '仅 MSSQL, 无可用列' },
    { value: 'auto_pk', label: '自增主键', desc: c.auto_pk.length ? `可用: ${c.auto_pk.join(', ')}` : '仅捕获新增, 无可用列' },
    { value: 'full_scan', label: '全量扫描', desc: '每次全量拉取，最可靠' },
  ]
  return types
})

// Columns available for the selected watermark type
const watermarkColumnOptions = computed(() => {
  const type = form.value.watermarkType
  if (!type || type === 'full_scan') return []
  const c = watermarkCandidates.value.candidates || {}
  if (type === 'timestamp') return c.timestamp || []
  if (type === 'rowversion') return c.rowversion || []
  if (type === 'auto_pk') return c.auto_pk || []
  return []
})

function connName(id) { return connections.value.find(c => c.id === id)?.name || id }
function shouldShowConnectionOption(conn) {
  if (!conn || conn.deletedAt) return false
  if (isConnectionReady(conn)) return true
  return editingId.value && (conn.id === form.value.sourceConnectionId || conn.id === form.value.targetConnectionId)
}
function connectionOptionLabel(conn) {
  if (isConnectionReady(conn)) return conn.name
  if (!conn?.lastTest) return `${conn.name}（未测试）`
  if (getConnectionHealth(conn).status === 'expired') return `${conn.name}（测试已过期）`
  return `${conn.name}（测试失败）`
}
function sourceTableLabel(table) {
  if (!table) return ''
  if (table.baseName && table.displayName) return table.baseName + ' / ' + table.displayName
  return table.displayName || table.name
}
function syncDirectionLabel(direction) {
  return direction === 'bidirectional' ? '双向同步' : '单向同步'
}
function conflictLabel(s) {
  const m = {
    upsert: '覆盖',
    skip: '跳过',
    insert_only: '仅新增',
    source_wins: '源优先',
    target_wins: '目标优先',
    latest_wins: '最新修改优先',
    skip_conflict: '跳过冲突',
  }
  return m[s] || s
}
function watermarkLabel(w) {
  const m = { '': '自动', timestamp: '时间戳', rowversion: 'Rowversion', auto_pk: '自增主键', full_scan: '全量扫描' }
  return m[w] || '自动'
}
function deletionModeLabel(mode) {
  const map = {
    ignore: '不处理删除',
    soft_delete: '软删除标记',
    hard_delete: '从 Teable 删除',
  }
  return map[mode || 'ignore'] || mode
}
function syncModeLabel(m) {
  const map = {
    manual: '手动执行',
    scheduled: '定时同步',
    realtime: '准实时同步',
    incremental: '定时同步',  // legacy: 保持定时行为
    full: '手动执行',          // legacy: 保持手动行为
  }
  return map[m] || m
}
function compactSyncLabel(task) {
  const mode = syncModeLabel(task.syncMode || 'manual')
  if (!isAutoSyncMode(task.syncMode)) return mode
  return `${mode} · ${intervalLabel(task.syncInterval || 300)}`
}
function intervalLabel(sec) {
  if (sec < 60) return `${sec}秒`
  if (sec < 3600) return `${sec / 60}分钟`
  return `${sec / 3600}小时`
}
function statusLabel(s) {
  const map = { idle: '空闲', running: '同步中', scheduled: '定时同步中', error: '错误' }
  return map[s] || s
}
function statusClass(s) {
  const map = { idle: 'status-idle', running: 'status-running', scheduled: 'status-scheduled', error: 'status-error' }
  return map[s] || ''
}
function formatTime(ts) { return new Date(ts).toLocaleString('zh-CN') }
function formatNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN')
}
function formatDuration(ms) {
  const n = Number(ms || 0)
  if (!n) return '-'
  if (n < 1000) return `${n}ms`
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`
  return `${Math.round(n / 60000)}min`
}
function healthLabel(status) {
  const map = {
    healthy: '健康',
    has_failures: '有失败',
    recent_failed: '最近失败',
    cancelled: '已取消',
    never_run: '未运行',
    running: '运行中',
    deleted: '已删除',
    unknown: '未知',
  }
  return map[status] || status
}
function latestStatusLabel(status) {
  const map = { success: '成功', failed: '失败', cancelled: '取消', paused: '已暂停', running: '运行中', never_run: '未运行' }
  return map[status] || status
}

function errorTypeLabel(type) {
  const map = {
    connection: '连接异常',
    connection_expired: '连接测试过期',
    field_mapping: '字段映射',
    schema_drift: '字段变更',
    rate_limit: '接口限流',
    timeout: '网络超时',
    permission: '权限不足',
    data_type: '类型转换',
    initialization_paused: '初始化暂停',
    cancelled: '已取消',
    failure_batch: '失败批次',
    preflight: '预检阻断',
    unknown: '待排查',
  }
  return map[type] || type || '待排查'
}

function latestSuggestedAction(task) {
  return taskHealth.value[task.id]?.latestSuggestedAction || ''
}

function latestActionTarget(task) {
  return taskHealth.value[task.id]?.latestActionTarget || 'task_detail'
}

function latestErrorLabel(task) {
  const health = taskHealth.value[task.id] || {}
  const prefix = health.latestErrorType ? `${errorTypeLabel(health.latestErrorType)}：` : ''
  return `${prefix}${health.latestError || '-'}`
}

function historyErrorLabel(row = {}) {
  const prefix = row.errorType ? `${errorTypeLabel(row.errorType)}：` : ''
  return `${prefix}${row.errorMessage || '-'}`
}

function guidanceActionLabel(target) {
  const map = {
    connections: '去数据源',
    task_mapping: '检查映射',
    task_preflight: '运行预检',
    task_failures: '打开失败批次',
    task_detail: '查看详情',
    task_settings: '编辑设置',
    observability: '查看告警',
  }
  return map[target || 'task_detail'] || '去处理'
}

async function resolveTaskGuidance(task) {
  const actionTarget = latestActionTarget(task)
  if (['connections', 'observability'].includes(actionTarget)) {
    emit('resolve-action', { taskId: task.id, actionTarget })
    return
  }
  await handleFocusAction({ taskId: task.id, actionTarget })
}

function runChangedCount(row = {}) {
  return Number(row.inserted || 0)
    + Number(row.updated || 0)
    + Number(row.deleted || 0)
    + Number(row.softDeleted || 0)
}

function runSourceCount(row = {}) {
  return Number(row.sourceRows || 0)
}

function normalizedRunStatus(row = {}) {
  if (row.status === 'success' && runSourceCount(row) === 0 && runChangedCount(row) === 0 && Number(row.failed || 0) === 0) return 'noop'
  return row.status
}

function runStatusLabel(row = {}) {
  if (normalizedRunStatus(row) === 'noop') return '无变更'
  return latestStatusLabel(row.status)
}

function runStatusTagType(rowOrStatus) {
  const status = typeof rowOrStatus === 'string' ? rowOrStatus : normalizedRunStatus(rowOrStatus)
  if (status === 'success') return 'success'
  if (status === 'noop') return 'info'
  if (['failed', 'cancelled'].includes(status)) return 'danger'
  if (['paused', 'running'].includes(status)) return 'warning'
  return 'info'
}

function triggerLabel(trigger) {
  const map = {
    manual: '手动',
    manual_reset: '重跑全量',
    initialization: '初始化',
    scheduled: '定时',
    realtime: '准实时',
    incremental: '增量',
    codex_validation: '验收',
    codex_initialization_validation: '初始化验收',
  }
  return map[trigger] || trigger || '-'
}

function shortRunId(id) {
  return id ? String(id).slice(0, 8) : '-'
}
function healthRate(health) {
  return health.successRate === null || health.successRate === undefined ? '-' : `${health.successRate}%`
}
function taskUiState(task) {
  return buildTaskUiState(task, {
    progressByTask: taskProgress.value,
    schedulerStatus: schedulerStatus.value,
    actionLocks: taskActionLocks.value,
    detailTask: detailTask.value,
    initializationState: taskInitialization.value,
  })
}
function isTaskActionBusy(taskOrId, action) {
  return isActionBusy(taskActionLocks.value, taskOrId, action)
}
function setTaskActionBusy(taskOrId, action, busy) {
  taskActionLocks.value = setActionBusy(taskActionLocks.value, taskOrId, action, busy)
}
function isTemplateActionBusy(templateOrId, action) {
  return isActionBusy(templateActionLocks.value, templateOrId, action)
}
function setTemplateActionBusy(templateOrId, action, busy) {
  templateActionLocks.value = setActionBusy(templateActionLocks.value, templateOrId, action, busy)
}
function isRunActionPending(task) {
  return taskUiState(task).runActionPending
}
function isManualRunDisabled(task) {
  return taskUiState(task).manualRunDisabled
}
function manualRunTitle(task) {
  return taskUiState(task).manualRunTitle
}
function isTaskRunning(task) {
  return taskUiState(task).running
}
function isRestartFullSyncDisabled(task) {
  return taskUiState(task).restartFullSyncDisabled
}
function isContinueInitializationDisabled(task) {
  return taskUiState(task).continueInitializationDisabled
}
function isScheduleActionDisabled(task) {
  return taskUiState(task).scheduleActionDisabled
}
function isCancellingTask(task) {
  return taskUiState(task).cancelling
}
function runStateLabel(task) {
  const progress = taskProgress.value[task.id]
  if (progress?.status === 'queued') return '排队中'
  if (progress?.status === 'cancelling') return '取消中'
  if (isTaskRunning(task)) return progressPhaseLabel(progress?.phase || 'starting')
  return '空闲'
}
function runStateClass(task) {
  const progress = taskProgress.value[task.id]
  if (progress?.status === 'queued') return 'state-warn'
  if (progress?.status === 'cancelling') return 'state-warn'
  if (isTaskRunning(task)) return 'state-active'
  return 'state-muted'
}
function scheduleStateLabel(task) {
  if (!isAutoSyncMode(task.syncMode)) return '手动'
  if (schedulerStatus.value[task.id] || task.status === 'scheduled') return `${syncModeLabel(task.syncMode)} · ${intervalLabel(task.syncInterval || 300)}`
  return '未启动'
}
function scheduleStateClass(task) {
  if (!isAutoSyncMode(task.syncMode)) return 'state-muted'
  return (schedulerStatus.value[task.id] || task.status === 'scheduled') ? 'state-good' : 'state-warn'
}
function latestRunLabel(task) {
  const health = taskHealth.value[task.id]
  if (!health || health.latestStatus === 'never_run') return '未运行'
  const when = health.latestRunAt ? formatRelativeTime(health.latestRunAt) : ''
  return `${latestStatusLabel(health.latestStatus)}${when ? ' · ' + when : ''}`
}
function latestStateClass(task) {
  const status = taskHealth.value[task.id]?.latestStatus
  if (status === 'success') return 'state-good'
  if (status === 'failed') return 'state-bad'
  if (status === 'cancelled') return 'state-warn'
  return 'state-muted'
}
function formatRelativeTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - new Date(ts).getTime()
  if (!Number.isFinite(diff)) return ''
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  return `${Math.floor(diff / 86400000)}天前`
}
function logLevelLabel(level) {
  return ({ info: '信息', warn: '警告', error: '错误' }[level] || level || '-')
}
function mappingRowsForTask(task) {
  const mapping = task?.columnMapping || task?.fieldMapping || {}
  if (Array.isArray(mapping)) {
    return mapping
      .filter(row => row?.source || row?.target)
      .map(row => ({
        source: row.source || '-',
        target: row.target || '-',
        forceInclude: Boolean(row.forceInclude),
      }))
  }
  return Object.entries(mapping).map(([source, target]) => ({ source, target, forceInclude: false }))
}
function snapshotFieldCount(group) {
  if (Array.isArray(group)) return group.length
  if (Array.isArray(group?.fields)) return group.fields.length
  if (group && typeof group === 'object') return Object.keys(group).length
  return 0
}
function taskNeedsAttention(task) {
  const health = taskHealth.value[task.id]
  return Boolean(failureCounts.value[task.id])
    || task.status === 'error'
    || ['has_failures', 'recent_failed'].includes(health?.status)
}
function progressPhaseLabel(phase) {
  const map = {
    queued: '排队中',
    starting: '启动中',
    preparing: '准备同步',
    loading_target: '读取目标表',
    syncing_source: '同步源数据',
    detecting_deletes: '检测删除',
    applying_deletes: '应用删除',
    cancelling: '正在取消',
    cancelled: '已取消',
    completed: '已完成',
    failed: '失败',
    skipped: '已跳过',
  }
  return map[phase] || '同步中'
}
function progressSummary(p) {
  if (p.status === 'queued' || p.phase === 'queued') {
    const parts = [`队列第 ${p.queuePosition || p.initializationQueue?.position || 1} 位`]
    const concurrency = p.initializationConcurrency || p.initializationQueue?.concurrency
    if (concurrency) parts.push(`并发 ${concurrency}`)
    const eta = p.estimatedStartAt || p.initializationQueue?.estimatedStartAt
    if (eta) parts.push(`预计 ${formatTime(eta)}`)
    return parts.join(' · ')
  }
  const parts = [`源 ${p.processedRows || 0}`]
  if (p.targetRows) parts.push(`目标 ${p.targetRows}`)
  parts.push(`新增 ${p.inserted || 0}`)
  parts.push(`更新 ${p.updated || 0}`)
  if (p.deleted || p.softDeleted) parts.push(`删除 ${p.deleted || 0}/${p.softDeleted || 0}`)
  if (p.failed) parts.push(`失败 ${p.failed}`)
  return parts.join(' · ')
}
function progressPercent(p) {
  if (['success', 'completed'].includes(p.status) || p.phase === 'completed') return 100
  if (['failed', 'cancelled'].includes(p.status)) return 100
  if (p.status === 'queued' || p.phase === 'queued') return 8
  const total = Number(p.totalEstimate || p.targetRows || 0)
  if (!total) return 35
  return Math.max(5, Math.min(95, Math.round((Number(p.processedRows || 0) / total) * 100)))
}
function progressStatus(p) {
  if (p.status === 'failed') return 'exception'
  if (['cancelled', 'queued'].includes(p.status)) return 'warning'
  if (p.status === 'success' || p.phase === 'completed') return 'success'
  return undefined
}

async function handlePreview(taskId) {
  if (!taskId || isTaskActionBusy(taskId, 'preview')) return
  setTaskActionBusy(taskId, 'preview', true)
  previewLoading.value = true
  previewDialogVisible.value = true
  previewData.value = null
  try {
    previewData.value = await previewTaskData(taskId, previewLimit.value)
  } catch (err) {
    ElMessage.error('预览失败: ' + err.message)
  } finally {
    previewLoading.value = false
    setTaskActionBusy(taskId, 'preview', false)
  }
}

function closePreview() {
  previewDialogVisible.value = false
  previewData.value = null
}

function addMapping() { mappingRows.value.push({ source: '', target: '' }) }
function removeMapping(i) { mappingRows.value.splice(i, 1) }
function rowShouldSync(row) {
  return Boolean(row.source && row.target && (row._typeSafe !== false || row._forceInclude))
}
function toggleForceMapping(row) {
  row._forceInclude = !row._forceInclude
}
function mappingRowClassName({ row }) {
  if (row.source && row.target && row._typeSafe === false && !row._forceInclude) return 'mapping-row-skipped'
  return ''
}
function getSourceColumn(source) {
  return sourceColumns.value.find(c => c.name === source)
}
function getTargetField(target) {
  return targetFields.value.find(f => f.name === target)
}
function isSafeMappingPair(sourceColumn, targetField) {
  if (!sourceColumn || !targetField) return undefined
  let sourceType = String(sourceColumn.type || '').toLowerCase().replace(/[_-]/g, '')
  const targetType = String(targetField.type || '').toLowerCase().replace(/[_-]/g, '')
  if (sourceType.startsWith('teable:')) {
    sourceType = sourceType.slice(7)
    if (sourceType === targetType) return { safe: true }
    if (['singlelinetext', 'longtext'].includes(targetType)) return { safe: false, warning: 'Teable 字段转文本有风险' }
    return { safe: false, warning: '不兼容的目标类型' }
  }
  if (['singlelinetext', 'longtext'].includes(targetType)) {
    if (/(char|text|uuid|uniqueidentifier|json|xml)/.test(sourceType)) return { safe: true }
    return { safe: false, warning: '转文本有风险' }
  }
  if (targetType === 'number') {
    return /(int|decimal|numeric|float|double|real|money)/.test(sourceType)
      ? { safe: true }
      : { safe: false, warning: '目标需要数字' }
  }
  if (targetType === 'date') {
    return /(date|time|timestamp)/.test(sourceType)
      ? { safe: true }
      : { safe: false, warning: '目标需要日期' }
  }
  if (targetType === 'checkbox') {
    return /(bit|bool|boolean)/.test(sourceType)
      ? { safe: true }
      : { safe: false, warning: '目标需要布尔' }
  }
  return { safe: false, warning: '不兼容的目标类型' }
}
function refreshMappingCompatibility(row) {
  const sourceColumn = getSourceColumn(row.source)
  const targetField = getTargetField(row.target)
  if (!sourceColumn || !targetField) {
    row._typeSafe = undefined
    row._typeWarning = ''
    row._forceInclude = false
    return
  }
  const result = isSafeMappingPair(sourceColumn, targetField)
  row._typeSafe = result?.safe
  row._typeWarning = result?.warning || ''
  row._forceInclude = false
}
function refreshAllMappingCompatibility() {
  for (const row of mappingRows.value) refreshMappingCompatibility(row)
}

function confidenceClass(row) {
  if (row._confidenceLevel === 'exact') return 'conf-exact'
  if (row._confidenceLevel === 'high') return 'conf-high'
  if (row._confidenceLevel === 'medium') return 'conf-medium'
  if (row._confidenceLevel === 'auto_create') return 'conf-create'
  return 'conf-low'
}
function confidenceIcon(row) {
  if (row._confidenceLevel === 'auto_create') return '🆕'
  if (row._confidenceLevel === 'exact') return '═'
  if (row._confidenceLevel === 'high') return '≈'
  if (row._confidenceLevel === 'medium') return '~'
  return '→'
}

async function smartMap() {
  if (!form.value.sourceConnectionId || !form.value.sourceTable || !form.value.targetTableId) return;
  mappingLoading.value = true;
  try {
    const result = await getMappingSuggestions(
      form.value.sourceConnectionId,
      form.value.sourceTable,
      form.value.targetTableId,
      form.value.targetConnectionId,
      form.value.sourceDatabase || undefined
    );
    mappingSuggestions.value = result;
    // Build mapping rows from suggestions
    mappingRows.value = result.mappings.map(m => ({
      source: m.sourceColumn,
      target: m.targetField,
      _similarity: m.similarity,
      _confidence: m.confidence,
      _confidenceLevel: m.confidenceLevel,
      _typeSafe: m.typeSafe,
      _typeWarning: m.typeWarning,
      _forceInclude: false,
    }));
    // Auto-create unmatched source fields
    for (const us of result.unmatchedSource) {
      mappingRows.value.push({
        source: us.name,
        target: us.name, // will be auto-created
        _similarity: 100,
        _confidence: 100,
        _confidenceLevel: 'auto_create',
        _typeSafe: us.suggestionSafe !== false,
        _typeWarning: us.suggestionWarning,
        _forceInclude: false,
      });
    }
    if (mappingRows.value.length === 0) {
      ElMessage.info('没有可匹配的字段');
    } else {
      const skipped = skippedMappingCount.value;
      ElMessage.success(`已智能匹配 ${mappingRows.value.length} 个字段${skipped > 0 ? `，${skipped} 个类型不兼容已跳过` : ''}`);
    }
  } catch (err) {
    ElMessage.error('智能匹配失败: ' + err.message);
  } finally {
    mappingLoading.value = false;
  }
}

function autoMap() {
  // Keep for backward compat but redirect to smartMap
  smartMap();
}

async function loadAll() {
  connections.value = await getConnections()
  tasks.value = await getTasks()
  try { schedulerStatus.value = await getSchedulerStatus() } catch {}
  try { failureCounts.value = await getFailureCounts() } catch {}
  try { taskHealth.value = await getTasksHealth() } catch {}
  await refreshProgress()
}

async function refreshProgress() {
  const next = { ...taskProgress.value }
  await Promise.all(tasks.value.map(async (task) => {
    try {
      const progress = await getTaskProgress(task.id)
      if (progress.status === 'idle' && !['running', 'queued', 'cancelling'].includes(next[task.id]?.status)) {
        delete next[task.id]
      } else {
        next[task.id] = progress
      }
    } catch {
      delete next[task.id]
    }
  }))
  taskProgress.value = next
}

function startProgressPolling() {
  if (progressTimer) return
  progressTimer = window.setInterval(async () => {
    await refreshProgress()
    const hasActive = Object.values(taskProgress.value).some(p => ['running', 'queued', 'cancelling'].includes(p.status))
    if (!hasActive) {
      try {
        tasks.value = await getTasks()
        schedulerStatus.value = await getSchedulerStatus()
        failureCounts.value = await getFailureCounts()
        taskHealth.value = await getTasksHealth()
      } catch {}
    }
  }, 2000)
}

watch(() => form.value.sourceDatabase, () => {
  if (hydratingTaskForm.value || sourceIsTeable.value) return
  if (form.value.sourceConnectionId) onSourceChange()
})

watch(() => form.value.syncDirection, (direction) => {
  if (direction === 'bidirectional') {
    form.value.conflictStrategy = ['source_wins', 'target_wins', 'latest_wins', 'skip_conflict'].includes(form.value.conflictStrategy)
      ? form.value.conflictStrategy
      : 'source_wins'
    form.value.watermarkType = 'full_scan'
  } else {
    form.value.conflictStrategy = ['upsert', 'skip', 'insert_only'].includes(form.value.conflictStrategy)
      ? form.value.conflictStrategy
      : 'upsert'
  }
})

watch(canUseBidirectional, (ok) => {
  if (!ok && form.value.syncDirection === 'bidirectional') {
    form.value.syncDirection = 'one_way'
  }
})

async function onSourceChange(options = {}) {
  const { preserveSelection = false } = options
  const currentTable = form.value.sourceTable
  sourceTables.value = []
  sourceColumns.value = []
  if (!preserveSelection) {
    form.value.sourceTable = ''
    form.value.sourceBaseId = ''
    if (sourceIsTeable.value) form.value.sourceDatabase = ''
  }
  if (!form.value.sourceConnectionId) return
  sourceLoading.value = true
  try {
    const db = sourceIsTeable.value ? undefined : (form.value.sourceDatabase || undefined)
    sourceTables.value = await getTables(form.value.sourceConnectionId, db)
    if (preserveSelection && currentTable) {
      form.value.sourceTable = currentTable
      const found = sourceTables.value.find(t => t.name === currentTable)
      if (found) {
        form.value.sourceBaseId = found.baseId || form.value.sourceBaseId || ''
        sourceColumns.value = found.columns || []
      }
    }
  } catch (err) {
    ElMessage.error('获取表列表失败: ' + err.message)
  } finally {
    sourceLoading.value = false
  }
}

async function onSourceTableChange() {
  if (!form.value.sourceConnectionId || !form.value.sourceTable) return
  try {
    const db = sourceIsTeable.value ? undefined : (form.value.sourceDatabase || undefined)
    const tables = await getTables(form.value.sourceConnectionId, db)
    const found = tables.find(t => t.name === form.value.sourceTable)
    if (found) {
      form.value.sourceBaseId = found.baseId || ''
      sourceColumns.value = found.columns || []
    }
    if (targetFields.value.length > 0) smartMap()
  } catch (e) { /* ignore */ }
  // Fetch watermark candidates
  watermarkLoading.value = true
  try {
    const db = form.value.sourceDatabase || undefined
    watermarkCandidates.value = await getWatermarkCandidates(form.value.sourceConnectionId, form.value.sourceTable, sourceIsTeable.value ? undefined : db)
    if (sourceIsTeable.value && !form.value.watermarkType) form.value.watermarkType = 'full_scan'
  } catch (e) {
    watermarkCandidates.value = { pkCol: null, candidates: { timestamp: [], rowversion: [], auto_pk: [] } }
  } finally {
    watermarkLoading.value = false
  }
}

async function onTeableConnChange(options = {}) {
  const { preserveSelection = false } = options
  const currentBaseId = form.value._baseId
  const currentTableId = form.value.targetTableId
  teableBases.value = []
  teableTables.value = []
  targetFields.value = []
  if (!preserveSelection) {
    form.value._baseId = ''
    form.value.targetTableId = ''
  }
  if (!form.value.targetConnectionId) return
  basesLoading.value = true
  try {
    teableBases.value = await getTeableBases(form.value.targetConnectionId)
    if (preserveSelection) {
      form.value._baseId = currentBaseId || await resolveBaseIdForTable(currentTableId)
      form.value.targetTableId = currentTableId || ''
      if (form.value._baseId) await onBaseChange({ preserveSelection: true })
    }
  } catch (err) {
    ElMessage.error('获取 Base 列表失败: ' + err.message)
  } finally {
    basesLoading.value = false
  }
}

function inferBaseIdForTask(tableId) {
  if (!tableId) return ''
  for (const base of teableBases.value) {
    const tables = base.tables || base.tableList || []
    if (tables.some(table => table.id === tableId)) return base.id
  }
  return ''
}

async function resolveBaseIdForTable(tableId) {
  const fromLoadedBase = inferBaseIdForTask(tableId)
  if (fromLoadedBase || !tableId) return fromLoadedBase
  for (const base of teableBases.value) {
    try {
      const tables = await getTeableTables(base.id, form.value.targetConnectionId)
      if (tables.some(table => table.id === tableId)) return base.id
    } catch {
      // Ignore unreadable bases while looking for the saved target table.
    }
  }
  return ''
}

async function onBaseChange(options = {}) {
  const { preserveSelection = false } = options
  const currentTableId = form.value.targetTableId
  teableTables.value = []
  targetFields.value = []
  if (!preserveSelection) form.value.targetTableId = ''
  if (!form.value._baseId) return
  tablesLoading.value = true
  try {
    teableTables.value = await getTeableTables(form.value._baseId, form.value.targetConnectionId)
    if (preserveSelection && currentTableId) {
      form.value.targetTableId = currentTableId
      targetFields.value = await getTeableFields(currentTableId, form.value.targetConnectionId)
    }
  } catch (err) {
    ElMessage.error('获取表列表失败: ' + err.message)
  } finally {
    tablesLoading.value = false
  }
}

async function onTargetTableChange() {
  if (!form.value.targetTableId) return
  try {
    targetFields.value = await getTeableFields(form.value.targetTableId, form.value.targetConnectionId)
    if (sourceColumns.value.length > 0) smartMap()
  } catch (err) {
    ElMessage.error('获取字段失败: ' + err.message)
  }
}

async function openDialog(task = null) {
  if (task) {
    hydratingTaskForm.value = true
    try {
      editingId.value = task.id
      // 兼容新旧两套字段名
      const srcConnId = task.sourceConnectionId || task.sourceId
      const tgtConnId = task.targetConnectionId || task.targetId
      form.value = {
        ...defaultForm,
        ...task,
        sourceConnectionId: srcConnId,
        targetConnectionId: tgtConnId,
        _baseId: task.targetBaseId || '',
        sourceBaseId: task.sourceBaseId || ''
      }
      const mapping = task.columnMapping || task.fieldMapping
      if (Array.isArray(mapping)) {
        mappingRows.value = mapping.map(m => ({ source: m.source, target: m.target, _forceInclude: Boolean(m.forceInclude) }))
      } else {
        mappingRows.value = Object.entries(mapping || {}).map(([s, t]) => ({ source: s, target: t, _forceInclude: true }))
      }
      // Migrate sourceTimestampColumn → watermarkType/watermarkColumn
      if (task.watermarkType === undefined && task.sourceTimestampColumn) {
        form.value.watermarkType = 'timestamp'
        form.value.watermarkColumn = task.sourceTimestampColumn
      }
      if (!form.value.syncDirection) form.value.syncDirection = 'one_way'
      if (srcConnId) {
        await onSourceChange({ preserveSelection: true })
        if (form.value.sourceTable) await onSourceTableChange()
      }
      if (tgtConnId) {
        await onTeableConnChange({ preserveSelection: true })
      }
      refreshAllMappingCompatibility()
    } finally {
      hydratingTaskForm.value = false
    }
  } else {
    editingId.value = null
    form.value = { ...defaultForm }
    mappingRows.value = []
    mappingSuggestions.value = null
    sourceTables.value = []
    sourceColumns.value = []
    teableBases.value = []
    teableTables.value = []
    targetFields.value = []
  }
  dialogVisible.value = true
}

async function saveTask() {
  if (!form.value.name) { ElMessage.warning('请输入任务名称'); return }
  if (!form.value.sourceConnectionId || !form.value.sourceTable) { ElMessage.warning('请选择源连接和源表'); return }
  if (!form.value.targetConnectionId || !form.value.targetTableId) { ElMessage.warning('请选择 Teable 目标表'); return }
  if (!editingId.value || connectionConfigChanged()) {
    if (!isConnectionReady(sourceConnection.value)) {
      ElMessage.warning('源连接尚未测试通过，请先到“数据源”页面测试连接')
      return
    }
    if (!isConnectionReady(targetConnection.value)) {
      ElMessage.warning('Teable 目标连接尚未测试通过，请先到“数据源”页面测试连接')
      return
    }
  }
  if (form.value.syncDirection === 'bidirectional' && !canUseBidirectional.value) {
    ElMessage.warning('双向同步仅支持 Teable ↔ Teable')
    return
  }
  saving.value = true
  try {
    const forcedRows = mappingRows.value.filter(row => row.source && row.target && row._typeSafe === false && row._forceInclude)
    if (forcedRows.length > 0) {
      await ElMessageBox.confirm(
        `有 ${forcedRows.length} 个类型不兼容字段被强制同步，可能导致写入失败或数据格式异常。确定继续保存吗？`,
        '确认字段映射',
        { type: 'warning' }
      )
    }
    const columnMapping = {}
    for (const row of mappingRows.value) {
      if (rowShouldSync(row)) columnMapping[row.source] = row.target
    }
    const payload = { ...form.value, columnMapping, targetBaseId: form.value._baseId }
    if (!sourceIsTeable.value) delete payload.sourceBaseId
    if (payload.syncDirection === 'bidirectional') {
      payload.watermarkType = 'full_scan'
      payload.watermarkColumn = ''
      payload.sourceTimestampColumn = ''
    }
    delete payload._baseId
    // Backward compat: also set sourceTimestampColumn from watermark config
    if (payload.syncDirection !== 'bidirectional' && payload.watermarkType === 'timestamp' && payload.watermarkColumn) {
      payload.sourceTimestampColumn = payload.watermarkColumn
    } else if (payload.syncDirection !== 'bidirectional') {
      payload.sourceTimestampColumn = ''
    }

    if (editingId.value) {
      await updateTask(editingId.value, payload)
      ElMessage.success('任务已更新')
    } else {
      await createTask(payload)
      ElMessage.success('任务已创建')
    }
    dialogVisible.value = false
    await loadAll()
  } catch (err) {
    if (err === 'cancel' || err?.message === 'cancel') return
    ElMessage.error('保存失败: ' + err.message)
  } finally {
    saving.value = false
  }
}

function connectionConfigChanged() {
  const task = tasks.value.find(t => t.id === editingId.value)
  if (!task) return true
  const originalSourceId = task.sourceConnectionId || task.sourceId || ''
  const originalTargetId = task.targetConnectionId || task.targetId || ''
  const originalTargetBaseId = task.targetBaseId || ''
  const originalMapping = JSON.stringify(task.columnMapping || task.fieldMapping || {})
  const nextMapping = JSON.stringify(Object.fromEntries(mappingRows.value.filter(rowShouldSync).map(row => [row.source, row.target])))
  return originalSourceId !== form.value.sourceConnectionId
    || originalTargetId !== form.value.targetConnectionId
    || (task.sourceTable || '') !== (form.value.sourceTable || '')
    || (task.sourceDatabase || '') !== (form.value.sourceDatabase || '')
    || originalTargetBaseId !== (form.value._baseId || '')
    || (task.targetTableId || '') !== (form.value.targetTableId || '')
    || originalMapping !== nextMapping
}

async function removeTask(id) {
  if (isTaskActionBusy(id, 'delete')) return
  try {
    await ElMessageBox.confirm('确定删除此任务？', '提示', { type: 'warning' })
    setTaskActionBusy(id, 'delete', true)
    await deleteTask(id)
    ElMessage.success('已删除')
    await loadAll()
  } catch (err) {
    if (err !== 'cancel' && err?.message !== 'cancel') ElMessage.error('删除失败: ' + (err.message || err))
  } finally {
    setTaskActionBusy(id, 'delete', false)
  }
}

async function duplicateTask(task) {
  if (!task?.id || isTaskActionBusy(task, 'copy')) return
  setTaskActionBusy(task, 'copy', true)
  copyingTaskId.value = task.id
  try {
    const copied = await copyTask(task.id, { name: `${task.name || '同步任务'} 副本` })
    ElMessage.success(`已复制任务：${copied.name}`)
    await loadAll()
  } catch (err) {
    ElMessage.error('复制失败: ' + err.message)
  } finally {
    copyingTaskId.value = null
    setTaskActionBusy(task, 'copy', false)
  }
}

async function saveTaskAsTemplate(task) {
  if (!task?.id || isTaskActionBusy(task, 'saveTemplate')) return
  setTaskActionBusy(task, 'saveTemplate', true)
  templateSavingId.value = task.id
  try {
    const template = await createTaskTemplate({ sourceTaskId: task.id, name: `${task.name || '同步任务'} 模板` })
    ElMessage.success(`已保存模板：${template.name}`)
  } catch (err) {
    ElMessage.error('保存模板失败: ' + err.message)
  } finally {
    templateSavingId.value = null
    setTaskActionBusy(task, 'saveTemplate', false)
  }
}

async function loadTemplates() {
  templatesLoading.value = true
  try {
    taskTemplates.value = await getTaskTemplates()
  } catch (err) {
    ElMessage.error('加载模板失败: ' + err.message)
  } finally {
    templatesLoading.value = false
  }
}

async function openTemplateDialog() {
  templateDialogVisible.value = true
  await loadTemplates()
}

async function createFromTemplate(template) {
  if (!template?.id || isTemplateActionBusy(template, 'create')) return
  setTemplateActionBusy(template, 'create', true)
  try {
    const task = await createTaskFromTemplate(template.id, { name: `${template.config?.name || template.name || '同步任务'} 副本` })
    ElMessage.success(`已从模板创建：${task.name}`)
    templateDialogVisible.value = false
    await loadAll()
  } catch (err) {
    ElMessage.error('从模板创建失败: ' + err.message)
  } finally {
    setTemplateActionBusy(template, 'create', false)
  }
}

async function removeTemplate(template) {
  if (!template?.id || isTemplateActionBusy(template, 'delete')) return
  try {
    await ElMessageBox.confirm(`确定删除模板「${template.name}」？`, '删除模板', { type: 'warning' })
    setTemplateActionBusy(template, 'delete', true)
    await deleteTaskTemplate(template.id)
    ElMessage.success('模板已删除')
    await loadTemplates()
  } catch (err) {
    if (err === 'cancel' || err?.message === 'cancel') return
    ElMessage.error('删除模板失败: ' + (err.message || err))
  } finally {
    setTemplateActionBusy(template, 'delete', false)
  }
}

async function manualRun(task) {
  const uiState = taskUiState(task)
  if (!task?.id || uiState.manualRunDisabled) return
  if (uiState.realtime) {
    ElMessage.warning('准实时同步任务由启动/停止调度控制，无需手动同步')
    return
  }
  setTaskActionBusy(task, 'manualRun', true)
  task._running = true
  try {
    await runTask(task.id)
    // 后端立即返回 {started:true} 再异步执行，等待同步完成再显示结果
    ElMessage.info('正在同步，请稍候…')
    taskProgress.value[task.id] = { taskId: task.id, status: 'running', phase: 'starting', processedRows: 0 }
    startProgressPolling()
    setTimeout(loadAll, 2000)
  } catch (err) {
    if (err.preflight) {
      preflightResult.value = err.preflight
      preflightDialogVisible.value = true
      ElMessage.error('预检未通过，已阻止同步')
    } else {
      ElMessage.error('启动失败: ' + err.message)
    }
    setTimeout(loadAll, 1000)
  } finally {
    task._running = false
    setTaskActionBusy(task, 'manualRun', false)
  }
}

async function restartFullSync(task) {
  if (!task?.id || isRestartFullSyncDisabled(task)) return
  try {
    await ElMessageBox.confirm('确定清理该任务的断点和增量水位，并重新开始全量同步？目标端已有数据会按主键更新或跳过，不会自动清空。', '重新开始全量同步', { type: 'warning' })
    setTaskActionBusy(task, 'restartFullSync', true)
    task._running = true
    await runTask(task.id, { resetState: true })
    ElMessage.info('已重新开始全量同步，请在进度和日志中查看状态')
    taskProgress.value[task.id] = { taskId: task.id, status: 'running', phase: 'starting', processedRows: 0 }
    startProgressPolling()
    setTimeout(loadAll, 2000)
  } catch (err) {
    if (err === 'cancel' || err?.message === 'cancel') return
    if (err.preflight) {
      preflightResult.value = err.preflight
      preflightDialogVisible.value = true
      ElMessage.error('预检未通过，已阻止重跑全量')
    } else {
      ElMessage.error('重跑全量失败: ' + (err.message || err))
    }
  } finally {
    task._running = false
    setTaskActionBusy(task, 'restartFullSync', false)
  }
}

async function continueInitialization(task) {
  if (!task?.id || isContinueInitializationDisabled(task)) return
  setTaskActionBusy(task, 'continueInitialization', true)
  try {
    task._running = true
    await continueInitialSync(task.id)
    ElMessage.info('已继续初始化同步，请在进度和日志中查看状态')
    taskProgress.value[task.id] = { taskId: task.id, status: 'running', phase: 'starting', processedRows: 0 }
    startProgressPolling()
    setTimeout(loadAll, 2000)
  } catch (err) {
    if (err.preflight) {
      preflightResult.value = err.preflight
      preflightDialogVisible.value = true
      ElMessage.error('预检未通过，已阻止继续初始化')
    } else {
      ElMessage.error('继续初始化失败: ' + (err.message || err))
    }
  } finally {
    task._running = false
    setTaskActionBusy(task, 'continueInitialization', false)
  }
}

async function cancelRunningTask(task) {
  if (!task?.id || isTaskActionBusy(task, 'cancel') || isCancellingTask(task)) return
  try {
    await ElMessageBox.confirm('确定取消当前正在执行的同步？已写入的数据会保留，本次不会推进增量水位。', '取消同步', { type: 'warning' })
    setTaskActionBusy(task, 'cancel', true)
    await cancelTask(task.id)
    taskProgress.value[task.id] = { ...(taskProgress.value[task.id] || {}), taskId: task.id, status: 'cancelling', phase: 'cancelling' }
    ElMessage.warning('已请求取消同步')
    startProgressPolling()
  } catch (err) {
    if (err !== 'cancel') ElMessage.error('取消失败: ' + (err.message || err))
  } finally {
    setTaskActionBusy(task, 'cancel', false)
  }
}

function preflightStatusLabel(status) {
  return { pass: '通过', warn: '有风险', fail: '未通过' }[status] || status
}

function preflightIssueLevelLabel(level) {
  return { error: '错误', warn: '警告', info: '提示' }[level] || level
}

function preflightIssueTagType(level) {
  if (level === 'error') return 'danger'
  if (level === 'warn') return 'warning'
  return 'info'
}

function preflightDurationLabel(estimate) {
  if (!estimate?.estimatedDurationMinutes) return '未限速'
  const { min, max } = estimate.estimatedDurationMinutes
  return `${formatNumber(min)}-${formatNumber(max)} 分钟`
}

function schemaDriftStatusLabel(status) {
  return { unchanged: '无变化', changed: '有变化', no_snapshot: '无快照' }[status] || status
}

function schemaDriftRows(group = {}) {
  return [
    ...(group.added || []).map(field => ({ change: '新增', name: field.name, before: '-', after: field.type })),
    ...(group.removed || []).map(field => ({ change: '删除', name: field.name, before: field.type, after: '-' })),
    ...(group.typeChanged || []).map(field => ({ change: '类型变化', name: field.name, before: field.before, after: field.after })),
  ]
}

async function runPreflight(task) {
  if (!task?.id || isTaskActionBusy(task, 'preflight')) return
  setTaskActionBusy(task, 'preflight', true)
  preflightDialogVisible.value = true
  preflightLoading.value = true
  preflightResult.value = null
  try {
    preflightResult.value = await preflightTask(task.id)
    if (preflightResult.value.status === 'pass') ElMessage.success('预检通过')
    else if (preflightResult.value.status === 'warn') ElMessage.warning('预检发现 ' + preflightResult.value.summary.warn + ' 个风险')
    else ElMessage.error('预检未通过：' + preflightResult.value.summary.error + ' 个错误')
  } catch (err) {
    if (err.preflight) {
      preflightResult.value = err.preflight
      ElMessage.error('预检未通过：' + err.message)
      return
    }
    ElMessage.error('预检失败: ' + err.message)
    preflightDialogVisible.value = false
  } finally {
    preflightLoading.value = false
    setTaskActionBusy(task, 'preflight', false)
  }
}

async function checkSchemaDrift(task) {
  if (!task?.id || isTaskActionBusy(task, 'schemaDrift')) return
  setTaskActionBusy(task, 'schemaDrift', true)
  selectedSchemaTask.value = task
  schemaDriftDialogVisible.value = true
  schemaDriftLoading.value = true
  schemaDriftResult.value = null
  try {
    schemaDriftResult.value = await getTaskSchemaDrift(task.id)
    if (schemaDriftResult.value.status === 'changed') ElMessage.warning('检测到字段结构变化')
    else if (schemaDriftResult.value.status === 'no_snapshot') ElMessage.info('此任务还没有字段快照')
    else ElMessage.success('字段结构无变化')
  } catch (err) {
    ElMessage.error('字段检测失败: ' + err.message)
    schemaDriftDialogVisible.value = false
  } finally {
    schemaDriftLoading.value = false
    setTaskActionBusy(task, 'schemaDrift', false)
  }
}

async function refreshSchemaSnapshot() {
  if (!selectedSchemaTask.value) return
  schemaSnapshotSaving.value = true
  try {
    await refreshTaskSchemaSnapshot(selectedSchemaTask.value.id)
    ElMessage.success('字段快照已刷新')
    await loadAll()
    schemaDriftResult.value = await getTaskSchemaDrift(selectedSchemaTask.value.id)
  } catch (err) {
    ElMessage.error('刷新快照失败: ' + err.message)
  } finally {
    schemaSnapshotSaving.value = false
  }
}

async function runReconcile(task) {
  if (!task?.id || isTaskActionBusy(task, 'reconcile')) return
  setTaskActionBusy(task, 'reconcile', true)
  reconcileDialogVisible.value = true
  reconcileLoading.value = true
  reconcileResult.value = null
  try {
    reconcileResult.value = await reconcileTask(task.id, { limit: 10000, sampleLimit: 100 })
    const drift = reconcileResult.value.missingInTarget + reconcileResult.value.extraInTarget + reconcileResult.value.mismatched
    if (drift === 0) ElMessage.success('校验完成：源端和目标端一致')
    else ElMessage.warning(`校验完成：发现 ${drift} 处差异`)
  } catch (err) {
    ElMessage.error('校验失败: ' + err.message)
    reconcileDialogVisible.value = false
  } finally {
    reconcileLoading.value = false
    setTaskActionBusy(task, 'reconcile', false)
  }
}

async function openFailures(task) {
  selectedFailureTask.value = task
  failuresDialogVisible.value = true
  failuresLoading.value = true
  try {
    taskFailures.value = await getTaskFailures(task.id)
  } catch (err) {
    ElMessage.error('获取失败记录失败: ' + err.message)
  } finally {
    failuresLoading.value = false
  }
}

async function retryFailures() {
  if (!selectedFailureTask.value || failuresLoading.value) return
  failuresLoading.value = true
  try {
    const result = await retryTaskFailures(selectedFailureTask.value.id)
    ElMessage.success(`已重试 ${result.retried} 个批次${result.failed ? `，仍失败 ${result.failed} 个` : ''}`)
    taskFailures.value = await getTaskFailures(selectedFailureTask.value.id)
    failureCounts.value = await getFailureCounts()
  } catch (err) {
    ElMessage.error('重试失败: ' + err.message)
  } finally {
    failuresLoading.value = false
  }
}

async function retrySingleFailure(failure) {
  if (!selectedFailureTask.value || !failure?.id || failureRetryingId.value === failure.id) return
  failureRetryingId.value = failure.id
  try {
    const result = await retryTaskFailure(selectedFailureTask.value.id, failure.id)
    ElMessage.success(`已重试批次${result.inserted ? `，新增 ${result.inserted}` : ''}${result.updated ? `，更新 ${result.updated}` : ''}${result.deleted ? `，删除 ${result.deleted}` : ''}`)
    taskFailures.value = await getTaskFailures(selectedFailureTask.value.id)
    failureCounts.value = await getFailureCounts()
    taskHealth.value = await getTasksHealth()
    await refreshTaskHistory()
  } catch (err) {
    ElMessage.error('单批重试失败: ' + err.message)
    taskFailures.value = await getTaskFailures(selectedFailureTask.value.id).catch(() => taskFailures.value)
  } finally {
    failureRetryingId.value = null
  }
}

async function clearFailures() {
  if (!selectedFailureTask.value || failuresLoading.value) return
  await ElMessageBox.confirm('确定清空该任务的失败记录？这不会改动 Teable 数据。', '清空失败记录', { type: 'warning' })
  failuresLoading.value = true
  try {
    await clearTaskFailures(selectedFailureTask.value.id)
    taskFailures.value = []
    failureCounts.value = await getFailureCounts()
    ElMessage.success('失败记录已清空')
  } catch (err) {
    ElMessage.error('清空失败: ' + err.message)
  } finally {
    failuresLoading.value = false
  }
}

async function refreshTaskLogs() {
  if (!selectedLogTask.value) return
  taskLogsLoading.value = true
  try {
    taskLogs.value = await getLogs({ taskId: selectedLogTask.value.id })
  } catch (err) {
    ElMessage.error('获取任务日志失败: ' + err.message)
    taskLogs.value = []
  } finally {
    taskLogsLoading.value = false
  }
}

async function openTaskLogs(task) {
  selectedLogTask.value = task
  taskLogs.value = []
  taskLogsDialogVisible.value = true
  await refreshTaskLogs()
}

async function refreshTaskDetailLogs() {
  if (!detailTask.value) return
  taskDetailLogsLoading.value = true
  try {
    taskDetailLogs.value = await getLogs({ taskId: detailTask.value.id })
  } catch (err) {
    ElMessage.error('获取任务日志失败: ' + err.message)
    taskDetailLogs.value = []
  } finally {
    taskDetailLogsLoading.value = false
  }
}

async function refreshTaskHistory() {
  if (!detailTask.value) return
  taskHistoryLoading.value = true
  try {
    taskHistory.value = await getSyncHistory({ taskId: detailTask.value.id, limit: 20 })
  } catch (err) {
    ElMessage.error('获取运行历史失败: ' + err.message)
    taskHistory.value = []
  } finally {
    taskHistoryLoading.value = false
  }
}

async function refreshTaskInitialization() {
  if (!detailTask.value) return
  taskInitializationLoading.value = true
  try {
    taskInitialization.value = await getTaskInitialization(detailTask.value.id)
  } catch (err) {
    taskInitialization.value = null
  } finally {
    taskInitializationLoading.value = false
  }
}

async function openTaskDetail(task) {
  detailTask.value = task
  taskDetailLogs.value = []
  taskHistory.value = []
  taskInitialization.value = null
  taskDetailDialogVisible.value = true
  await Promise.all([refreshTaskDetailLogs(), refreshTaskHistory(), refreshTaskInitialization()])
}

async function handleFocusAction(action = {}) {
  if (!action?.taskId && action.actionTarget !== 'connections') return
  if (action.actionTarget === 'connections') {
    emit('resolve-action', action)
    return
  }
  if (!tasks.value.length) await loadAll()
  const task = tasks.value.find((item) => item.id === action.taskId)
  if (!task) {
    ElMessage.warning('未找到对应任务，可能已被删除或无权查看')
    return
  }
  taskFilter.value = 'all'
  taskSearch.value = ''
  const target = action.actionTarget || 'task_detail'
  if (target === 'task_failures') {
    await openFailures(task)
  } else if (target === 'task_preflight') {
    await runPreflight(task)
  } else if (['task_mapping', 'task_settings'].includes(target)) {
    await openDialog(task)
  } else {
    await openTaskDetail(task)
  }
}

async function toggleSync(task) {
  if (!task?.id || isScheduleActionDisabled(task)) return
  setTaskActionBusy(task, 'schedule', true)
  if (task.status === 'scheduled' || schedulerStatus.value[task.id]) {
    // Stop auto-sync
    try {
      await stopTask(task.id)
      ElMessage.success('已停止自动同步')
      await loadAll()
    } catch (err) {
      ElMessage.error('停止失败: ' + err.message)
    } finally {
      setTaskActionBusy(task, 'schedule', false)
    }
  } else {
    // Start auto-sync
    if (!task.syncMode || task.syncMode === 'manual') {
      ElMessage.warning('请先编辑任务，设置同步模式为「定时」或「实时」')
      setTaskActionBusy(task, 'schedule', false)
      return
    }
    try {
      await startTask(task.id)
      ElMessage.success(`已启动${syncModeLabel(task.syncMode)}同步`)
      startProgressPolling()
      await loadAll()
    } catch (err) {
      if (err.preflight) {
        preflightResult.value = err.preflight
        preflightDialogVisible.value = true
        ElMessage.error('预检未通过，已阻止启动')
      } else {
        ElMessage.error('启动失败: ' + err.message)
      }
    } finally {
      setTaskActionBusy(task, 'schedule', false)
    }
  }
}

onMounted(async () => {
  await loadAll()
  startProgressPolling()
})

watch(() => props.focusAction, (action) => {
  if (action) handleFocusAction(action)
}, { immediate: true })

onUnmounted(() => {
  if (progressTimer) window.clearInterval(progressTimer)
  progressTimer = null
})
</script>

<style scoped>
.tasks-page {
  display: grid;
  gap: 18px;
}

.task-overview {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.summary-tile {
  display: grid;
  gap: 8px;
  text-align: left;
  padding: 14px 16px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  cursor: pointer;
  font-family: var(--font-sans);
}
.summary-tile:hover,
.summary-tile.active {
  border-color: var(--accent);
  background: var(--accent-muted);
}
.summary-tile span {
  font-size: 12px;
  color: var(--text-tertiary);
}
.summary-tile strong {
  font-size: 24px;
  line-height: 1;
  color: var(--text-primary);
}

.task-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.task-search {
  max-width: 360px;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.task-card {
  padding: 18px 20px;
  border-left: 3px solid transparent;
}
.task-card.attention { border-left-color: var(--red); }
.task-card.invalid { border-left-color: var(--amber); }
.task-card.running { border-left-color: var(--accent); }

.task-card-top {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto;
  align-items: start;
  gap: 18px;
  margin-bottom: 14px;
}

.task-name {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.task-flow {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.flow-source { color: var(--amber); font-weight: 500; }
.flow-target { color: var(--cyan); font-weight: 500; }
.flow-arrow { color: var(--text-tertiary); display: flex; align-items: center; }
.flow-arrow-inline { color: var(--accent); font-weight: bold; }

.task-actions {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  flex-direction: column;
  justify-content: flex-start;
}

.icon-btn-danger:hover { color: var(--red) !important; background: rgba(239,68,68,0.1) !important; }

.task-badges,
.task-primary-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.task-primary-actions .fs-btn {
  padding: 8px 14px;
  font-size: 13px;
  white-space: nowrap;
}

.more-action {
  min-width: 64px;
}

.task-card-summary {
  padding-top: 16px;
  border-top: 1px solid var(--border-subtle);
}

.summary-row {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  color: var(--text-secondary);
  font-size: 13px;
}

.summary-row span {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.summary-row strong {
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 500;
}

.detail-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-tertiary);
}

.detail-value {
  font-size: 13px;
  color: var(--text-secondary);
  min-width: 0;
  overflow-wrap: anywhere;
}
.detail-value.mono { font-family: var(--font-mono); }
.detail-value.empty { color: var(--text-tertiary); font-style: italic; }

.progress-panel {
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.progress-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  font-size: 12px;
}

.progress-phase {
  color: var(--text-primary);
  font-weight: 600;
}

.progress-meta {
  color: var(--text-tertiary);
  text-align: right;
}

.strategy-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
}
.strategy-badge.upsert { background: rgba(99,102,241,0.15); color: var(--accent-hover); }
.strategy-badge.skip { background: rgba(245,158,11,0.15); color: var(--amber); }
.strategy-badge.insert_only { background: rgba(16,185,129,0.15); color: var(--green); }
.strategy-badge.source_wins { background: rgba(99,102,241,0.15); color: var(--accent-hover); }
.strategy-badge.target_wins { background: rgba(5,150,105,0.15); color: var(--green); }
.strategy-badge.latest_wins { background: rgba(14,165,233,0.15); color: #0284c7; }
.strategy-badge.skip_conflict { background: rgba(245,158,11,0.15); color: var(--amber); }

.direction-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
}
.direction-badge.one_way { background: rgba(148,149,160,0.12); color: var(--text-tertiary); }
.direction-badge.bidirectional { background: rgba(14,165,233,0.15); color: #0284c7; }

.watermark-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
}
.watermark-badge.auto, .watermark-badge.timestamp { background: rgba(99,102,241,0.15); color: var(--accent-hover); }
.watermark-badge.rowversion { background: rgba(16,185,129,0.15); color: var(--green); }
.watermark-badge.auto_pk { background: rgba(245,158,11,0.15); color: var(--amber); }
.watermark-badge.full_scan { background: rgba(148,149,160,0.12); color: var(--text-tertiary); }

.status-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.6;
}
.status-idle { background: rgba(148,149,160,0.12); color: var(--text-tertiary); }
.status-running { background: rgba(99,102,241,0.12); color: var(--accent); animation: pulse 2s ease-in-out infinite; }
.status-scheduled { background: rgba(5,150,105,0.12); color: var(--green); }
.status-error { background: rgba(220,38,38,0.12); color: var(--red); }

.health-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.6;
}
.health-badge.healthy { background: rgba(5,150,105,0.12); color: var(--green); }
.health-badge.has_failures,
.health-badge.recent_failed { background: rgba(220,38,38,0.12); color: var(--red); }
.health-badge.invalid { background: rgba(245,158,11,0.16); color: var(--amber); }
.health-badge.cancelled,
.health-badge.never_run,
.health-badge.unknown { background: rgba(148,149,160,0.12); color: var(--text-tertiary); }
.health-badge.running { background: rgba(99,102,241,0.12); color: var(--accent); }

.health-line {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 12px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.task-warning-line {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 10px;
  color: var(--red);
  font-size: 12px;
}

.task-warning-line span {
  max-width: 520px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-warning-line .task-suggestion-line {
  color: var(--amber);
}

.inline-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 24px;
  padding: 2px 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.inline-action-btn:hover {
  border-color: var(--accent);
  background: var(--accent-muted);
}
.health-error {
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--red);
}

.state-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 12px;
}

.state-item {
  display: grid;
  gap: 4px;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.state-label {
  font-size: 11px;
  color: var(--text-tertiary);
}

.state-item strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--text-secondary);
}

.state-active { border-color: rgba(99,102,241,0.35); background: rgba(99,102,241,0.08); }
.state-good { border-color: rgba(5,150,105,0.28); background: rgba(5,150,105,0.08); }
.state-warn { border-color: rgba(245,158,11,0.32); background: rgba(245,158,11,0.09); }
.state-bad { border-color: rgba(220,38,38,0.30); background: rgba(220,38,38,0.08); }
.state-muted { color: var(--text-tertiary); }

.task-log-list {
  max-height: 520px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
}

.task-log-row {
  display: grid;
  grid-template-columns: 160px 58px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 13px;
}

.task-log-row:last-child { border-bottom: 0; }
.task-log-row.log-error { background: rgba(220,38,38,0.04); }
.task-log-row.log-warn { background: rgba(217,119,6,0.04); }

.task-log-time {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 12px;
}

.task-log-level {
  justify-self: start;
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 700;
}
.task-log-level.info { background: rgba(37,99,235,0.10); color: #2563eb; }
.task-log-level.warn { background: rgba(217,119,6,0.12); color: var(--amber); }
.task-log-level.error { background: rgba(220,38,38,0.12); color: var(--red); }

.task-log-message {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-secondary);
  line-height: 1.5;
}

.task-detail-shell {
  display: grid;
  gap: 16px;
  min-width: 0;
  max-width: 100%;
  overflow-x: hidden;
}

.detail-hero {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 14px 16px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.detail-hero-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.detail-hero-flow {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  color: var(--text-secondary);
  font-size: 13px;
}

.detail-hero-badges {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.detail-tabs {
  min-height: 420px;
}

.detail-panel-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.detail-metric {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.detail-metric.neutral {
  background: rgba(100,116,139,0.08);
}

.detail-metric span,
.detail-kv-grid span {
  color: var(--text-tertiary);
  font-size: 11px;
}

.detail-metric strong,
.detail-kv-grid strong {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-primary);
  font-size: 13px;
}

.detail-progress {
  margin-top: 12px;
}

.history-metrics {
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin-bottom: 12px;
}

.task-detail-shell :deep(.el-table) {
  max-width: 100%;
}

.task-detail-shell :deep(.el-table__body-wrapper),
.task-detail-shell :deep(.el-table__header-wrapper) {
  overflow-x: auto;
}

.history-hint {
  margin-top: 8px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.run-dot.noop {
  background: var(--text-tertiary);
}
.run-trend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  min-height: 18px;
}
.run-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--text-tertiary);
}
.run-dot.success { background: var(--green); }
.run-dot.failed,
.run-dot.cancelled { background: var(--red); }
.run-dot.paused,
.run-dot.running { background: var(--amber); }

@media (max-width: 900px) {
  .detail-panel-grid,
  .history-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .detail-hero {
    flex-direction: column;
  }

  .detail-hero-badges {
    justify-content: flex-start;
  }

  .detail-panel-grid,
  .history-metrics {
    grid-template-columns: 1fr;
  }
}

.detail-section {
  margin-top: 14px;
}

.init-resume-box {
  padding: 12px;
  border: 1px solid rgba(245,158,11,0.35);
  border-radius: var(--radius-sm);
  background: rgba(245,158,11,0.06);
}

.detail-section-title {
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 700;
}

.detail-section-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.detail-count {
  color: var(--text-tertiary);
  font-size: 12px;
}

.detail-kv-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.detail-kv-grid.wide {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.detail-action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.detail-kv-grid > div {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 11px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.detail-empty-line {
  padding: 12px;
  border: 1px dashed var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-tertiary);
  font-size: 13px;
}

.detail-error-line {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: rgba(220,38,38,0.08);
  color: var(--red);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.detail-suggestion-line,
.history-suggestion-line {
  margin-top: 4px;
  color: var(--amber);
}

.detail-suggestion-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.history-error-cell {
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.detail-log-list {
  max-height: 430px;
}

.table-mini-btn {
  min-height: 28px;
  padding: 4px 10px;
  font-size: 12px;
}

.connection-issues {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.connection-issue {
  max-width: 100%;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.connection-issue.error {
  background: rgba(220,38,38,0.1);
  color: var(--red);
}

.connection-issue.warn {
  background: rgba(245,158,11,0.14);
  color: var(--amber);
}

.reconcile-summary {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
  margin-bottom: 14px;
}

.reconcile-summary > div {
  padding: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.reconcile-summary strong {
  display: block;
  margin-top: 4px;
  color: var(--text-primary);
  font-size: 18px;
}

.diff-line {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.sync-mode-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}
.sync-mode-badge.manual { background: rgba(148,149,160,0.12); color: var(--text-tertiary); }
.sync-mode-badge.scheduled { background: rgba(217,119,6,0.12); color: var(--amber); }
.sync-mode-badge.realtime { background: rgba(5,150,105,0.12); color: var(--green); }

.interval-text { color: var(--text-tertiary); font-size: 12px; margin-left: 4px; }

.fs-btn-success {
  background: var(--green) !important;
  color: #fff !important;
  border: none !important;
}
.fs-btn-success:hover { filter: brightness(1.1); }
.fs-btn-danger {
  background: var(--red) !important;
  color: #fff !important;
  border: none !important;
}
.fs-btn-danger:hover { filter: brightness(1.1); }

.section-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 20px 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-subtle);
}
.section-icon { font-size: 14px; opacity: 0.6; }

.form-help {
  margin-top: 6px;
  color: var(--text-tertiary);
  font-size: 12px;
  line-height: 1.4;
}

.mapping-area {
  background: var(--bg-elevated);
  padding: 16px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}

/* Confidence indicators */
.conf-exact { color: var(--green); font-weight: bold; font-size: 14px; }
.conf-high { color: var(--cyan); font-size: 14px; }
.conf-medium { color: var(--amber); font-size: 14px; }
.conf-low { color: var(--text-tertiary); font-size: 14px; }
.conf-create { color: var(--accent); font-size: 14px; }

/* Type compatibility tags */
.compat-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}
.compat-safe { background: rgba(16,185,129,0.12); color: var(--green); }
.compat-warn { background: rgba(245,158,11,0.12); color: var(--amber); cursor: help; }
.compat-unknown { color: var(--text-tertiary); }
.compat-action {
  border: 1px solid rgba(245,158,11,0.35);
  background: rgba(245,158,11,0.10);
  color: var(--amber);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}
.compat-action.forced {
  border-color: rgba(239,68,68,0.45);
  background: rgba(239,68,68,0.10);
  color: var(--red);
}
:deep(.mapping-row-skipped) {
  opacity: 0.58;
  background: rgba(245,158,11,0.05);
}

@media (max-width: 1100px) {
  .task-overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .detail-panel-grid,
  .detail-kv-grid,
  .detail-kv-grid.wide { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .state-strip { grid-template-columns: 1fr; }
  .task-card-top {
    flex-direction: column;
    align-items: stretch;
  }
  .task-card-top { grid-template-columns: 1fr; }
  .task-actions { align-items: stretch; }
  .task-badges,
  .task-primary-actions { justify-content: flex-start; }
}

@media (max-width: 720px) {
  .task-overview { grid-template-columns: 1fr; }
  .task-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .task-search { max-width: none; }
  .detail-hero { flex-direction: column; }
  .detail-hero-badges { justify-content: flex-start; }
  .detail-panel-grid,
  .detail-kv-grid,
  .detail-kv-grid.wide { grid-template-columns: 1fr; }
  .task-log-row { grid-template-columns: 1fr; }
}
</style>

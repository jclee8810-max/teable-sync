<template>
  <div class="observability-page">
    <div class="obs-toolbar">
      <div class="obs-generated">
        <span>快照时间</span>
        <strong>{{ snapshot?.generatedAt ? formatDateTime(snapshot.generatedAt) : '-' }}</strong>
      </div>
      <div class="obs-actions">
        <button class="fs-btn fs-btn-primary" @click="loadSnapshot" :disabled="loading" style="padding:8px 16px;font-size:13px">
          <el-icon><Refresh /></el-icon>{{ loading ? '刷新中...' : '刷新' }}
        </button>
      </div>
    </div>

    <div class="obs-summary compact">
      <button class="obs-tile critical" type="button" @click="alertFilter = ''" :class="{ active: alertFilter === '' }">
        <span>待处理告警</span>
        <strong>{{ summary.activeAlerts ?? summary.openAlerts ?? 0 }}</strong>
      </button>
      <button class="obs-tile warning" type="button" @click="alertFilter = 'critical'" :class="{ active: alertFilter === 'critical' }">
        <span>严重告警</span>
        <strong>{{ summary.criticalAlerts || 0 }}</strong>
      </button>
      <button class="obs-tile" type="button" @click="showHealthyTasks = false">
        <span>异常任务</span>
        <strong>{{ unhealthyTaskCount }}</strong>
      </button>
      <div class="obs-tile">
        <span>24h 成功率</span>
        <strong>{{ summary.successRate24h === null || summary.successRate24h === undefined ? '-' : summary.successRate24h + '%' }}</strong>
      </div>
    </div>

    <div v-if="isAdmin" class="notification-strip">
      <div>
        <strong>告警通知</strong>
        <span>{{ notificationStatusText }}</span>
      </div>
      <button class="fs-btn fs-btn-ghost" @click="openNotificationDialog" style="padding:8px 16px;font-size:13px">
        <el-icon><Bell /></el-icon>设置通知
      </button>
    </div>

    <div class="obs-grid">
      <section class="obs-section alerts-section">
        <div class="section-head">
          <div>
            <strong>活跃告警</strong>
            <span>按任务健康、连接状态、失败批次和调度状态自动判定</span>
          </div>
          <em>{{ filteredAlerts.length }} 条</em>
        </div>
        <div class="alert-list" v-loading="loading">
          <div v-for="item in filteredAlerts" :key="item.id" class="alert-row" :class="[item.severity, item.state]">
            <div class="alert-main">
              <span class="alert-severity">{{ severityLabel(item.severity) }}</span>
              <strong>{{ item.title }}</strong>
              <p>{{ item.message }}</p>
              <small v-if="alertSuggestedAction(item)" class="alert-suggestion">建议：{{ alertSuggestedAction(item) }}</small>
              <small v-if="item.state !== 'open'" class="alert-state-note">{{ alertStateDetail(item) }}</small>
            </div>
            <div class="alert-meta">
              <span>{{ item.taskName || item.metadata?.connectionName || '系统' }}</span>
              <small>{{ alertTypeLabel(item.type) }}</small>
              <em :class="['alert-state', item.state]">{{ alertStateLabel(item.state) }}</em>
              <div class="alert-actions">
                <button type="button" class="primary-action" @click="resolveAlert(item)">{{ actionLabel(item.metadata?.actionTarget || defaultActionTarget(item)) }}</button>
                <button v-if="item.state === 'open'" type="button" @click="ackAlert(item)">确认</button>
                <button v-if="item.state === 'open'" type="button" @click="muteAlertFor(item)">静默1h</button>
                <button v-if="item.state !== 'open'" type="button" @click="restoreAlertState(item)">恢复</button>
              </div>
            </div>
          </div>
          <el-empty v-if="!loading && filteredAlerts.length === 0" description="当前没有匹配告警" :image-size="72" />
        </div>
      </section>

      <section class="obs-section run-section">
        <div class="section-head compact-head">
          <div>
            <strong>24 小时运行摘要</strong>
            <span>用于判断整体是否稳定，详细执行记录看任务详情或日志。</span>
          </div>
        </div>
        <div class="run-metrics compact">
          <div><span>运行次数</span><strong>{{ summary.runs24h || 0 }}</strong></div>
          <div><span>失败</span><strong>{{ summary.failedRuns24h || 0 }}</strong></div>
          <div><span>警告日志</span><strong>{{ summary.warningLogs24h || 0 }}</strong></div>
          <div><span>平均耗时</span><strong>{{ formatDuration(summary.averageDurationMs) }}</strong></div>
        </div>
      </section>
    </div>

    <section class="obs-section">
      <div class="section-head">
        <div>
          <strong>任务健康</strong>
          <span>默认只显示异常任务；需要巡检时再展开全部。</span>
        </div>
        <button class="section-toggle" type="button" @click="showHealthyTasks = !showHealthyTasks">
          {{ showHealthyTasks ? '只看异常' : `查看全部 ${taskRows.length} 个` }}
        </button>
      </div>
      <el-table :data="visibleTaskRows" size="small" border v-loading="loading" :empty-text="showHealthyTasks ? '暂无任务' : '当前没有异常任务'">
        <el-table-column prop="name" label="任务" min-width="190" show-overflow-tooltip />
        <el-table-column label="健康" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="healthTagType(row.health?.status)">{{ healthLabel(row.health?.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="调度" width="130">
          <template #default="{ row }">
            {{ scheduleLabel(row) }}
          </template>
        </el-table-column>
        <el-table-column label="最近结果" width="130">
          <template #default="{ row }">{{ latestStatusLabel(row.health?.latestStatus) }}</template>
        </el-table-column>
        <el-table-column label="成功率" width="90">
          <template #default="{ row }">{{ row.health?.successRate === null || row.health?.successRate === undefined ? '-' : row.health.successRate + '%' }}</template>
        </el-table-column>
        <el-table-column label="失败批次" width="90">
          <template #default="{ row }">{{ row.pendingFailures || 0 }}</template>
        </el-table-column>
        <el-table-column label="上次同步" width="170">
          <template #default="{ row }">{{ row.lastSyncAt ? formatDateTime(row.lastSyncAt) : '-' }}</template>
        </el-table-column>
        <el-table-column label="最近错误 / 建议" min-width="260" show-overflow-tooltip>
          <template #default="{ row }">
            <div v-if="row.health?.latestError" class="obs-error-cell">
              <div>{{ row.health.latestError }}</div>
              <div v-if="row.health.latestSuggestedAction" class="obs-suggestion-line">建议：{{ row.health.latestSuggestedAction }}</div>
            </div>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="处理" width="110" fixed="right">
          <template #default="{ row }">
            <button class="table-action-btn" type="button" @click="resolveTaskRow(row)" :disabled="!row.id">
              {{ actionLabel(row.health?.latestActionTarget || (row.pendingFailures ? 'task_failures' : 'task_detail')) }}
            </button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <section class="obs-section logs-collapse">
      <button class="logs-toggle" type="button" @click="logsOpen = !logsOpen">
        <span>最近警告/错误日志</span>
        <small>需要定位原因时展开；完整日志仍在“日志”页面。</small>
        <strong>{{ logsOpen ? '收起' : `展开 ${recentLogs.length} 条` }}</strong>
      </button>
      <div v-if="logsOpen" class="obs-log-list">
        <div v-for="(log, idx) in recentLogs" :key="idx" class="obs-log-row" :class="'log-' + log.level">
          <span class="log-time">{{ formatDateTime(log.ts) }}</span>
          <span class="log-level" :class="log.level">{{ levelLabel(log.level) }}</span>
          <span class="log-msg">{{ log.message }}</span>
        </div>
        <el-empty v-if="recentLogs.length === 0" description="暂无警告或错误日志" :image-size="72" />
      </div>
    </section>

    <el-dialog v-model="notificationDialogVisible" title="告警通知" width="560px" class="notification-dialog">
      <el-form label-position="top" class="notification-form">
        <el-form-item label="Webhook 通知">
          <el-switch v-model="notificationForm.enabled" active-text="启用" inactive-text="关闭" />
        </el-form-item>
        <el-form-item label="Webhook URL">
          <el-input
            v-model="notificationForm.webhookUrl"
            type="password"
            show-password
            clearable
            placeholder="粘贴 Teable 自动化或其他系统的 Webhook URL"
          />
          <div v-if="notificationSettings?.hasWebhookUrl" class="field-hint">已保存：{{ notificationSettings.webhookUrl }}</div>
        </el-form-item>
        <label v-if="notificationSettings?.hasWebhookUrl" class="clear-webhook-option">
          <input type="checkbox" v-model="notificationClearWebhook" />
          <span>保存时清空已保存的 Webhook URL</span>
        </label>
        <div class="notification-options">
          <el-form-item label="发送阈值">
            <el-select v-model="notificationForm.minSeverity" style="width:100%">
              <el-option label="仅严重" value="critical" />
              <el-option label="严重和警告" value="warning" />
              <el-option label="全部告警" value="info" />
            </el-select>
          </el-form-item>
          <el-form-item label="同一告警冷却">
            <el-input-number v-model="notificationForm.cooldownMinutes" :min="1" :max="1440" controls-position="right" style="width:100%">
              <template #suffix>分钟</template>
            </el-input-number>
            <div class="field-hint">同一个告警在冷却时间内不会重复发送，范围 1-1440 分钟。</div>
          </el-form-item>
        </div>
        <div class="notification-status">
          <span>上次发送：{{ notificationSettings?.lastSentAt ? formatDateTime(notificationSettings.lastSentAt) : '-' }}</span>
          <span>上次测试：{{ notificationSettings?.lastTestAt ? formatDateTime(notificationSettings.lastTestAt) : '-' }}</span>
          <span v-if="notificationSettings?.lastError" class="status-error">最近错误：{{ notificationSettings.lastError }}</span>
        </div>
      </el-form>
      <template #footer>
        <button class="fs-btn fs-btn-ghost" @click="notificationDialogVisible = false">取消</button>
        <button class="fs-btn fs-btn-ghost" :disabled="notificationSaving || notificationTesting" @click="sendTestNotification">
          <el-icon><Promotion /></el-icon>测试发送
        </button>
        <button class="fs-btn fs-btn-primary" :disabled="notificationSaving" @click="saveNotificationSettings">
          <el-icon><Check /></el-icon>{{ notificationSaving ? '保存中...' : '保存' }}
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Bell, Check, Promotion, Refresh } from '@element-plus/icons-vue'
import {
  acknowledgeAlert,
  getAlertNotificationSettings,
  getObservability,
  muteAlert,
  restoreAlert,
  getStoredUser,
  testAlertNotification,
  updateAlertNotificationSettings,
} from '../api'

const emit = defineEmits(['resolve-action'])

const loading = ref(false)
const snapshot = ref(null)
const alertFilter = ref('')
const showHealthyTasks = ref(false)
const logsOpen = ref(false)
const notificationDialogVisible = ref(false)
const notificationLoading = ref(false)
const notificationSaving = ref(false)
const notificationTesting = ref(false)
const notificationSettings = ref(null)
const notificationClearWebhook = ref(false)
const notificationForm = ref({
  enabled: false,
  webhookUrl: '',
  minSeverity: 'critical',
  cooldownMinutes: 30,
})
let refreshTimer = null

const currentUser = computed(() => getStoredUser() || {})
const isAdmin = computed(() => ['owner', 'super_admin'].includes(currentUser.value.role))
const summary = computed(() => snapshot.value?.summary || {})
const taskRows = computed(() => snapshot.value?.tasks || [])
const unhealthyTaskCount = computed(() => taskRows.value.filter(isTaskUnhealthy).length)
const visibleTaskRows = computed(() => showHealthyTasks.value ? taskRows.value : taskRows.value.filter(isTaskUnhealthy))
const recentLogs = computed(() => snapshot.value?.recentLogs || [])
const notificationStatusText = computed(() => {
  if (notificationLoading.value) return '加载中'
  if (!notificationSettings.value) return '未加载'
  if (!notificationSettings.value.enabled) return '未启用'
  return notificationSettings.value.hasWebhookUrl ? `已启用 · 冷却 ${notificationSettings.value.cooldownMinutes || 30} 分钟` : '已启用，待配置 Webhook'
})
const filteredAlerts = computed(() => {
  const alerts = snapshot.value?.alerts || []
  if (!alertFilter.value) return alerts
  if (alertFilter.value === 'acknowledged') return alerts.filter((item) => item.state !== 'open')
  return alerts.filter((item) => item.severity === alertFilter.value && item.state === 'open')
})

async function loadSnapshot() {
  loading.value = true
  try {
    snapshot.value = await getObservability()
  } catch (err) {
    ElMessage.error('加载观测数据失败: ' + err.message)
  } finally {
    loading.value = false
  }
}

function applyNotificationSettings(settings) {
  notificationSettings.value = settings
  notificationClearWebhook.value = false
  notificationForm.value = {
    enabled: settings?.enabled === true,
    webhookUrl: '',
    minSeverity: settings?.minSeverity || 'critical',
    cooldownMinutes: settings?.cooldownMinutes || 30,
  }
}

async function loadNotificationSettings() {
  if (!isAdmin.value) return
  notificationLoading.value = true
  try {
    applyNotificationSettings(await getAlertNotificationSettings())
  } catch (err) {
    ElMessage.error('加载告警通知配置失败: ' + err.message)
  } finally {
    notificationLoading.value = false
  }
}

async function openNotificationDialog() {
  notificationDialogVisible.value = true
  await loadNotificationSettings()
}

async function saveNotificationSettings() {
  notificationSaving.value = true
  try {
    const payload = { ...notificationForm.value }
    if (notificationClearWebhook.value) payload.webhookUrl = ''
    else if (!payload.webhookUrl) delete payload.webhookUrl
    applyNotificationSettings(await updateAlertNotificationSettings(payload))
    ElMessage.success('告警通知配置已保存')
  } catch (err) {
    ElMessage.error('保存告警通知配置失败: ' + err.message)
  } finally {
    notificationSaving.value = false
  }
}

async function sendTestNotification() {
  try {
    await saveNotificationSettings()
    notificationTesting.value = true
    const result = await testAlertNotification()
    applyNotificationSettings(result.settings)
    ElMessage.success('测试告警已发送')
  } catch (err) {
    if (err.response?.data?.settings) applyNotificationSettings(err.response.data.settings)
    ElMessage.error('测试发送失败: ' + err.message)
  } finally {
    notificationTesting.value = false
  }
}

async function ackAlert(item) {
  try {
    await acknowledgeAlert(item.id)
    ElMessage.success('告警已确认')
    await loadSnapshot()
  } catch (err) {
    ElMessage.error('确认告警失败: ' + err.message)
  }
}

async function muteAlertFor(item) {
  try {
    await muteAlert(item.id, 60)
    ElMessage.success('告警已静默 1 小时')
    await loadSnapshot()
  } catch (err) {
    ElMessage.error('静默告警失败: ' + err.message)
  }
}

async function restoreAlertState(item) {
  try {
    await restoreAlert(item.id)
    ElMessage.success('告警已恢复')
    await loadSnapshot()
  } catch (err) {
    ElMessage.error('恢复告警失败: ' + err.message)
  }
}

function formatDateTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatDuration(ms) {
  const n = Number(ms || 0)
  if (!n) return '-'
  if (n < 1000) return `${n}ms`
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`
  return `${Math.round(n / 60000)}min`
}

function severityLabel(severity) {
  return ({ critical: '严重', warning: '警告', info: '提示' }[severity] || severity)
}

function alertTypeLabel(type) {
  return ({
    connection: '连接',
    sync_failure: '失败批次',
    recent_failed: '最近失败',
    low_success_rate: '成功率',
    scheduler_missing: '调度',
    never_ran: '未运行',
    stale_task: '同步停滞',
    long_running: '运行时间',
    schema_snapshot: '字段快照',
    connection_test: '连接测试',
  }[type] || type || '-')
}

function alertStateLabel(state) {
  return ({ open: '待处理', acknowledged: '已确认', muted: '已静默' }[state] || '待处理')
}

function alertStateDetail(item) {
  if (item.state === 'muted') return `静默到 ${formatDateTime(item.mutedUntil)}`
  if (item.state === 'acknowledged') return `确认于 ${formatDateTime(item.acknowledgedAt)}`
  return ''
}

function alertSuggestedAction(item) {
  return item.metadata?.suggestedAction || ''
}

function defaultActionTarget(item) {
  if (item.metadata?.actionTarget) return item.metadata.actionTarget
  if (['connection', 'connection_test'].includes(item.type)) return 'connections'
  if (item.type === 'sync_failure') return 'task_failures'
  if (item.type === 'scheduler_missing') return 'task_settings'
  if (item.type === 'schema_snapshot') return 'task_mapping'
  if (item.type === 'recent_failed') return 'task_detail'
  return item.taskId ? 'task_detail' : 'observability'
}

function actionLabel(target) {
  const map = {
    connections: '去数据源',
    task_mapping: '检查映射',
    task_preflight: '运行预检',
    task_failures: '失败批次',
    task_detail: '任务详情',
    task_settings: '编辑设置',
    observability: '查看告警',
  }
  return map[target || 'task_detail'] || '去处理'
}

function resolveAlert(item) {
  emit('resolve-action', {
    taskId: item.taskId,
    connectionId: item.metadata?.connectionId || null,
    alertId: item.id,
    actionTarget: defaultActionTarget(item),
  })
}

function resolveTaskRow(row) {
  emit('resolve-action', {
    taskId: row.id,
    actionTarget: row.health?.latestActionTarget || (row.pendingFailures ? 'task_failures' : 'task_detail'),
  })
}

function isTaskUnhealthy(row) {
  const status = row?.health?.status
  return !row?.connectionOk || row?.pendingFailures > 0 || ['has_failures', 'recent_failed', 'cancelled', 'never_run', 'unknown'].includes(status) || Boolean(row?.health?.latestError)
}

function healthLabel(status) {
  return ({
    healthy: '健康',
    has_failures: '有失败',
    recent_failed: '最近失败',
    cancelled: '已取消',
    never_run: '未运行',
    running: '运行中',
    deleted: '已删除',
    unknown: '未知',
  }[status] || status || '-')
}

function latestStatusLabel(status) {
  return ({ success: '成功', failed: '失败', cancelled: '取消', running: '运行中', never_run: '未运行' }[status] || status || '-')
}

function levelLabel(level) {
  return ({ info: '信息', warn: '警告', error: '错误' }[level] || level || '-')
}

function healthTagType(status) {
  if (status === 'healthy') return 'success'
  if (['has_failures', 'recent_failed'].includes(status)) return 'danger'
  if (['running'].includes(status)) return 'warning'
  return 'info'
}

function scheduleLabel(row) {
  if (!['scheduled', 'realtime', 'incremental'].includes(row.syncMode || 'manual')) return '手动'
  return row.schedulerActive ? `已启动 · ${row.intervalSec}s` : '未启动'
}

function onSyncLog() {
  loadSnapshot()
}

onMounted(() => {
  loadSnapshot()
  loadNotificationSettings()
  refreshTimer = window.setInterval(loadSnapshot, 30000)
  window.addEventListener('sync-log', onSyncLog)
})

onUnmounted(() => {
  if (refreshTimer) window.clearInterval(refreshTimer)
  window.removeEventListener('sync-log', onSyncLog)
})
</script>

<style scoped>
.observability-page {
  display: grid;
  gap: 16px;
}

.obs-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.obs-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.obs-generated {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-tertiary);
  font-size: 13px;
}
.obs-generated strong { color: var(--text-secondary); font-weight: 600; }

.obs-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.obs-tile {
  display: grid;
  gap: 8px;
  min-width: 0;
  text-align: left;
  padding: 14px 16px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  font-family: var(--font-sans);
}
button.obs-tile { cursor: pointer; }
button.obs-tile:hover,
.obs-tile.active {
  border-color: var(--accent);
  background: var(--accent-muted);
}
.obs-tile span {
  color: var(--text-tertiary);
  font-size: 12px;
}
.obs-tile strong {
  color: var(--text-primary);
  font-size: 24px;
  line-height: 1;
}
.obs-tile.critical strong { color: var(--red); }
.obs-tile.warning strong { color: var(--amber); }

.notification-strip {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}
.notification-strip div {
  display: grid;
  gap: 3px;
}
.notification-strip strong {
  color: var(--text-primary);
  font-size: 13px;
}
.notification-strip span {
  color: var(--text-tertiary);
  font-size: 12px;
}

.obs-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(320px, 0.8fr);
  gap: 16px;
  align-items: start;
}

.obs-section {
  padding: 16px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}

.section-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 14px;
}
.section-head div {
  display: grid;
  gap: 4px;
}
.section-head strong {
  color: var(--text-primary);
  font-size: 15px;
}
.section-head span,
.section-head em {
  color: var(--text-tertiary);
  font-size: 12px;
  font-style: normal;
}

.section-toggle {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--accent);
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.section-toggle:hover { background: var(--accent-muted); border-color: var(--accent); }

.alert-list {
  display: grid;
  gap: 10px;
  max-height: 420px;
  overflow: auto;
}

.alert-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 150px;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}
.alert-row.critical { border-left-color: var(--red); }
.alert-row.warning { border-left-color: var(--amber); }
.alert-row.acknowledged,
.alert-row.muted { opacity: 0.68; }
.alert-row.muted { border-left-style: dashed; }

.alert-main {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.alert-main strong {
  color: var(--text-primary);
  font-size: 13px;
}
.alert-main p {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.alert-state-note {
  color: var(--text-tertiary);
  font-size: 11px;
}
.alert-suggestion {
  color: var(--amber);
  font-size: 11px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.alert-severity {
  justify-self: start;
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  background: rgba(148,149,160,0.14);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 700;
}
.critical .alert-severity { background: rgba(220,38,38,0.12); color: var(--red); }
.warning .alert-severity { background: rgba(245,158,11,0.14); color: var(--amber); }

.alert-meta {
  display: grid;
  align-content: start;
  gap: 4px;
  min-width: 0;
  text-align: right;
}
.alert-meta span {
  color: var(--text-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.alert-meta small {
  color: var(--text-tertiary);
  font-size: 11px;
}
.alert-state {
  justify-self: end;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--bg-muted);
  color: var(--text-tertiary);
  font-size: 11px;
  font-style: normal;
}
.alert-state.open { color: var(--red); background: rgba(220,38,38,0.08); }
.alert-state.acknowledged { color: var(--accent); background: var(--accent-muted); }
.alert-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}
.alert-actions button {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  border-radius: 6px;
  padding: 4px 7px;
  font-size: 11px;
  cursor: pointer;
}
.alert-actions button:hover { border-color: var(--accent); color: var(--accent); }
.alert-actions .primary-action {
  border-color: rgba(99,102,241,0.35);
  color: var(--accent);
  font-weight: 700;
}

.obs-error-cell {
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.obs-suggestion-line {
  margin-top: 4px;
  color: var(--amber);
}

.table-action-btn {
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.table-action-btn:hover {
  border-color: var(--accent);
  background: var(--accent-muted);
}

.run-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.run-metrics.compact {
  grid-template-columns: 1fr;
}
.run-metrics div {
  display: grid;
  gap: 5px;
  padding: 11px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}
.run-metrics span {
  color: var(--text-tertiary);
  font-size: 11px;
}
.run-metrics strong {
  color: var(--text-primary);
  font-size: 16px;
}

.logs-collapse {
  padding: 0;
  overflow: hidden;
}
.logs-toggle {
  width: 100%;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  font-family: var(--font-sans);
}
.logs-toggle span { font-size: 13px; font-weight: 700; }
.logs-toggle small { color: var(--text-tertiary); font-size: 12px; }
.logs-toggle strong { color: var(--accent); font-size: 12px; }

.obs-log-list {
  max-height: 340px;
  overflow: auto;
  border-top: 1px solid var(--border-subtle);
}

.obs-log-row {
  display: grid;
  grid-template-columns: 170px 58px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 13px;
}
.obs-log-row:last-child { border-bottom: 0; }
.obs-log-row.log-error { background: rgba(220,38,38,0.04); }
.obs-log-row.log-warn { background: rgba(217,119,6,0.04); }

.log-time {
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  font-size: 12px;
}

.log-level {
  justify-self: start;
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 700;
}
.log-level.warn { background: rgba(217,119,6,0.12); color: var(--amber); }
.log-level.error { background: rgba(220,38,38,0.12); color: var(--red); }

.log-msg {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-secondary);
  line-height: 1.5;
}

.notification-form {
  display: grid;
  gap: 2px;
}

.field-hint {
  margin-top: 6px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.notification-options {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

.clear-webhook-option {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -2px 0 10px;
  color: var(--text-secondary);
  font-size: 13px;
}

.notification-status {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-tertiary);
  font-size: 12px;
}

.status-error {
  color: var(--red);
  overflow-wrap: anywhere;
}

@media (max-width: 1180px) {
  .obs-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .obs-grid { grid-template-columns: 1fr; }
}

@media (max-width: 720px) {
  .obs-toolbar,
  .section-head,
  .notification-strip { flex-direction: column; align-items: stretch; }
  .obs-actions { justify-content: stretch; }
  .obs-actions .fs-btn { justify-content: center; }
  .obs-summary,
  .run-metrics,
  .notification-options { grid-template-columns: 1fr; }
  .alert-row,
  .obs-log-row { grid-template-columns: 1fr; }
  .alert-meta { text-align: left; }
}
</style>

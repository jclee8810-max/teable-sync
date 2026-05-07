<template>
  <div class="logs-page">
    <!-- Header -->
    <div class="page-actions">
      <el-segmented v-model="activeView" :options="viewOptions" />
      <div v-if="activeView === 'sync'" class="log-stats">
        <span class="stat-item" v-if="stats.info > 0">
          <span class="stat-dot info"></span>{{ stats.info }} 信息
        </span>
        <span class="stat-item" v-if="stats.warn > 0">
          <span class="stat-dot warn"></span>{{ stats.warn }} 警告
        </span>
        <span class="stat-item" v-if="stats.error > 0">
          <span class="stat-dot error"></span>{{ stats.error }} 错误
        </span>
      </div>
      <div v-else class="audit-tools">
        <el-select v-model="auditResourceType" placeholder="资源" clearable size="small" style="width:120px" @change="loadAuditLogs">
          <el-option label="连接" value="connection" />
          <el-option label="任务" value="task" />
          <el-option label="系统" value="system" />
        </el-select>
        <button class="fs-btn fs-btn-ghost" @click="loadAuditLogs" style="padding:8px 16px;font-size:13px">
          <el-icon><Refresh /></el-icon>刷新
        </button>
      </div>
      <button v-if="activeView === 'sync'" class="fs-btn fs-btn-ghost" @click="clearAll" style="padding:8px 16px;font-size:13px">
        <el-icon><Delete /></el-icon>清空
      </button>
    </div>

    <!-- Terminal-style Log Viewer -->
    <div v-if="activeView === 'sync'" class="terminal" ref="logContainer">
      <div class="terminal-header">
        <div class="terminal-dots">
          <span class="dot red"></span>
          <span class="dot yellow"></span>
          <span class="dot green"></span>
        </div>
        <span class="terminal-title">Teable Sync — 实时日志</span>
        <span class="terminal-count">{{ logs.length }} 条</span>
      </div>
      <div class="terminal-body">
        <div v-for="(log, idx) in logs" :key="idx" class="log-line" :class="'log-' + log.level">
          <span class="log-time">{{ formatTime(log.ts) }}</span>
          <span class="log-level" :class="log.level">{{ ({ info: '信息', warn: '警告', error: '错误' }[log.level] || log.level).toUpperCase() }}</span>
          <span class="log-msg">{{ log.message }}</span>
        </div>
        <div v-if="logs.length === 0" class="log-empty">
          等待日志…
        </div>
      </div>
    </div>

    <div v-else class="audit-card">
      <el-table :data="auditLogs" size="small" border v-loading="auditLoading" empty-text="暂无审计记录">
        <el-table-column label="时间" width="150">
          <template #default="{ row }">{{ formatDateTime(row.ts) }}</template>
        </el-table-column>
        <el-table-column prop="userEmail" label="用户" min-width="180" show-overflow-tooltip />
        <el-table-column label="动作" width="130">
          <template #default="{ row }">
            <el-tag size="small" :type="actionTagType(row.action)">{{ actionLabel(row.action) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="资源" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">
            <span>{{ resourceLabel(row.resourceType) }}</span>
            <span v-if="row.resourceName"> · {{ row.resourceName }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="message" label="说明" min-width="240" show-overflow-tooltip />
      </el-table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { getLogs, clearLogs, getAuditLogs } from '../api'
import { ElMessage } from 'element-plus'

const logs = ref([])
const logContainer = ref(null)
const activeView = ref('sync')
const auditLogs = ref([])
const auditLoading = ref(false)
const auditResourceType = ref('')
const viewOptions = [
  { label: '实时日志', value: 'sync' },
  { label: '操作审计', value: 'audit' },
]

const stats = computed(() => {
  const s = { info: 0, warn: 0, error: 0 }
  for (const l of logs.value) {
    if (s[l.level] !== undefined) s[l.level]++
  }
  return s
})

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

function formatDateTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function scrollToBottom() {
  nextTick(() => {
    const body = logContainer.value?.querySelector('.terminal-body')
    if (body) body.scrollTop = body.scrollHeight
  })
}

function addLog(entry) {
  logs.value.push(entry)
  if (logs.value.length > 500) logs.value = logs.value.slice(-500)
  scrollToBottom()
}

async function loadLogs() {
  try { logs.value = await getLogs() } catch { /* ignore */ }
  scrollToBottom()
}

async function loadAuditLogs() {
  auditLoading.value = true
  try {
    auditLogs.value = await getAuditLogs({
      limit: 300,
      ...(auditResourceType.value ? { resourceType: auditResourceType.value } : {}),
    })
  } catch {
    auditLogs.value = []
  } finally {
    auditLoading.value = false
  }
}

async function clearAll() {
  logs.value = []
  await clearLogs()
  ElMessage.success('日志已清空')
}

function onSyncLog(event) {
  addLog(event.detail)
}

function resourceLabel(type) {
  return ({ connection: '连接', task: '任务', system: '系统' }[type] || type || '-')
}

function actionLabel(action) {
  return ({
    'connection.create': '创建连接',
    'connection.update': '更新连接',
    'connection.delete': '删除连接',
    'connection.restore': '恢复连接',
    'connection.share': '共享连接',
    'task.create': '创建任务',
    'task.update': '更新任务',
    'task.delete': '删除任务',
    'task.restore': '恢复任务',
    'task.start': '启动任务',
    'task.resume': '恢复任务',
    'task.stop': '停止任务',
    'task.cancel': '取消任务',
    'task.run': '手动运行',
    'task.reconcile': '一致性校验',
    'task.failures.clear': '清除失败',
    'task.failures.retry': '重试失败',
    'system.doctor': '系统检查',
  }[action] || action)
}

function actionTagType(action) {
  if (action?.includes('delete') || action?.includes('cancel') || action?.includes('clear')) return 'danger'
  if (action?.includes('start') || action?.includes('resume') || action?.includes('run') || action?.includes('retry')) return 'success'
  if (action?.includes('update') || action?.includes('reconcile') || action?.includes('doctor')) return 'warning'
  return 'info'
}

onMounted(() => {
  loadLogs()
  loadAuditLogs()
  window.addEventListener('sync-log', onSyncLog)
})

onUnmounted(() => {
  window.removeEventListener('sync-log', onSyncLog)
})
</script>

<style scoped>
.logs-page {}

.page-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  gap: 12px;
}

.log-stats {
  display: flex;
  gap: 16px;
  flex: 1;
}

.audit-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  justify-content: flex-end;
}

.audit-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: 16px;
  box-shadow: var(--shadow-sm);
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

.stat-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
}
.stat-dot.info { background: #60a5fa; }
.stat-dot.warn { background: #fbbf24; }
.stat-dot.error { background: #f87171; }

/* Terminal */
.terminal {
  background: #1e1e2e;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-default);
  overflow: hidden;
  box-shadow: var(--shadow-md);
}

.terminal-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(255,255,255,0.03);
  border-bottom: 1px solid var(--border-subtle);
}

.terminal-dots {
  display: flex;
  gap: 6px;
}
.dot {
  width: 10px; height: 10px;
  border-radius: 50%;
}
.dot.red { background: #ff5f57; }
.dot.yellow { background: #febc2e; }
.dot.green { background: #28c840; }

.terminal-title {
  flex: 1;
  font-size: 12px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

.terminal-count {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
  opacity: 0.5;
}

.terminal-body {
  height: calc(100vh - 300px);
  min-height: 400px;
  overflow-y: auto;
  padding: 16px 20px;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.7;
}

.log-line {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 3px 0;
}

.log-time {
  color: #6c6f85;
  flex-shrink: 0;
  font-size: 12px;
  min-width: 72px;
}

.log-level {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  min-width: 48px;
  text-align: center;
}

.log-level.info { background: rgba(96,165,250,0.12); color: #60a5fa; }
.log-level.warn { background: rgba(251,191,36,0.12); color: #fbbf24; }
.log-level.error { background: rgba(248,113,113,0.12); color: #f87171; }

.log-msg {
  color: #cdd6f4;
  word-break: break-all;
}

.log-error .log-msg { color: #fca5a5; }
.log-warn .log-msg { color: #fde68a; }

.log-empty {
  color: var(--text-tertiary);
  font-style: italic;
  text-align: center;
  padding: 60px 0;
  opacity: 0.5;
}
</style>

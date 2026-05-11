<template>
  <div class="logs-page">
    <div class="log-toolbar">
      <div class="log-stats">
        <button class="stat-item" :class="{ active: levelFilter === '' }" type="button" @click="levelFilter = ''">
          全部 {{ logs.length }}
        </button>
        <button class="stat-item info" :class="{ active: levelFilter === 'info' }" type="button" @click="levelFilter = 'info'">
          信息 {{ stats.info }}
        </button>
        <button class="stat-item warn" :class="{ active: levelFilter === 'warn' }" type="button" @click="levelFilter = 'warn'">
          警告 {{ stats.warn }}
        </button>
        <button class="stat-item error" :class="{ active: levelFilter === 'error' }" type="button" @click="levelFilter = 'error'">
          错误 {{ stats.error }}
        </button>
      </div>
      <button class="fs-btn fs-btn-ghost" @click="clearAll" style="padding:8px 16px;font-size:13px">
        <el-icon><Delete /></el-icon>清空可见日志
      </button>
    </div>

    <div class="log-card" ref="logContainer">
      <div class="log-card-head">
        <div>
          <strong>同步执行流</strong>
          <span>来自任务运行和 WebSocket 推送</span>
        </div>
        <em>{{ filteredLogs.length }} 条</em>
      </div>
      <div class="sync-log-list">
        <div v-for="(log, idx) in filteredLogs" :key="idx" class="log-row" :class="'log-' + log.level">
          <span class="log-time">{{ formatTime(log.ts) }}</span>
          <span class="log-level" :class="log.level">{{ levelLabel(log.level) }}</span>
          <span class="log-task" :title="log.taskId">{{ logTaskLabel(log.taskId) }}</span>
          <span class="log-msg">{{ log.message }}</span>
        </div>
        <el-empty v-if="filteredLogs.length === 0" description="暂无匹配日志" :image-size="72" />
      </div>
    </div>

    <div class="audit-collapse">
      <button class="audit-toggle" type="button" @click="auditOpen = !auditOpen">
        <span>操作审计</span>
        <small>用户、资源和管理动作记录，仅排查权限或误操作时查看。</small>
        <strong>{{ auditOpen ? '收起' : '展开' }}</strong>
      </button>
      <div v-if="auditOpen" class="audit-panel">
        <div class="audit-tools">
          <el-select v-model="auditResourceType" placeholder="资源类型" clearable size="small" style="width:128px" @change="loadAuditLogs">
            <el-option label="连接" value="connection" />
            <el-option label="任务" value="task" />
            <el-option label="系统" value="system" />
            <el-option label="用户" value="user" />
          </el-select>
          <button class="fs-btn fs-btn-ghost" @click="loadAuditLogs" style="padding:8px 16px;font-size:13px">
            <el-icon><Refresh /></el-icon>刷新
          </button>
          <span class="audit-count">{{ auditLogs.length }} 条</span>
        </div>
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { getLogs, clearLogs, getAuditLogs, getTasks } from '../api'
import { ElMessage } from 'element-plus'

const logs = ref([])
const logContainer = ref(null)
const levelFilter = ref('')
const auditLogs = ref([])
const auditOpen = ref(false)
const auditLoading = ref(false)
const auditResourceType = ref('')
const taskMap = ref({})

const stats = computed(() => {
  const s = { info: 0, warn: 0, error: 0 }
  for (const l of logs.value) {
    if (s[l.level] !== undefined) s[l.level]++
  }
  return s
})

const filteredLogs = computed(() => {
  if (!levelFilter.value) return logs.value
  return logs.value.filter(log => log.level === levelFilter.value)
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
    const body = logContainer.value?.querySelector('.sync-log-list')
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

async function loadTaskMap() {
  try {
    const tasks = await getTasks()
    taskMap.value = Object.fromEntries(tasks.map(task => [task.id, task.name || task.id]))
  } catch {
    taskMap.value = {}
  }
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
  ElMessage.success('可见日志已清空')
}

function onSyncLog(event) {
  addLog(event.detail)
}

function resourceLabel(type) {
  return ({ connection: '连接', task: '任务', system: '系统', user: '用户' }[type] || type || '-')
}

function levelLabel(level) {
  return ({ info: '信息', warn: '警告', error: '错误' }[level] || level || '-')
}

function shortTaskId(taskId) {
  return taskId ? `任务 ${String(taskId).slice(0, 8)}` : '系统'
}

function logTaskLabel(taskId) {
  if (!taskId) return '系统'
  const name = taskMap.value[taskId]
  if (!name) return shortTaskId(taskId)
  return name.length > 18 ? name.slice(0, 18) + '...' : name
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
    'user.delete': '删除用户',
    'user.role.update': '修改角色',
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
  loadTaskMap()
  loadLogs()
  loadAuditLogs()
  window.addEventListener('sync-log', onSyncLog)
})

onUnmounted(() => {
  window.removeEventListener('sync-log', onSyncLog)
})
</script>

<style scoped>
.logs-page {
  display: grid;
  gap: 16px;
}

.log-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.log-stats,
.audit-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  flex-wrap: wrap;
}

.audit-collapse {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  overflow: hidden;
}

.audit-toggle {
  width: 100%;
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 12px 14px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  font-family: var(--font-sans);
}
.audit-toggle span { font-size: 13px; font-weight: 700; }
.audit-toggle small { color: var(--text-tertiary); font-size: 12px; }
.audit-toggle strong { color: var(--accent); font-size: 12px; }
.audit-panel {
  display: grid;
  gap: 12px;
  padding: 0 14px 14px;
  border-top: 1px solid var(--border-subtle);
}
.audit-count { color: var(--text-tertiary); font-size: 12px; }

.stat-item {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: var(--font-sans);
}
.stat-item:hover,
.stat-item.active { border-color: var(--accent); color: var(--accent); }
.stat-item.info.active { color: #2563eb; border-color: rgba(37,99,235,0.35); }
.stat-item.warn.active { color: var(--amber); border-color: rgba(217,119,6,0.35); }
.stat-item.error.active { color: var(--red); border-color: rgba(220,38,38,0.35); }

.log-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.log-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-subtle);
}
.log-card-head div {
  display: grid;
  gap: 3px;
}
.log-card-head strong {
  font-size: 14px;
  color: var(--text-primary);
}
.log-card-head span,
.log-card-head em {
  font-size: 12px;
  color: var(--text-tertiary);
  font-style: normal;
}

.sync-log-list {
  height: calc(100vh - 340px);
  min-height: 360px;
  overflow-y: auto;
}

.log-row {
  display: grid;
  grid-template-columns: 86px 58px 100px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  padding: 9px 16px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 13px;
}
.log-row:last-child { border-bottom: 0; }
.log-row.log-error { background: rgba(220,38,38,0.04); }
.log-row.log-warn { background: rgba(217,119,6,0.04); }

.log-time,
.log-task {
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
.log-level.info { background: rgba(37,99,235,0.10); color: #2563eb; }
.log-level.warn { background: rgba(217,119,6,0.12); color: var(--amber); }
.log-level.error { background: rgba(220,38,38,0.12); color: var(--red); }

.log-msg {
  color: var(--text-secondary);
  word-break: break-word;
  line-height: 1.5;
}

@media (max-width: 760px) {
  .log-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .log-row {
    grid-template-columns: 76px 54px minmax(0, 1fr);
  }
  .log-task { display: none; }
}
</style>

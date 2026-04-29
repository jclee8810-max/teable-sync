<template>
  <div class="tasks-page">
    <!-- Header -->
    <div class="page-actions">
      <button class="fs-btn fs-btn-primary" @click="openDialog()">
        <el-icon><Plus /></el-icon>新建任务
      </button>
    </div>

    <!-- Task List -->
    <div class="task-list" v-if="tasks.length > 0">
      <div v-for="task in tasks" :key="task.id" class="fs-card task-card">
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
            <span class="status-badge" :class="statusClass(task.status)">{{ statusLabel(task.status) }}</span>
            <button class="fs-btn fs-btn-primary" @click="manualRun(task)" :disabled="task._running || task.status === 'running'" style="padding:8px 16px;font-size:13px">
              <el-icon v-if="!task._running && task.status !== 'running'"><VideoPlay /></el-icon>
              <el-icon v-else class="is-loading"><Loading /></el-icon>
              {{ (task._running || task.status === 'running') ? '同步中...' : '同步' }}
            </button>
            <!-- 仅定时/实时模式显示启停按钮 -->
            <button v-if="task.syncMode && (task.syncMode === 'scheduled' || task.syncMode === 'realtime')" class="fs-btn" :class="schedulerStatus[task.id] ? 'fs-btn-danger' : 'fs-btn-success'" @click="toggleSync(task)" style="padding:8px 16px;font-size:13px">
              {{ schedulerStatus[task.id] ? '停止' : '启动' }}
            </button>
            <button class="icon-btn" @click="openDialog(task)" title="编辑">
              <el-icon :size="16"><Edit /></el-icon>
            </button>
            <button class="icon-btn icon-btn-danger" @click="removeTask(task.id)" title="删除">
              <el-icon :size="16"><Delete /></el-icon>
            </button>
          </div>
        </div>

        <div class="task-card-detail">
          <div class="detail-grid">
            <div class="detail-item">
              <span class="detail-label">源表</span>
              <span class="detail-value mono">{{ task.sourceTable }}</span>
            </div>
            <div class="detail-item">
              <span class="detail-label">同步模式</span>
              <span class="detail-value">
                <span class="sync-mode-badge" :class="task.syncMode || 'manual'">{{ syncModeLabel(task.syncMode || 'manual') }}</span>
                <span v-if="task.syncMode && task.syncMode !== 'manual'" class="interval-text">· {{ intervalLabel(task.syncInterval || 300) }}</span>
              </span>
            </div>
            <div class="detail-item">
              <span class="detail-label">冲突策略</span>
              <span class="detail-value">
                <span class="strategy-badge" :class="task.conflictStrategy">{{ conflictLabel(task.conflictStrategy) }}</span>
              </span>
            </div>
            <div class="detail-item">
              <span class="detail-label">上次同步</span>
              <span class="detail-value" v-if="task.lastSyncAt">{{ formatTime(task.lastSyncAt) }}</span>
              <span class="detail-value empty" v-else>从未执行</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <el-empty v-if="tasks.length === 0" description="暂无同步任务" />

    <!-- Task Dialog -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑任务' : '新建同步任务'" width="720px" destroy-on-close>
      <el-form :model="form" label-position="top">

        <el-form-item label="任务名称">
          <el-input v-model="form.name" placeholder="例如：用户表同步" />
        </el-form-item>

        <!-- Source -->
        <div class="section-divider">
          <span class="section-icon">⬡</span> 数据源（SQL 数据库）
        </div>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="源数据库">
              <el-select v-model="form.sourceConnectionId" @change="onSourceChange" placeholder="选择连接" style="width:100%">
                <el-option v-for="c in sqlConnections" :key="c.id" :label="c.name" :value="c.id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="源表">
              <el-select v-model="form.sourceTable" @change="onSourceTableChange" placeholder="选择表" style="width:100%"
                :loading="sourceLoading" :disabled="!form.sourceConnectionId" filterable>
                <el-option v-for="t in sourceTables" :key="t.name" :label="t.name" :value="t.name" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="源库（可选）">
              <el-input v-model="form.sourceDatabase" placeholder="默认连接数据库" />
            </el-form-item>
          </el-col>
        </el-row>

        <!-- Target -->
        <div class="section-divider">
          <span class="section-icon">▦</span> 目标（Teable）
        </div>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="Teable 连接">
              <el-select v-model="form.targetConnectionId" @change="onTeableConnChange" placeholder="选择Teable" style="width:100%">
                <el-option v-for="c in teableConnections" :key="c.id" :label="c.name" :value="c.id" />
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
        </div>
        <div v-if="sourceColumns.length > 0 && targetFields.length > 0" class="mapping-area">
          <el-alert type="info" :closable="false" style="margin-bottom:12px">
            自动匹配同名字段，可手动调整。未匹配的源字段将被忽略。
          </el-alert>
          <el-table :data="mappingRows" size="small" border>
            <el-table-column label="源字段 (SQL)" min-width="160">
              <template #default="{ row }">
                <el-select v-model="row.source" placeholder="选择源字段" style="width:100%" filterable>
                  <el-option v-for="c in sourceColumns" :key="c.name" :label="`${c.name} (${c.type})`" :value="c.name" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column width="50" align="center">
              <template #default><span class="flow-arrow-inline">→</span></template>
            </el-table-column>
            <el-table-column label="目标字段 (Teable)" min-width="160">
              <template #default="{ row }">
                <el-select v-model="row.target" placeholder="选择目标字段" style="width:100%" filterable>
                  <el-option v-for="f in targetFields" :key="f.name" :label="`${f.name} (${f.type})`" :value="f.name" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column width="60" align="center">
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
            <button type="button" class="fs-btn fs-btn-ghost" @click="autoMap" style="padding:6px 14px;font-size:12px;border-color:var(--green);color:var(--green)">
              <el-icon><MagicStick /></el-icon>自动匹配
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
                <el-option label="实时同步" value="realtime" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="冲突策略">
              <el-select v-model="form.conflictStrategy" style="width:100%">
                <el-option label="覆盖（以数据库为准）" value="upsert" />
                <el-option label="跳过（保留 Teable 数据）" value="skip" />
                <el-option label="仅新增（不更新已有记录）" value="insert_only" />
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
          <el-col :span="4" v-if="form.syncMode === 'manual'">
            <el-form-item label="主键列">
              <el-input v-model="form.sourcePrimaryKey" placeholder="自动检测" />
            </el-form-item>
          </el-col>
          <el-col :span="4" v-if="form.syncMode === 'manual'">
            <el-form-item label="时间戳列">
              <el-select v-model="form.sourceTimestampColumn" placeholder="自动检测" clearable style="width:100%" :disabled="datetimeColumns.length === 0">
                <el-option v-if="datetimeColumns.length > 0" label="— 自动检测 —" value="" />
                <el-option v-for="col in datetimeColumns" :key="col" :label="col" :value="col" />
                <el-option v-if="datetimeColumns.length === 0" label="无 datetime 列" value="" disabled />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12" v-if="form.syncMode !== 'manual'">
          <el-col :span="6">
            <el-form-item label="主键列">
              <el-input v-model="form.sourcePrimaryKey" placeholder="自动检测" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="时间戳列">
              <el-select v-model="form.sourceTimestampColumn" placeholder="自动检测" clearable style="width:100%" :disabled="datetimeColumns.length === 0">
                <el-option v-if="datetimeColumns.length > 0" label="— 自动检测 —" value="" />
                <el-option v-for="col in datetimeColumns" :key="col" :label="col" :value="col" />
                <el-option v-if="datetimeColumns.length === 0" label="无 datetime 列" value="" disabled />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <button class="fs-btn fs-btn-ghost" @click="dialogVisible = false">取消</button>
        <button class="fs-btn fs-btn-primary" @click="saveTask" :disabled="saving">
          保存
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getConnections, getTables, getTeableBases, getTeableTables, getTeableFields } from '../api'
import { getTasks, createTask, updateTask, deleteTask, runTask, startTask, stopTask, getSchedulerStatus } from '../api'

const connections = ref([])
const tasks = ref([])
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

const schedulerStatus = ref({})

const defaultForm = {
  name: '', sourceConnectionId: '', sourceTable: '', sourceDatabase: '',
  targetConnectionId: '', targetTableId: '', _baseId: '',
  columnMapping: {}, conflictStrategy: 'upsert',
  sourcePrimaryKey: '', sourceTimestampColumn: '',
  syncMode: 'manual', syncInterval: 300,
}
const form = ref({ ...defaultForm })

const sqlConnections = computed(() => connections.value.filter(c => c.type !== 'teable'))
const teableConnections = computed(() => connections.value.filter(c => c.type === 'teable'))
const datetimeColumns = computed(() =>
  sourceColumns.value
    .filter(c => /datetime|timestamp|date/i.test(c.type))
    .map(c => c.name)
)

function connName(id) { return connections.value.find(c => c.id === id)?.name || id }
function conflictLabel(s) {
  const m = { upsert: '覆盖', skip: '跳过', insert_only: '仅新增' }
  return m[s] || s
}
function syncModeLabel(m) {
  const map = {
    manual: '手动执行',
    scheduled: '定时同步',
    realtime: '实时同步',
    incremental: '定时同步',  // legacy: 保持定时行为
    full: '手动执行',          // legacy: 保持手动行为
  }
  return map[m] || m
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

function addMapping() { mappingRows.value.push({ source: '', target: '' }) }
function removeMapping(i) { mappingRows.value.splice(i, 1) }

function autoMap() {
  mappingRows.value = []
  for (const col of sourceColumns.value) {
    const matchField = targetFields.value.find(f => f.name === col.name)
    if (matchField) {
      mappingRows.value.push({ source: col.name, target: matchField.name })
    }
  }
  if (mappingRows.value.length === 0) {
    ElMessage.info('没有同名字段可自动匹配')
  } else {
    ElMessage.success(`已自动匹配 ${mappingRows.value.length} 个字段`)
  }
}

async function loadAll() {
  connections.value = await getConnections()
  tasks.value = await getTasks()
  try { schedulerStatus.value = await getSchedulerStatus() } catch {}
}

watch(() => form.value.sourceDatabase, () => {
  if (form.value.sourceConnectionId) onSourceChange()
})

async function onSourceChange() {
  sourceTables.value = []
  sourceColumns.value = []
  form.value.sourceTable = ''
  if (!form.value.sourceConnectionId) return
  sourceLoading.value = true
  try {
    const db = form.value.sourceDatabase || undefined
    sourceTables.value = await getTables(form.value.sourceConnectionId, db)
  } catch (err) {
    ElMessage.error('获取表列表失败: ' + err.message)
  } finally {
    sourceLoading.value = false
  }
}

async function onSourceTableChange() {
  if (!form.value.sourceConnectionId || !form.value.sourceTable) return
  try {
    const tables = await getTables(form.value.sourceConnectionId)
    const found = tables.find(t => t.name === form.value.sourceTable)
    if (found) sourceColumns.value = found.columns || []
    if (targetFields.value.length > 0) autoMap()
  } catch (e) { /* ignore */ }
}

async function onTeableConnChange() {
  teableBases.value = []
  teableTables.value = []
  targetFields.value = []
  form.value._baseId = ''
  form.value.targetTableId = ''
  if (!form.value.targetConnectionId) return
  basesLoading.value = true
  try {
    teableBases.value = await getTeableBases(form.value.targetConnectionId)
  } catch (err) {
    ElMessage.error('获取 Base 列表失败: ' + err.message)
  } finally {
    basesLoading.value = false
  }
}

async function onBaseChange() {
  teableTables.value = []
  targetFields.value = []
  form.value.targetTableId = ''
  if (!form.value._baseId) return
  tablesLoading.value = true
  try {
    teableTables.value = await getTeableTables(form.value._baseId, form.value.targetConnectionId)
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
    if (sourceColumns.value.length > 0) autoMap()
  } catch (err) {
    ElMessage.error('获取字段失败: ' + err.message)
  }
}

function openDialog(task = null) {
  if (task) {
    editingId.value = task.id
    // 兼容新旧两套字段名
    const srcConnId = task.sourceConnectionId || task.sourceId
    const tgtConnId = task.targetConnectionId || task.targetId
    form.value = {
      ...defaultForm,
      ...task,
      sourceConnectionId: srcConnId,
      targetConnectionId: tgtConnId,
      _baseId: task.targetBaseId || ''
    }
    const mapping = task.columnMapping || task.fieldMapping
    if (Array.isArray(mapping)) {
      mappingRows.value = mapping.map(m => ({ source: m.source, target: m.target }))
    } else {
      mappingRows.value = Object.entries(mapping || {}).map(([s, t]) => ({ source: s, target: t }))
    }
    if (srcConnId) onSourceChange()
    if (tgtConnId) {
      onTeableConnChange().then(() => {
        for (const b of teableBases.value) {
          const found = (b.tables || []).find(t => t.id === task.targetTableId)
          if (found) {
            form.value._baseId = b.id
            onBaseChange()
            break
          }
        }
      })
    }
  } else {
    editingId.value = null
    form.value = { ...defaultForm }
    mappingRows.value = []
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
  if (!form.value.sourceConnectionId || !form.value.sourceTable) { ElMessage.warning('请选择源数据库和源表'); return }
  if (!form.value.targetConnectionId || !form.value.targetTableId) { ElMessage.warning('请选择 Teable 目标表'); return }
  saving.value = true
  try {
    const columnMapping = {}
    for (const row of mappingRows.value) {
      if (row.source && row.target) columnMapping[row.source] = row.target
    }
    const payload = { ...form.value, columnMapping }
    delete payload._baseId

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
    ElMessage.error('保存失败: ' + err.message)
  } finally {
    saving.value = false
  }
}

async function removeTask(id) {
  await ElMessageBox.confirm('确定删除此任务？', '提示', { type: 'warning' })
  await deleteTask(id)
  ElMessage.success('已删除')
  await loadAll()
}

async function manualRun(task) {
  task._running = true
  try {
    await runTask(task.id)
    ElMessage.success('同步已启动')
    setTimeout(loadAll, 3000)
  } catch (err) {
    ElMessage.error('启动失败: ' + err.message)
  } finally {
    task._running = false
  }
}

async function toggleSync(task) {
  if (task.status === 'scheduled' || schedulerStatus.value[task.id]) {
    // Stop auto-sync
    try {
      await stopTask(task.id)
      ElMessage.success('已停止自动同步')
      await loadAll()
    } catch (err) {
      ElMessage.error('停止失败: ' + err.message)
    }
  } else {
    // Start auto-sync
    if (!task.syncMode || task.syncMode === 'manual') {
      ElMessage.warning('请先编辑任务，设置同步模式为「定时」或「实时」')
      return
    }
    try {
      await startTask(task.id)
      ElMessage.success(`已启动${syncModeLabel(task.syncMode)}同步`)
      await loadAll()
    } catch (err) {
      ElMessage.error('启动失败: ' + err.message)
    }
  }
}

onMounted(loadAll)
</script>

<style scoped>
.tasks-page {}

.page-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 24px;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.task-card { padding: 20px 24px; }

.task-card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
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
  align-items: center;
  gap: 8px;
}

.icon-btn-danger:hover { color: var(--red) !important; background: rgba(239,68,68,0.1) !important; }

.task-card-detail {
  padding-top: 16px;
  border-top: 1px solid var(--border-subtle);
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
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
}
.detail-value.mono { font-family: var(--font-mono); }
.detail-value.empty { color: var(--text-tertiary); font-style: italic; }

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

.mapping-area {
  background: var(--bg-elevated);
  padding: 16px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-subtle);
}
</style>

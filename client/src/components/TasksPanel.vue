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
            <button v-if="isTaskRunning(task)" class="fs-btn fs-btn-danger" @click="cancelRunningTask(task)" style="padding:8px 16px;font-size:13px">
              取消
            </button>
            <button class="fs-btn fs-btn-ghost" @click="handlePreview(task.id)" style="padding:8px 16px;font-size:13px">
              <el-icon><View /></el-icon>预览
            </button>
            <!-- 仅定时/实时模式显示启停按钮 -->
            <button v-if="task.syncMode && (task.syncMode === 'scheduled' || task.syncMode === 'realtime')" class="fs-btn" :class="schedulerStatus[task.id] ? 'fs-btn-danger' : 'fs-btn-success'" @click="toggleSync(task)" style="padding:8px 16px;font-size:13px">
              {{ schedulerStatus[task.id] ? '停止' : '启动' }}
            </button>
            <button class="icon-btn" @click="openDialog(task)" :disabled="!isOwner(task)" :title="isOwner(task) ? '编辑' : '无权限编辑'">
              <el-icon :size="16"><Edit /></el-icon>
            </button>
            <button class="icon-btn icon-btn-danger" @click="removeTask(task.id)" :disabled="!isOwner(task)" :title="isOwner(task) ? '删除' : '无权限删除'">
              <el-icon :size="16"><Delete /></el-icon>
            </button>
          </div>
        </div>

        <div class="task-card-detail">
          <div class="detail-grid" style="grid-template-columns: repeat(5, 1fr)">
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
              <span class="detail-label">增量策略</span>
              <span class="detail-value">
                <span class="watermark-badge" :class="task.watermarkType || 'auto'">{{ watermarkLabel(task.watermarkType) }}</span>
              </span>
            </div>
            <div class="detail-item">
              <span class="detail-label">上次同步</span>
              <span class="detail-value" v-if="task.lastSyncAt">{{ formatTime(task.lastSyncAt) }}</span>
              <span class="detail-value empty" v-else>从未执行</span>
            </div>
          </div>
          <div v-if="taskProgress[task.id] && taskProgress[task.id].status !== 'idle'" class="progress-panel">
            <div class="progress-line">
              <span class="progress-phase">{{ progressPhaseLabel(taskProgress[task.id].phase) }}</span>
              <span class="progress-meta">{{ progressSummary(taskProgress[task.id]) }}</span>
            </div>
            <el-progress
              :percentage="progressPercent(taskProgress[task.id])"
              :indeterminate="taskProgress[task.id].status === 'running' || taskProgress[task.id].status === 'cancelling'"
              :status="progressStatus(taskProgress[task.id])"
              :stroke-width="8"
            />
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
          <el-tag v-if="mappingLoading" size="small" type="info" style="margin-left:8px">智能匹配中...</el-tag>
          <el-tag v-if="mappingSuggestions && !mappingLoading" size="small" :type="mappingSuggestions.mappings.length > 0 ? 'success' : 'info'" style="margin-left:8px">
            {{ mappingSuggestions.mappings.length }} 个已匹配{{ mappingSuggestions.unmatchedSource.length > 0 ? ` + ${mappingSuggestions.unmatchedSource.length} 待创建` : '' }}
          </el-tag>
        </div>
        <div v-if="sourceColumns.length > 0 && targetFields.length > 0" class="mapping-area">
          <el-alert type="info" :closable="false" style="margin-bottom:12px">
            智能匹配支持同名、驼峰转换（user_name↔userName）、模糊匹配。类型兼容性自动检测。
          </el-alert>
          <el-table :data="mappingRows" size="small" border row-key="source">
            <el-table-column label="源字段 (SQL)" min-width="180">
              <template #default="{ row }">
                <el-select v-model="row.source" placeholder="选择源字段" style="width:100%" filterable>
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
                <el-select v-model="row.target" placeholder="选择目标字段" style="width:100%" filterable>
                  <el-option v-for="f in targetFields" :key="f.name" :label="`${f.name} (${f.type})`" :value="f.name" />
                  <!-- For auto-create: add the source name as option -->
                  <el-option v-if="!targetFields.find(f => f.name === row.source)" :key="'create-'+row.source" :label="`${row.source} (自动创建)`" :value="row.source" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column width="90" align="center" label="兼容性">
              <template #default="{ row }">
                <span v-if="row._typeSafe === undefined" class="compat-tag compat-unknown">—</span>
                <span v-else-if="row._typeSafe" class="compat-tag compat-safe">✓ 兼容</span>
                <span v-else class="compat-tag compat-warn" :title="row._typeWarning">⚠ {{ row._typeWarning ? row._typeWarning.slice(0, 8) : '不兼容' }}</span>
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
        </el-row>

        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="源分页大小">
              <el-input-number v-model="form.pageSize" :min="100" :max="5000" :step="100" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="写入批量">
              <el-input-number v-model="form.batchSize" :min="50" :max="1000" :step="50" style="width:100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="失败重试次数">
              <el-input-number v-model="form.retryCount" :min="1" :max="8" style="width:100%" />
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
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getConnections, getTables, getWatermarkCandidates, getMappingSuggestions, getTeableBases, getTeableTables, getTeableFields } from '../api'
import { getTasks, createTask, updateTask, deleteTask, runTask, startTask, stopTask, cancelTask, getTaskProgress, getSchedulerStatus, previewTaskData } from '../api'

// 当前用户身份
const currentUser = JSON.parse(localStorage.getItem('user') || 'null')
const currentUserId = currentUser?.id || null
const isSuperAdmin = currentUser?.role === 'super_admin'

function isOwner(task) {
  return task && (task.userId === currentUserId || isSuperAdmin)
}

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
const mappingSuggestions = ref(null) // { mappings, unmatchedSource, unmatchedTarget }
const mappingLoading = ref(false)
const previewDialogVisible = ref(false)
const previewData = ref(null)
const previewLoading = ref(false)
const previewLimit = ref(10)

const schedulerStatus = ref({})
const taskProgress = ref({})
let progressTimer = null

// Watermark candidates (fetched from API when source table changes)
const watermarkCandidates = ref({ pkCol: null, candidates: { timestamp: [], rowversion: [], auto_pk: [] } })
const watermarkLoading = ref(false)

const defaultForm = {
  name: '', sourceConnectionId: '', sourceTable: '', sourceDatabase: '',
  targetConnectionId: '', targetTableId: '', _baseId: '',
  columnMapping: {}, conflictStrategy: 'upsert',
  sourcePrimaryKey: '', watermarkType: '', watermarkColumn: '',
  syncMode: 'manual', syncInterval: 300,
  pageSize: 1000, batchSize: 500, retryCount: 3,
  deletionMode: 'ignore', softDeleteField: 'deleted',
}
const form = ref({ ...defaultForm })

const sqlConnections = computed(() => connections.value.filter(c => c.type !== 'teable'))
const teableConnections = computed(() => connections.value.filter(c => c.type === 'teable'))
const datetimeColumns = computed(() =>
  sourceColumns.value
    .filter(c => /datetime|timestamp|date/i.test(c.type))
    .map(c => c.name)
)

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
function conflictLabel(s) {
  const m = { upsert: '覆盖', skip: '跳过', insert_only: '仅新增' }
  return m[s] || s
}
function watermarkLabel(w) {
  const m = { '': '自动', timestamp: '时间戳', rowversion: 'Rowversion', auto_pk: '自增主键', full_scan: '全量扫描' }
  return m[w] || '自动'
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
function isTaskRunning(task) {
  const p = taskProgress.value[task.id]
  return task.status === 'running' || task._running || p?.status === 'running' || p?.status === 'cancelling'
}
function progressPhaseLabel(phase) {
  const map = {
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
  const total = Number(p.totalEstimate || p.targetRows || 0)
  if (!total) return 35
  return Math.max(5, Math.min(95, Math.round((Number(p.processedRows || 0) / total) * 100)))
}
function progressStatus(p) {
  if (p.status === 'failed') return 'exception'
  if (p.status === 'cancelled') return 'warning'
  if (p.status === 'success' || p.phase === 'completed') return 'success'
  return undefined
}

async function handlePreview(taskId) {
  previewLoading.value = true
  previewDialogVisible.value = true
  previewData.value = null
  try {
    previewData.value = await previewTaskData(taskId, previewLimit.value)
  } catch (err) {
    ElMessage.error('预览失败: ' + err.message)
  } finally {
    previewLoading.value = false
  }
}

function closePreview() {
  previewDialogVisible.value = false
  previewData.value = null
}

function addMapping() { mappingRows.value.push({ source: '', target: '' }) }
function removeMapping(i) { mappingRows.value.splice(i, 1) }

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
      });
    }
    if (mappingRows.value.length === 0) {
      ElMessage.info('没有可匹配的字段');
    } else {
      const safe = mappingRows.value.filter(r => r._typeSafe).length;
      const warn = mappingRows.value.length - safe;
      ElMessage.success(`已智能匹配 ${mappingRows.value.length} 个字段${warn > 0 ? `，${warn} 个存在类型转换风险` : ''}`);
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
  await refreshProgress()
}

async function refreshProgress() {
  const next = { ...taskProgress.value }
  await Promise.all(tasks.value.map(async (task) => {
    try {
      const progress = await getTaskProgress(task.id)
      if (progress.status === 'idle' && !['running', 'cancelling'].includes(next[task.id]?.status)) {
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
    const hasActive = Object.values(taskProgress.value).some(p => ['running', 'cancelling'].includes(p.status))
    if (!hasActive) {
      try {
        tasks.value = await getTasks()
        schedulerStatus.value = await getSchedulerStatus()
      } catch {}
    }
  }, 2000)
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
    if (targetFields.value.length > 0) smartMap()
  } catch (e) { /* ignore */ }
  // Fetch watermark candidates
  watermarkLoading.value = true
  try {
    const db = form.value.sourceDatabase || undefined
    watermarkCandidates.value = await getWatermarkCandidates(form.value.sourceConnectionId, form.value.sourceTable, db)
  } catch (e) {
    watermarkCandidates.value = { pkCol: null, candidates: { timestamp: [], rowversion: [], auto_pk: [] } }
  } finally {
    watermarkLoading.value = false
  }
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
    if (sourceColumns.value.length > 0) smartMap()
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
    // Migrate sourceTimestampColumn → watermarkType/watermarkColumn
    if (task.watermarkType === undefined && task.sourceTimestampColumn) {
      form.value.watermarkType = 'timestamp'
      form.value.watermarkColumn = task.sourceTimestampColumn
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
    // Backward compat: also set sourceTimestampColumn from watermark config
    if (payload.watermarkType === 'timestamp' && payload.watermarkColumn) {
      payload.sourceTimestampColumn = payload.watermarkColumn
    } else {
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
    // 后端立即返回 {started:true} 再异步执行，等待同步完成再显示结果
    ElMessage.info('正在同步，请稍候…')
    taskProgress.value[task.id] = { taskId: task.id, status: 'running', phase: 'starting', processedRows: 0 }
    startProgressPolling()
    setTimeout(loadAll, 2000)
  } catch (err) {
    ElMessage.error('启动失败: ' + err.message)
    setTimeout(loadAll, 1000)
  } finally {
    task._running = false
  }
}

async function cancelRunningTask(task) {
  try {
    await ElMessageBox.confirm('确定取消当前正在执行的同步？已写入的数据会保留，本次不会推进增量水位。', '取消同步', { type: 'warning' })
    await cancelTask(task.id)
    taskProgress.value[task.id] = { ...(taskProgress.value[task.id] || {}), taskId: task.id, status: 'cancelling', phase: 'cancelling' }
    ElMessage.warning('已请求取消同步')
    startProgressPolling()
  } catch (err) {
    if (err !== 'cancel') ElMessage.error('取消失败: ' + (err.message || err))
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
      startProgressPolling()
      await loadAll()
    } catch (err) {
      ElMessage.error('启动失败: ' + err.message)
    }
  }
}

onMounted(async () => {
  await loadAll()
  startProgressPolling()
})

onUnmounted(() => {
  if (progressTimer) window.clearInterval(progressTimer)
  progressTimer = null
})
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
</style>

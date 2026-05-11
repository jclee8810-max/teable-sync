<template>
  <div class="doctor-page">
    <div class="doctor-actions">
      <button class="fs-btn fs-btn-ghost" @click="loadBackups" :disabled="backupsLoading">
        <el-icon v-if="backupsLoading" class="is-loading"><Loading /></el-icon>
        刷新备份
      </button>
      <button class="fs-btn fs-btn-primary" @click="loadDoctor" :disabled="loading">
        <el-icon v-if="loading" class="is-loading"><Loading /></el-icon>
        重新检查
      </button>
    </div>

    <div class="fs-card doctor-summary" v-if="doctor">
      <div class="summary-main">
        <div class="summary-title">系统状态</div>
        <div class="summary-status" :class="doctor.status">{{ statusLabel(doctor.status) }}</div>
      </div>
      <div class="summary-counts">
        <span class="count pass">{{ doctor.summary.pass }} 通过</span>
        <span class="count warn">{{ doctor.summary.warn }} 警告</span>
        <span class="count fail">{{ doctor.summary.fail }} 失败</span>
      </div>
      <div class="summary-time">检查时间：{{ formatTime(doctor.checkedAt) }}</div>
    </div>

    <div class="check-list" v-if="doctor">
      <div v-for="check in doctor.checks" :key="check.id || check.title" class="fs-card check-card">
        <span class="check-status" :class="check.status">{{ statusText(check.status) }}</span>
        <div class="check-body">
          <div class="check-title">{{ check.title }}</div>
          <div class="check-message">{{ check.message }}</div>
        </div>
      </div>
    </div>


    <div class="fs-card acceptance-card">
      <div class="section-header">
        <div>
          <div class="section-title">一键验收</div>
          <div class="section-desc">实测基准数据源、检查任务可运行性、抽样预检、失败批次和告警；不会执行同步写入。</div>
        </div>
        <button class="fs-btn fs-btn-primary" @click="runAcceptance" :disabled="acceptanceLoading">
          <el-icon v-if="acceptanceLoading" class="is-loading"><Loading /></el-icon>
          开始验收
        </button>
      </div>
      <div v-if="acceptance" class="acceptance-summary" :class="acceptance.status">
        <div>
          <strong>{{ statusLabel(acceptance.status) }}</strong>
          <span>{{ acceptance.summary.pass }} 通过 · {{ acceptance.summary.warn }} 警告 · {{ acceptance.summary.fail }} 失败</span>
        </div>
        <small>{{ formatTime(acceptance.finishedAt) }}</small>
      </div>
      <div v-if="acceptance" class="acceptance-steps">
        <div v-for="step in acceptance.steps" :key="step.title" class="acceptance-step">
          <span class="check-status" :class="step.status">{{ statusText(step.status) }}</span>
          <div>
            <div class="check-title">{{ step.title }}</div>
            <div class="check-message">{{ step.message }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="fs-card environment-card">
      <div class="section-header">
        <div>
          <div class="section-title">测试环境整理</div>
          <div class="section-desc">保留基准数据源，软删除临时 e2e 数据源、任务和模板，并压缩临时日志。</div>
        </div>
        <div class="inline-actions">
          <button class="fs-btn fs-btn-ghost" @click="loadEnvironment" :disabled="environmentLoading">
            <el-icon v-if="environmentLoading" class="is-loading"><Loading /></el-icon>
            刷新预览
          </button>
          <button class="fs-btn fs-btn-primary" @click="cleanupEnvironment" :disabled="cleanupLoading || !environment">
            整理环境
          </button>
        </div>
      </div>
      <div v-if="environment" class="environment-grid">
        <div><span>基准数据源</span><strong>{{ environment.summary.readyBaselineConnections }}/{{ environment.summary.baselineConnections }}</strong><small>最近测试通过</small></div>
        <div><span>可清理数据源</span><strong>{{ environment.summary.removableConnections }}</strong><small>临时项</small></div>
        <div><span>可清理任务</span><strong>{{ environment.summary.removableTasks }}</strong><small>临时项</small></div>
        <div><span>可清理日志</span><strong>{{ environment.summary.removableLogs }}</strong><small>临时或超量</small></div>
      </div>
      <div v-if="environment?.warnings?.length" class="preview-list warnings environment-warnings">
        <strong>提醒</strong>
        <span v-for="item in environment.warnings" :key="item">{{ item }}</span>
      </div>
    </div>

    <div class="fs-card backup-card">
      <div class="section-header">
        <div>
          <div class="section-title">配置备份</div>
          <div class="section-desc">系统写入配置前自动生成，用于排查和恢复；这里不导出迁移包。</div>
        </div>
        <span class="backup-count">{{ backups.length }} 个</span>
      </div>
      <el-table :data="backups" size="small" border v-loading="backupsLoading" empty-text="暂无备份">
        <el-table-column label="时间" min-width="180">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column prop="name" label="文件" min-width="260" show-overflow-tooltip />
        <el-table-column label="大小" width="120">
          <template #default="{ row }">{{ formatSize(row.size) }}</template>
        </el-table-column>
      </el-table>
    </div>

    <div class="fs-card migration-card">
      <div class="section-header">
        <div>
          <div class="section-title">环境迁移</div>
          <div class="section-desc">用于测试环境和正式环境之间迁移连接、任务、模板和告警通知配置，仅系统所有者可操作。</div>
        </div>
      </div>
      <div class="migration-actions">
        <button class="fs-btn fs-btn-primary" @click="exportConfig(false)" :disabled="exporting">导出迁移包</button>
        <button class="fs-btn fs-btn-ghost" @click="exportConfig(true)" :disabled="exporting">导出含密钥包</button>
        <button class="fs-btn fs-btn-ghost" @click="openImportDialog">导入迁移包</button>
      </div>
      <div class="migration-note">
        默认迁移包不含数据库密码、Teable Token、OAuth Secret 和告警 Webhook URL。含密钥包仅系统所有者可导出，只适合可信内网或离线迁移；导入后自动任务默认停用，需要确认连接测试通过后再手动启动。
      </div>
    </div>

    <el-dialog v-model="importDialogVisible" title="导入配置迁移包" width="760px" top="7vh">
      <el-form label-position="top">
        <el-form-item label="迁移包 JSON">
          <el-input
            v-model="importText"
            type="textarea"
            :rows="10"
            placeholder="粘贴 teable-sync-config-xxxx.json 的内容"
          />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="导入方式">
              <el-select v-model="importMode" style="width:100%">
                <el-option label="合并到当前环境" value="merge" />
                <el-option label="替换当前配置" value="replace" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="运行日志">
              <el-switch v-model="importLogs" active-text="导入" inactive-text="不导入" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="自动任务">
              <el-switch v-model="disableImportedTasks" active-text="导入后停用" inactive-text="保持原状态" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>

      <div class="preview-actions">
        <button class="fs-btn fs-btn-ghost" @click="previewImport" :disabled="importPreviewLoading || !importText.trim()">
          预检迁移包
        </button>
      </div>

      <div v-if="importPreview" class="import-preview">
        <div class="preview-summary" :class="{ invalid: !importPreview.valid }">
          <strong>{{ importPreview.valid ? '迁移包可导入' : '迁移包不可导入' }}</strong>
          <span>{{ importPreview.package?.format }} · {{ importPreview.package?.exportedAt ? formatTime(importPreview.package.exportedAt) : '未知导出时间' }}</span>
        </div>
        <div class="preview-grid">
          <div><span>连接</span><strong>{{ importPreview.summary.connections.count }}</strong><small>{{ importPreview.summary.connections.conflicts }} 冲突</small></div>
          <div><span>任务</span><strong>{{ importPreview.summary.syncTasks.count }}</strong><small>{{ importPreview.summary.syncTasks.conflicts }} 冲突</small></div>
          <div><span>模板</span><strong>{{ importPreview.summary.taskTemplates.count }}</strong><small>{{ importPreview.summary.taskTemplates.conflicts }} 冲突</small></div>
          <div><span>日志</span><strong>{{ importPreview.summary.syncLogs.count }}</strong><small>{{ importLogs ? '将导入' : '不导入' }}</small></div>
        </div>
        <div v-if="importPreview.errors?.length" class="preview-list errors">
          <strong>错误</strong>
          <span v-for="item in importPreview.errors" :key="item">{{ item }}</span>
        </div>
        <div v-if="importPreview.warnings?.length" class="preview-list warnings">
          <strong>提醒</strong>
          <span v-for="item in importPreview.warnings" :key="item">{{ item }}</span>
        </div>
      </div>

      <template #footer>
        <button class="fs-btn fs-btn-ghost" @click="importDialogVisible = false">取消</button>
        <button class="fs-btn fs-btn-primary" @click="applyImport" :disabled="importing || !importPreview?.valid">
          {{ importing ? '导入中...' : '确认导入' }}
        </button>
      </template>
    </el-dialog>

    <el-empty v-if="!doctor && !loading" description="暂无检查结果" />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getSystemDoctor, getConfigBackups, exportConfigPackage, previewConfigImport, importConfigPackage, getTestEnvironment, cleanupTestEnvironment, runSystemAcceptance } from '../api'

const loading = ref(false)
const backupsLoading = ref(false)
const doctor = ref(null)
const backups = ref([])
const exporting = ref(false)
const importDialogVisible = ref(false)
const importText = ref('')
const importPreview = ref(null)
const importPreviewLoading = ref(false)
const importing = ref(false)
const acceptanceLoading = ref(false)
const acceptance = ref(null)
const environmentLoading = ref(false)
const environment = ref(null)
const cleanupLoading = ref(false)
const importMode = ref('merge')
const importLogs = ref(false)
const disableImportedTasks = ref(true)

function statusLabel(status) {
  return { pass: '健康', warn: '需关注', fail: '异常' }[status] || status
}

function statusText(status) {
  return { pass: '通过', warn: '警告', fail: '失败' }[status] || status
}

function formatTime(ts) {
  return ts ? new Date(ts).toLocaleString('zh-CN') : '-'
}

function formatSize(size) {
  if (!Number.isFinite(Number(size))) return '-'
  if (size < 1024) return `${size} B`
  return `${(size / 1024).toFixed(1)} KB`
}


async function runAcceptance() {
  acceptanceLoading.value = true
  try {
    acceptance.value = await runSystemAcceptance({ connectionScope: 'baseline', preflightLimit: 3 })
    if (acceptance.value.status === 'pass') ElMessage.success('一键验收通过')
    else if (acceptance.value.status === 'warn') ElMessage.warning('一键验收完成，有项目需要关注')
    else ElMessage.error('一键验收发现阻断问题')
    await loadDoctor()
    await loadEnvironment()
  } catch (err) {
    ElMessage.error('一键验收失败: ' + err.message)
  } finally {
    acceptanceLoading.value = false
  }
}

async function loadEnvironment() {
  environmentLoading.value = true
  try {
    environment.value = await getTestEnvironment({ keepRecentLogs: 200 })
  } catch (err) {
    environment.value = null
    ElMessage.error('测试环境预览失败: ' + err.message)
  } finally {
    environmentLoading.value = false
  }
}

async function cleanupEnvironment() {
  if (!environment.value) return
  const total = environment.value.summary.removableConnections + environment.value.summary.removableTasks + environment.value.summary.removableTemplates + environment.value.summary.removableLogs
  try {
    await ElMessageBox.confirm(`将保留基准数据源，并整理 ${total} 项临时数据。该操作会先生成配置备份，确定继续吗？`, '整理测试环境', { type: 'warning' })
  } catch {
    return
  }
  cleanupLoading.value = true
  try {
    environment.value = await cleanupTestEnvironment({ keepRecentLogs: 200 })
    ElMessage.success('测试环境已整理')
    await loadDoctor()
  } catch (err) {
    ElMessage.error('整理失败: ' + err.message)
  } finally {
    cleanupLoading.value = false
  }
}

async function loadDoctor() {
  loading.value = true
  try {
    doctor.value = await getSystemDoctor()
    await loadBackups()
  } catch (err) {
    ElMessage.error('系统检查失败: ' + err.message)
  } finally {
    loading.value = false
  }
}

async function loadBackups() {
  backupsLoading.value = true
  try {
    backups.value = await getConfigBackups({ limit: 20 })
  } catch {
    backups.value = []
  } finally {
    backupsLoading.value = false
  }
}

function downloadJson(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

async function exportConfig(includeSecrets) {
  if (includeSecrets) {
    try {
      await ElMessageBox.confirm('含密钥迁移包会包含数据库密码、Teable Token、OAuth Secret 和告警 Webhook URL。只应在可信环境中保存和传输。确定继续吗？', '导出含密钥包', { type: 'warning' })
    } catch {
      return
    }
  }
  exporting.value = true
  try {
    const data = await exportConfigPackage({ includeSecrets, includeLogs: false })
    const suffix = includeSecrets ? 'with-secrets' : 'safe'
    downloadJson(`teable-sync-config-${suffix}-${new Date().toISOString().slice(0, 10)}.json`, data)
    ElMessage.success('迁移包已导出')
  } catch (err) {
    ElMessage.error('导出失败: ' + err.message)
  } finally {
    exporting.value = false
  }
}

function openImportDialog() {
  importDialogVisible.value = true
  importPreview.value = null
}

function parseImportText() {
  try {
    return JSON.parse(importText.value)
  } catch {
    throw new Error('迁移包 JSON 格式不正确')
  }
}

async function previewImport() {
  importPreviewLoading.value = true
  try {
    importPreview.value = await previewConfigImport(parseImportText())
    if (importPreview.value.valid) ElMessage.success('迁移包预检通过')
    else ElMessage.warning('迁移包存在错误，请检查')
  } catch (err) {
    importPreview.value = null
    ElMessage.error('预检失败: ' + err.message)
  } finally {
    importPreviewLoading.value = false
  }
}

async function applyImport() {
  if (!importPreview.value?.valid) return
  const action = importMode.value === 'replace' ? '替换当前配置' : '合并到当前配置'
  try {
    await ElMessageBox.confirm(`确定${action}？系统会先自动备份当前配置，导入后调度器会重置。`, '确认导入', { type: 'warning' })
  } catch {
    return
  }
  importing.value = true
  try {
    await importConfigPackage(parseImportText(), {
      mode: importMode.value,
      includeLogs: importLogs.value,
      disableImportedTasks: disableImportedTasks.value,
    })
    ElMessage.success('配置导入完成')
    importDialogVisible.value = false
    importText.value = ''
    importPreview.value = null
    await loadDoctor()
  } catch (err) {
    if (err.response?.data?.preview) importPreview.value = err.response.data.preview
    ElMessage.error('导入失败: ' + err.message)
  } finally {
    importing.value = false
  }
}

onMounted(async () => {
  await loadDoctor()
  await loadEnvironment()
})
</script>

<style scoped>
.doctor-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.doctor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.doctor-summary {
  padding: 20px 24px;
}

.summary-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.summary-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.summary-status {
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 600;
}

.summary-status.pass,
.check-status.pass,
.count.pass {
  color: var(--green);
}

.summary-status.warn,
.check-status.warn,
.count.warn {
  color: var(--amber);
}

.summary-status.fail,
.check-status.fail,
.count.fail {
  color: var(--red);
}

.summary-counts {
  display: flex;
  gap: 16px;
  margin-bottom: 8px;
  font-size: 13px;
}

.summary-time {
  color: var(--text-tertiary);
  font-size: 12px;
}

.check-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.check-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
}

.check-status {
  flex: 0 0 auto;
  min-width: 42px;
  font-size: 12px;
  font-weight: 700;
}

.check-title {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.check-message {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}


.acceptance-card,
.environment-card {
  padding: 16px;
}

.inline-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
}

.acceptance-summary {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-elevated);
}
.acceptance-summary.pass { border-color: rgba(5,150,105,0.24); background: rgba(5,150,105,0.08); }
.acceptance-summary.warn { border-color: rgba(245,158,11,0.24); background: rgba(245,158,11,0.08); }
.acceptance-summary.fail { border-color: rgba(220,38,38,0.24); background: rgba(220,38,38,0.08); }
.acceptance-summary strong {
  display: block;
  color: var(--text-primary);
  font-size: 16px;
}
.acceptance-summary span,
.acceptance-summary small {
  color: var(--text-secondary);
  font-size: 12px;
}

.acceptance-steps {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}
.acceptance-step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.environment-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.environment-grid div {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}
.environment-grid span,
.environment-grid small {
  color: var(--text-tertiary);
  font-size: 11px;
}
.environment-grid strong {
  color: var(--text-primary);
  font-size: 18px;
}
.environment-warnings {
  margin-top: 12px;
}

.backup-card {
  padding: 16px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 14px;
}

.section-title {
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 700;
}

.section-desc {
  margin-top: 4px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.backup-count {
  color: var(--text-tertiary);
  font-size: 12px;
  font-weight: 600;
}

.migration-card {
  padding: 16px;
}

.migration-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.migration-note {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(245,158,11,0.22);
  border-radius: var(--radius-sm);
  background: rgba(245,158,11,0.08);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.preview-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}

.import-preview {
  display: grid;
  gap: 12px;
}

.preview-summary {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid rgba(5,150,105,0.22);
  border-radius: var(--radius-sm);
  background: rgba(5,150,105,0.08);
}
.preview-summary.invalid {
  border-color: rgba(220,38,38,0.22);
  background: rgba(220,38,38,0.08);
}
.preview-summary strong {
  color: var(--text-primary);
}
.preview-summary span {
  color: var(--text-tertiary);
  font-size: 12px;
}

.preview-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.preview-grid div {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}
.preview-grid span,
.preview-grid small {
  color: var(--text-tertiary);
  font-size: 11px;
}
.preview-grid strong {
  color: var(--text-primary);
  font-size: 18px;
}

.preview-list {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.preview-list strong {
  color: var(--text-primary);
}
.preview-list.errors {
  background: rgba(220,38,38,0.08);
  color: var(--red);
}
.preview-list.warnings {
  background: rgba(245,158,11,0.08);
  color: var(--amber);
}

@media (max-width: 720px) {
  .doctor-actions,
  .preview-summary {
    flex-direction: column;
    align-items: stretch;
  }
  .environment-grid,
  .preview-grid {
    grid-template-columns: 1fr;
  }
}
</style>

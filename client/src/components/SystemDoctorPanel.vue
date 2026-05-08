<template>
  <div class="doctor-page">
    <div class="doctor-actions">
      <button class="fs-btn fs-btn-ghost" @click="openImportDialog">
        导入迁移包
      </button>
      <button class="fs-btn fs-btn-ghost" @click="exportConfig(false)" :disabled="exporting">
        导出配置
      </button>
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

    <div class="fs-card backup-card">
      <div class="section-header">
        <div>
          <div class="section-title">配置备份</div>
          <div class="section-desc">自动保留最近的加密配置快照</div>
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
          <div class="section-desc">导出可迁移配置，或导入其他环境的迁移包。默认不包含连接密码和 Token。</div>
        </div>
      </div>
      <div class="migration-actions">
        <button class="fs-btn fs-btn-primary" @click="exportConfig(false)" :disabled="exporting">导出迁移包</button>
        <button class="fs-btn fs-btn-ghost" @click="exportConfig(true)" :disabled="exporting">导出含密钥包</button>
        <button class="fs-btn fs-btn-ghost" @click="openImportDialog">导入迁移包</button>
      </div>
      <div class="migration-note">
        含密钥包只适合可信内网或离线迁移。导入后自动任务默认停用，需要确认连接测试通过后再手动启动。
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
import { getSystemDoctor, getConfigBackups, exportConfigPackage, previewConfigImport, importConfigPackage } from '../api'

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
      await ElMessageBox.confirm('含密钥迁移包会包含数据库密码和 Teable Token。只应在可信环境中保存和传输。确定继续吗？', '导出含密钥包', { type: 'warning' })
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

onMounted(loadDoctor)
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
  .preview-grid {
    grid-template-columns: 1fr;
  }
}
</style>

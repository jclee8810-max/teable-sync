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

    <el-empty v-if="!doctor && !loading" description="暂无检查结果" />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { getSystemDoctor, getConfigBackups } from '../api'

const loading = ref(false)
const backupsLoading = ref(false)
const doctor = ref(null)
const backups = ref([])

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
</style>

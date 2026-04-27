<template>
  <div class="connections-page">
    <!-- Header -->
    <div class="page-actions">
      <button class="fs-btn fs-btn-primary" @click="openDialog()">
        <el-icon><Plus /></el-icon>添加连接
      </button>
    </div>

    <!-- Connection Cards Grid -->
    <div class="conn-grid">
      <div v-for="conn in connections" :key="conn.id" class="fs-card conn-card">
        <div class="conn-card-top">
          <div class="conn-type-icon" :class="conn.type">
            <svg v-if="conn.type === 'mssql'" viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
              <path d="M4 3h5c1.1 0 2 .9 2 2v5c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V5c0-1.1.9-2 2-2zm11 0h5c1.1 0 2 .9 2 2v5c0 1.1-.9 2-2 2h-5c-1.1 0-2-.9-2-2V5c0-1.1.9-2 2-2zM4 14h5c1.1 0 2 .9 2 2v5c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2v-5c0-1.1.9-2 2-2zm11 0h5c1.1 0 2 .9 2 2v5c0 1.1-.9 2-2 2h-5c-1.1 0-2-.9-2-2v-5c0-1.1.9-2 2-2z"/>
            </svg>
            <svg v-else-if="conn.type === 'mysql'" viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
            </svg>
            <svg v-else-if="conn.type === 'pg'" viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5-9h10v2H7z"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
              <path d="M3 3v18h18V3H3zm16 16H5V5h14v14zM7 7h4v4H7V7zm6 0h4v4h-4V7zm-6 6h4v4H7v-4zm6 0h4v4h-4v-4z"/>
            </svg>
          </div>
          <el-dropdown trigger="click">
            <button class="icon-btn">
              <el-icon :size="16"><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item @click="testConn(conn.id)">
                  <el-icon><VideoPlay /></el-icon>测试连接
                </el-dropdown-item>
                <el-dropdown-item @click="openDialog(conn)">
                  <el-icon><Edit /></el-icon>编辑
                </el-dropdown-item>
                <el-dropdown-item @click="removeConn(conn.id)" divided>
                  <span style="color:var(--red)"><el-icon><Delete /></el-icon>删除</span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <div class="conn-card-body">
          <div class="conn-name">{{ conn.name }}</div>
          <div class="conn-type-label">{{ typeLabel(conn.type) }}</div>
          <div class="conn-endpoint">
            <span class="endpoint-icon">⬡</span>
            <span v-if="conn.type !== 'teable'">{{ conn.host }}:{{ conn.port }}</span>
            <span v-else>{{ conn.host }}</span>
          </div>
          <div class="conn-meta">
            <span v-if="conn.type !== 'teable'" class="conn-meta-item">
              <span class="meta-label">数据库</span>
              <span class="meta-value">{{ conn.database }}</span>
            </span>
            <span v-if="conn.type !== 'teable'" class="conn-meta-item">
              <span class="meta-label">用户</span>
              <span class="meta-value">{{ conn.username }}</span>
            </span>
            <span v-if="conn.type === 'teable'" class="conn-meta-item">
              <span class="meta-label">Token</span>
              <span class="meta-value">{{ conn.token ? conn.token.substring(0, 12) + '…' : '未设置' }}</span>
            </span>
          </div>
        </div>

        <div class="conn-card-footer">
          <span v-if="conn._tested === true" class="conn-status active">● 已连接</span>
          <span v-else-if="conn._tested === false" class="conn-status error">● 连接失败</span>
          <span v-else class="conn-status unknown">○ 未测试</span>
        </div>
      </div>

      <!-- Add New Card -->
      <div class="conn-card conn-card-add" @click="openDialog()">
        <div class="add-card-content">
          <el-icon :size="32"><Plus /></el-icon>
          <span>添加连接</span>
        </div>
      </div>
    </div>

    <el-empty v-if="connections.length === 0" description="暂无数据源，点击添加连接开始" />

    <!-- Dialog -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑连接' : '添加连接'" width="520px" destroy-on-close>
      <el-form :model="form" label-width="90px" label-position="top">
        <el-form-item label="连接名称">
          <el-input v-model="form.name" placeholder="例如：生产数据库" />
        </el-form-item>
        <el-form-item label="连接类型">
          <el-select v-model="form.type" @change="onTypeChange" style="width:100%">
            <el-option label="SQL Server" value="mssql" />
            <el-option label="MySQL" value="mysql" />
            <el-option label="PostgreSQL" value="pg" />
            <el-option label="Teable" value="teable" />
          </el-select>
        </el-form-item>

        <template v-if="form.type === 'teable'">
          <el-form-item label="服务器地址">
            <el-input v-model="form.host" placeholder="http://localhost:3000 或 https://your-teable.com" />
          </el-form-item>
          <el-form-item label="API Token">
            <el-input v-model="form.token" type="password" placeholder="teable_xxxx_..." show-password />
          </el-form-item>
          <el-button type="success" plain @click="testTeableInDialog" :loading="testingInline" style="margin-bottom:16px">
            <el-icon><Connection /></el-icon>测试连接
          </el-button>
          <el-alert v-if="testResult" :title="testResult.message" :type="testResult.success ? 'success' : 'error'"
            show-icon :closable="false" style="margin-bottom:12px" />
        </template>

        <template v-else>
          <el-form-item label="主机地址">
            <el-input v-model="form.host" placeholder="localhost" />
          </el-form-item>
          <el-row :gutter="12">
            <el-col :span="12">
              <el-form-item label="端口">
                <el-input v-model="form.port" :placeholder="defaultPort" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="数据库">
                <el-input v-model="form.database" placeholder="your_database" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-form-item label="用户名">
            <el-input v-model="form.username" placeholder="sa" />
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="form.password" type="password" show-password />
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <button class="fs-btn fs-btn-ghost" @click="dialogVisible = false">取消</button>
        <button class="fs-btn fs-btn-primary" @click="saveConn" :disabled="saving">
          保存
        </button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getConnections, createConnection, updateConnection, deleteConnection, testConnection, testTeable } from '../api'

const connections = ref([])
const dialogVisible = ref(false)
const editingId = ref(null)
const saving = ref(false)
const testingInline = ref(false)
const testResult = ref(null)

const defaultForm = { name: '', type: 'mssql', host: 'localhost', port: '', database: '', username: '', password: '', token: '' }
const form = ref({ ...defaultForm })

const defaultPort = computed(() => ({ mssql: '1433', mysql: '3306', pg: '5432' }[form.value.type] || ''))

function typeLabel(type) {
  return { mssql: 'SQL Server', mysql: 'MySQL', pg: 'PostgreSQL', teable: 'Teable' }[type] || type
}

function onTypeChange() {
  if (form.value.type === 'teable') {
    form.value.host = 'http://localhost:3000'
  } else {
    form.value.host = 'localhost'
    form.value.port = defaultPort.value
  }
  testResult.value = null
}

async function testTeableInDialog() {
  if (!form.value.host || !form.value.token) {
    ElMessage.warning('请填写服务器地址和 Token')
    return
  }
  testingInline.value = true
  testResult.value = null
  try {
    const result = await testTeable({ host: form.value.host, token: form.value.token })
    testResult.value = result
  } catch (err) {
    testResult.value = { success: false, message: err.message }
  } finally {
    testingInline.value = false
  }
}

function openDialog(conn = null) {
  testResult.value = null
  if (conn) {
    editingId.value = conn.id
    form.value = { ...conn }
  } else {
    editingId.value = null
    form.value = { ...defaultForm, type: 'mssql', port: '1433' }
  }
  dialogVisible.value = true
}

async function saveConn() {
  if (!form.value.name || !form.value.type) {
    ElMessage.warning('请填写连接名称和类型')
    return
  }
  saving.value = true
  try {
    if (editingId.value) {
      await updateConnection(editingId.value, form.value)
      ElMessage.success('连接已更新')
    } else {
      await createConnection(form.value)
      ElMessage.success('连接已添加')
    }
    dialogVisible.value = false
    await loadConnections()
  } catch (err) {
    ElMessage.error('保存失败: ' + err.message)
  } finally {
    saving.value = false
  }
}

async function removeConn(id) {
  await ElMessageBox.confirm('确定删除此连接？', '提示', { type: 'warning' })
  await deleteConnection(id)
  ElMessage.success('已删除')
  await loadConnections()
}

async function testConn(id) {
  const loading = ElMessage({ message: '正在测试连接...', type: 'info', duration: 0 })
  try {
    const result = await testConnection(id)
    loading.close()
    const conn = connections.value.find(c => c.id === id)
    if (conn) conn._tested = !!result.success
    if (result.success) {
      ElMessage.success('连接成功! ' + (result.message || result.version || ''))
    } else {
      ElMessage.error('连接失败: ' + (result.error || '未知错误'))
    }
  } catch (err) {
    loading.close()
    const conn = connections.value.find(c => c.id === id)
    if (conn) conn._tested = false
    ElMessage.error('测试失败: ' + err.message)
  }
}

async function loadConnections() {
  connections.value = await getConnections()
}

onMounted(loadConnections)
</script>

<style scoped>
.connections-page {}

.page-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 24px;
}

.conn-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 20px;
}

.conn-card {
  display: flex;
  flex-direction: column;
  cursor: default;
}

.conn-card-add {
  cursor: pointer;
  border: 2px dashed var(--border-default);
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  transition: all 0.2s ease;
}
.conn-card-add:hover {
  border-color: var(--accent);
  background: var(--accent-muted);
}
.add-card-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-tertiary);
  font-size: 14px;
  font-weight: 500;
}
.conn-card-add:hover .add-card-content { color: var(--accent-hover); }

.conn-card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}

.conn-type-icon {
  width: 44px; height: 44px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
}
.conn-type-icon.mssql { background: rgba(245,158,11,0.15); color: #f59e0b; }
.conn-type-icon.mysql { background: rgba(59,130,246,0.15); color: #3b82f6; }
.conn-type-icon.pg { background: rgba(139,92,246,0.15); color: #8b5cf6; }
.conn-type-icon.teable { background: rgba(16,185,129,0.15); color: #10b981; }

.icon-btn {
  background: transparent;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 6px;
  border-radius: var(--radius-sm);
  transition: all 0.15s ease;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

.conn-card-body { flex: 1; }

.conn-name {
  font-size: 17px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.conn-type-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 14px;
}

.conn-endpoint {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-elevated);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 14px;
}
.endpoint-icon { font-size: 10px; opacity: 0.5; }

.conn-meta {
  display: flex;
  gap: 20px;
}
.conn-meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.meta-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-tertiary);
}
.meta-value {
  font-size: 13px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
}

.conn-card-footer {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border-subtle);
}

.conn-status {
  font-size: 12px;
  font-weight: 500;
}
.conn-status.active { color: var(--green); }
.conn-status.error { color: var(--red); }
.conn-status.unknown { color: var(--text-tertiary); }
</style>

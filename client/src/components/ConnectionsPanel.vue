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

          <!-- Token 手动输入模式 -->
          <el-form-item label="API Token" v-if="!showOAuthSetup">
            <el-input v-model="form.token" type="password" placeholder="teable_xxxx_..." show-password />
          </el-form-item>

          <!-- OAuth 连接模式 -->
          <div v-if="!editingId && !form.token" class="oauth-connect-area">
            <el-button type="primary" plain @click="startOAuthFlow" :loading="oauthLoading">
              <el-icon><Key /></el-icon>OAuth 连接 Teable 账号
            </el-button>
            <p class="oauth-hint">使用 Teable 官方授权方式，更安全，无需手动输入 Token</p>
          </div>

          <!-- OAuth 已连接状态 -->
          <div v-if="form.token && !editingId" class="oauth-connected">
            <el-alert
              title="已通过 OAuth 连接"
              type="success"
              :description="'账号: ' + (oauthStatus.email || form.host)"
              show-icon :closable="false" style="margin-bottom:8px" />
            <el-button type="warning" plain size="small" @click="showOAuthSetup = true">
              切换账号
            </el-button>
          </div>

          <el-button type="success" plain @click="testTeableInDialog" :loading="testingInline" style="margin-top:12px" v-if="form.token">
            <el-icon><Connection /></el-icon>测试连接
          </el-button>
          <el-alert v-if="testResult" :title="testResult.message" :type="testResult.success ? 'success' : 'error'"
            show-icon :closable="false" style="margin-bottom:12px" />

          <!-- OAuth 快速设置（新建连接时显示） -->
          <div v-if="!editingId && showOAuthSetup" class="oauth-setup-area">
            <el-divider content-position="left">快速配置 OAuth</el-divider>
            <el-form-item label="Teable 管理员邮箱">
              <el-input v-model="oauthForm.email" placeholder="admin@your-teable.com" />
            </el-form-item>
            <el-form-item label="Teable 管理员密码">
              <el-input v-model="oauthForm.password" type="password" show-password placeholder="密码" />
            </el-form-item>
            <el-form-item label="OAuth 应用名称">
              <el-input v-model="oauthForm.appName" placeholder="TeableSync" />
            </el-form-item>
            <el-button type="primary" @click="createOAuthApp" :loading="oauthCreating">
              自动创建 OAuth 应用
            </el-button>
            <p class="oauth-hint" style="margin-top:8px">
              自动在你的 Teable 实例创建 OAuth 应用（需要管理员账号），或手动在 Teable 管理后台创建后填入 clientId 和 clientSecret
            </p>
            <el-alert v-if="oauthAppResult" :title="oauthAppResult.message"
              :type="oauthAppResult.clientId ? 'success' : 'error'"
              show-icon :closable="false" style="margin-top:12px">
              <template #default v-if="oauthAppResult.clientId">
                <div><b>Client ID:</b> <code>{{ oauthAppResult.clientId }}</code></div>
                <div><b>Client Secret:</b> <code>{{ oauthAppResult.clientSecret }}</code></div>
              </template>
            </el-alert>
          </div>
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
const oauthLoading = ref(false)
const oauthCreating = ref(false)
const oauthAppResult = ref(null)
const showOAuthSetup = ref(false)
const oauthStatus = ref({ email: null })
const oauthForm = ref({ email: '', password: '', appName: 'TeableSync' })

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

async function startOAuthFlow() {
  if (!form.value.name) {
    ElMessage.warning('请先填写连接名称')
    return
  }
  if (!form.value.host) {
    ElMessage.warning('请先填写服务器地址')
    return
  }
  // Save connection first to get an ID
  saving.value = true
  let connId = editingId.value
  try {
    if (!connId) {
      const created = await createConnection(form.value)
      connId = created.id
    }
  } catch (err) {
    ElMessage.error('保存连接失败: ' + err.message)
    saving.value = false
    return
  }
  saving.value = false

  // Check if we have OAuth credentials configured
  if (!oauthForm.value.email || !oauthForm.value.password) {
    ElMessage.info('请先在下方填写 Teable 管理员邮箱和密码来创建 OAuth 应用')
    showOAuthSetup.value = true
    return
  }

  oauthLoading.value = true
  try {
    const res = await fetch('/api/oauth/teable/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('token')}`,
      },
      body: JSON.stringify({
        connectionId: connId,
        teableHost: form.value.host,
        clientId: oauthForm.value.clientId,
        clientSecret: oauthForm.value.clientSecret,
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '启动 OAuth 失败')
    // Redirect browser to Teable authorization page
    window.location.href = data.authUrl
  } catch (err) {
    ElMessage.error(err.message)
    oauthLoading.value = false
  }
}

async function createOAuthApp() {
  if (!oauthForm.value.email || !oauthForm.value.password || !oauthForm.value.appName) {
    ElMessage.warning('请填写管理员邮箱、密码和应用名称')
    return
  }
  if (!form.value.host) {
    ElMessage.warning('请先填写服务器地址')
    return
  }
  oauthCreating.value = true
  oauthAppResult.value = null
  try {
    const res = await fetch('/api/oauth/teable/app', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('token')}`,
      },
      body: JSON.stringify({
        teableHost: form.value.host,
        email: oauthForm.value.email,
        password: oauthForm.value.password,
        appName: oauthForm.value.appName,
        redirectUri: `${window.location.protocol}//${window.location.host}/api/oauth/teable/callback`,
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '创建 OAuth 应用失败')
    oauthAppResult.value = data
    oauthForm.value.clientId = data.clientId
    oauthForm.value.clientSecret = data.clientSecret
    ElMessage.success('OAuth 应用创建成功！可以开始授权了')
  } catch (err) {
    ElMessage.error(err.message)
  } finally {
    oauthCreating.value = false
  }
}

async function checkOAuthStatus(connId) {
  try {
    const res = await fetch(`/api/oauth/teable/status/${connId}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    })
    if (res.ok) {
      const data = await res.json()
      if (data.connected) {
        oauthStatus.value = { email: data.email }
      }
    }
  } catch (e) {}
}

function openDialog(conn = null) {
  testResult.value = null
  oauthAppResult.value = null
  showOAuthSetup.value = false
  oauthStatus.value = { email: null }
  oauthForm.value = { email: '', password: '', appName: 'TeableSync' }
  if (conn) {
    editingId.value = conn.id
    form.value = { ...conn }
    if (conn.type === 'teable' && conn.id) {
      checkOAuthStatus(conn.id)
    }
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

<template>
  <div class="auth-page">
    <div class="auth-card">
      <div class="auth-brand">
        <div class="brand-icon">
          <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 16L12 8V13H20V8L28 16L20 24V19H12V24L4 16Z" fill="url(#g1)"/>
            <defs><linearGradient id="g1" x1="4" y1="8" x2="28" y2="24"><stop stop-color="#6366F1"/><stop offset="1" stop-color="#06B6D4"/></linearGradient></defs>
          </svg>
        </div>
        <h1 class="brand-title">Teable Sync</h1>
        <p class="brand-subtitle">SQL → Teable 数据同步引擎</p>
      </div>

      <div class="auth-tabs" v-if="!user">
        <button v-for="t in tabs" :key="t.key" class="auth-tab" :class="{ active: mode === t.key }" @click="mode = t.key; error = ''; success = ''">{{ t.label }}</button>
      </div>

      <!-- Login -->
      <form v-if="mode === 'login'" class="auth-form" @submit.prevent="handleLogin">
        <div class="form-field">
          <label>邮箱</label>
          <el-input v-model="form.email" type="email" placeholder="your@email.com" size="large" />
        </div>
        <div class="form-field">
          <label>密码</label>
          <el-input v-model="form.password" type="password" placeholder="输入密码" size="large" show-password />
        </div>
        <div v-if="error" class="auth-error">{{ error }}</div>
        <button type="submit" class="auth-submit" :disabled="loading">{{ loading ? '登录中...' : '登录' }}</button>

        <div class="oauth-divider"><span>或</span></div>
        <button type="button" class="oauth-btn" @click="handleTeableLogin">
          <svg class="oauth-icon" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="5" fill="#4F46E5"/><path d="M7 7h10v10H7z" fill="#fff" opacity="0.3"/><path d="M9 9h6M9 12h4M9 15h5" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/></svg>
          用 Teable 账号登录
        </button>

        <p class="auth-hint">还没有账号？<button type="button" class="text-btn" @click="mode = 'register'">立即注册</button></p>
      </form>

      <!-- Register -->
      <form v-if="mode === 'register'" class="auth-form" @submit.prevent="handleRegister">
        <div class="form-field">
          <label>邮箱（作为账号）</label>
          <el-input v-model="form.email" type="email" placeholder="your@email.com" size="large" />
        </div>
        <div class="form-field">
          <label>密码</label>
          <el-input v-model="form.password" type="password" placeholder="至少6个字符" size="large" show-password />
        </div>
        <div class="form-field">
          <label>确认密码</label>
          <el-input v-model="form.password2" type="password" placeholder="再输一次密码" size="large" show-password />
        </div>
        <div v-if="error" class="auth-error">{{ error }}</div>
        <button type="submit" class="auth-submit" :disabled="loading">{{ loading ? '注册中...' : '创建账号' }}</button>
        <p class="register-note">第一个注册的将成为系统所有者</p>
        <p class="auth-hint">已有账号？<button type="button" class="text-btn" @click="mode = 'login'">直接登录</button></p>
      </form>

      <!-- Profile -->
      <template v-if="mode === 'profile'">
        <div class="user-info-card">
          <div class="user-avatar-lg">{{ user?.email?.[0]?.toUpperCase() }}</div>
          <div>
            <div class="user-email">{{ user?.email }}</div>
            <div class="user-role-tag">{{ roleLabel(user?.role) }}</div>
          </div>
        </div>

        <!-- Profile sub-tabs -->
        <div class="profile-tabs">
          <button class="profile-tab" :class="{ active: profileTab === 'password' }" @click="profileTab = 'password'; error = ''; success = ''">修改密码</button>
          <button v-if="isAdmin(user)" class="profile-tab" :class="{ active: profileTab === 'users' }" @click="profileTab = 'users'; error = ''; success = ''">用户管理</button>
        </div>

        <!-- 修改密码 -->
        <form v-if="profileTab === 'password'" class="auth-form" @submit.prevent="handleChangePassword">
          <div class="form-field">
            <label>旧密码</label>
            <el-input v-model="form.oldPassword" type="password" placeholder="输入旧密码" size="large" show-password />
          </div>
          <div class="form-field">
            <label>新密码</label>
            <el-input v-model="form.newPassword" type="password" placeholder="至少6个字符" size="large" show-password />
          </div>
          <div v-if="error" class="auth-error">{{ error }}</div>
          <div v-if="success" class="auth-success">{{ success }}</div>
          <button type="submit" class="auth-submit" :disabled="loading">{{ loading ? '修改中...' : '修改密码' }}</button>
        </form>

        <!-- 用户管理 (admin only) -->
        <div v-if="profileTab === 'users'" class="user-list-section">
          <div class="user-management-head">
            <div class="user-stat">
              <span>用户</span>
              <strong>{{ filteredUsers.length }}/{{ users.length }}</strong>
            </div>
            <div class="user-stat">
              <span>管理员</span>
              <strong>{{ adminCount }}</strong>
            </div>
          </div>
          <div class="user-tools">
            <el-input
              v-model="userSearch"
              clearable
              size="small"
              placeholder="搜索邮箱"
              class="user-search"
            />
            <el-select v-model="roleFilter" size="small" class="role-filter">
              <el-option label="全部角色" value="" />
              <el-option label="系统所有者" value="owner" />
              <el-option label="超级管理员" value="super_admin" />
              <el-option label="普通用户" value="user" />
            </el-select>
          </div>
          <div v-if="usersLoading" class="loading-text">加载中...</div>
          <div v-else class="user-list">
            <div v-for="u in filteredUsers" :key="u.id" class="user-row">
              <div class="user-row-left">
                <div class="user-row-avatar">{{ u.email?.[0]?.toUpperCase() }}</div>
                <div>
                  <div class="user-row-email">{{ u.email }}</div>
                  <div class="user-row-role">
                    <span>{{ roleLabel(u.role) }}</span>
                    <span v-if="u.id === user?.id">当前账号</span>
                  </div>
                </div>
              </div>
              <div v-if="u.id !== user?.id && isOwner(user) && u.role !== 'owner'" class="user-actions">
                <el-select
                  :model-value="u.role"
                  size="small"
                  class="role-select"
                  :disabled="roleUpdatingId === u.id"
                  @change="role => doUpdateRole(u, role)"
                >
                  <el-option label="普通用户" value="user" />
                  <el-option label="超级管理员" value="super_admin" />
                </el-select>
                <button v-if="u.role === 'user'" class="del-btn" @click="doDeleteUser(u.id)" :disabled="deletingId === u.id">
                  {{ deletingId === u.id ? '删除中...' : '删除' }}
                </button>
              </div>
              <div v-else class="current-user-lock">当前账号</div>
            </div>
            <el-empty v-if="filteredUsers.length === 0" description="没有匹配用户" :image-size="64" />
          </div>
        </div>
      </template>

      <div class="auth-footer" v-if="mode === 'profile'">
        <button class="text-btn danger" @click="handleLogout">退出登录</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { login, register, getCurrentUser, changePassword, getUsers, deleteUser, updateUserRole, exchangeTeableLoginCode, setToken, setStoredUser, clearToken, getToken } from '../api.js'

const emit = defineEmits(['auth-changed'])

const mode = ref('login')
const loading = ref(false)
const deletingId = ref(null)
const roleUpdatingId = ref(null)
const error = ref('')
const success = ref('')
const user = ref(null)
const users = ref([])
const usersLoading = ref(false)
const userSearch = ref('')
const roleFilter = ref('')

const profileTab = ref('password')
const form = ref({ email: '', password: '', password2: '', oldPassword: '', newPassword: '' })

const tabs = [
  { key: 'login', label: '登录' },
  { key: 'register', label: '注册' },
]

const adminCount = computed(() => users.value.filter((u) => isAdmin(u)).length)
const filteredUsers = computed(() => {
  const keyword = userSearch.value.trim().toLowerCase()
  return users.value.filter((u) => {
    const roleOk = !roleFilter.value || u.role === roleFilter.value
    const keywordOk = !keyword || (u.email || '').toLowerCase().includes(keyword)
    return roleOk && keywordOk
  })
})

onMounted(async () => {
  // Check URL params for OAuth callback code
  const urlParams = new URLSearchParams(window.location.search)
  const oauthCode = urlParams.get('oauth_code')
  const authError = urlParams.get('auth_error')

  if (oauthCode) {
    window.history.replaceState({}, '', window.location.pathname)
    try {
      const data = await exchangeTeableLoginCode(oauthCode)
      setToken(data.token, data.user)
      user.value = data.user
      emit('auth-changed', data.user)
      return
    } catch (e) {
      clearToken()
      error.value = e.response?.data?.error || 'OAuth 登录失败，请重试'
    }
  }

  if (authError) {
    error.value = `OAuth 授权失败: ${authError}`
    window.history.replaceState({}, '', window.location.pathname)
  }

  if (getToken()) {
    mode.value = 'profile'
    profileTab.value = 'password'
    await loadProfile()
  }
})

async function loadProfile() {
  try {
    user.value = await getCurrentUser()
    setStoredUser(user.value)
    if (isAdmin(user.value)) {
      usersLoading.value = true
      try {
        users.value = await getUsers()
      } finally {
        usersLoading.value = false
      }
    }
  } catch (e) {
    clearToken()
    mode.value = 'login'
  }
}

function isOwner(row) {
  return row?.role === 'owner'
}

function isAdmin(row) {
  return row?.role === 'owner' || row?.role === 'super_admin'
}

function roleLabel(role) {
  if (role === 'owner') return '系统所有者'
  if (role === 'super_admin') return '超级管理员'
  return '普通用户'
}

async function handleLogin() {
  error.value = ''
  if (!form.value.email || !form.value.password) {
    error.value = '请填写邮箱和密码'
    return
  }
  loading.value = true
  try {
    const data = await login({ email: form.value.email, password: form.value.password })
    setToken(data.token, data.user)
    user.value = data.user
    emit('auth-changed', data.user)
  } catch (e) {
    error.value = e.response?.data?.error || '登录失败'
  } finally {
    loading.value = false
  }
}

async function handleRegister() {
  error.value = ''
  if (!form.value.email || !form.value.password || !form.value.password2) {
    error.value = '请填写所有字段'
    return
  }
  if (form.value.password !== form.value.password2) {
    error.value = '两次密码输入不一致'
    return
  }
  loading.value = true
  try {
    const data = await register({ email: form.value.email, password: form.value.password })
    setToken(data.token, data.user)
    user.value = data.user
    emit('auth-changed', data.user)
  } catch (e) {
    error.value = e.response?.data?.error || '注册失败'
  } finally {
    loading.value = false
  }
}

async function handleChangePassword() {
  error.value = ''
  success.value = ''
  if (!form.value.oldPassword || !form.value.newPassword) {
    error.value = '请填写旧密码和新密码'
    return
  }
  loading.value = true
  try {
    await changePassword({ oldPassword: form.value.oldPassword, newPassword: form.value.newPassword })
    success.value = '密码修改成功'
    form.value.oldPassword = ''
    form.value.newPassword = ''
  } catch (e) {
    error.value = e.response?.data?.error || '修改失败'
  } finally {
    loading.value = false
  }
}

async function doUpdateRole(targetUser, role) {
  if (targetUser.role === role) return
  const previousRole = targetUser.role
  roleUpdatingId.value = targetUser.id
  error.value = ''
  try {
    const updated = await updateUserRole(targetUser.id, role)
    users.value = users.value.map(u => u.id === updated.id ? updated : u)
  } catch (e) {
    targetUser.role = previousRole
    error.value = e.response?.data?.error || '角色更新失败'
  } finally {
    roleUpdatingId.value = null
  }
}

async function doDeleteUser(id) {
  deletingId.value = id
  try {
    await deleteUser(id)
    users.value = users.value.filter(u => u.id !== id)
  } catch (e) {
    error.value = e.response?.data?.error || '删除失败'
  } finally {
    deletingId.value = null
  }
}

function handleTeableLogin() {
  window.location.href = `${window.location.origin}/api/auth/teable-login`
}

function handleLogout() {
  clearToken()
  user.value = null
  users.value = []
  mode.value = 'login'
  emit('auth-changed', null)
}
</script>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #f5f6fa 0%, #e8eaf0 100%);
  padding: 20px;
}
.auth-card {
  background: #fff;
  border-radius: 18px;
  padding: 44px 40px;
  width: 100%;
  max-width: 560px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.10);
}
.auth-brand { text-align: center; margin-bottom: 32px; }
.brand-icon {
  width: 52px; height: 52px;
  background: rgba(99,102,241,0.08);
  border-radius: 14px;
  display: flex; align-items: center; justify-content: center;
  margin: 0 auto 16px;
}
.brand-icon svg { width: 28px; height: 28px; }
.brand-title { font-size: 26px; font-weight: 700; color: #1a1a2e; }
.brand-subtitle { font-size: 13px; color: #9495a0; margin-top: 6px; }

.auth-tabs {
  display: flex;
  background: #f5f6fa;
  border-radius: 10px;
  padding: 4px;
  margin-bottom: 28px;
}
.auth-tab {
  flex: 1; padding: 10px;
  border: none; background: transparent;
  font-size: 14px; font-weight: 500; color: #9495a0;
  border-radius: 8px; cursor: pointer;
  transition: all 0.2s; font-family: inherit;
}
.auth-tab.active { background: #fff; color: #6366f1; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }

.auth-form { display: flex; flex-direction: column; gap: 18px; }
.form-field { display: flex; flex-direction: column; gap: 6px; }
.form-field label { font-size: 13px; font-weight: 500; color: #5c5d6e; }

.auth-error {
  color: #dc2626; font-size: 13px;
  background: rgba(220,38,38,0.06);
  border: 1px solid rgba(220,38,38,0.2);
  padding: 10px 14px; border-radius: 8px;
}
.auth-success {
  color: #059669; font-size: 13px;
  background: rgba(5,150,105,0.06);
  border: 1px solid rgba(5,150,105,0.2);
  padding: 10px 14px; border-radius: 8px;
}
.auth-submit {
  width: 100%; padding: 13px;
  background: #6366f1; color: #fff;
  border: none; border-radius: 10px;
  font-size: 15px; font-weight: 600;
  cursor: pointer; transition: all 0.2s; font-family: inherit;
}
.auth-submit:hover:not(:disabled) { background: #818cf8; }
.auth-submit:disabled { opacity: 0.6; cursor: not-allowed; }

.auth-hint { text-align: center; font-size: 13px; color: #9495a0; }
.register-note { text-align: center; font-size: 12px; color: #9495a0; margin-top: -8px; }
.text-btn {
  background: none; border: none; color: #6366f1;
  font-size: 13px; cursor: pointer; font-family: inherit; padding: 0;
}
.text-btn:hover { text-decoration: underline; }
.text-btn.danger { color: #dc2626; }

/* Profile */
.user-info-card {
  display: flex; align-items: center; gap: 14px;
  padding: 16px; background: #f5f6fa; border-radius: 10px; margin-bottom: 4px;
}
.user-avatar-lg {
  width: 44px; height: 44px;
  background: linear-gradient(135deg, #6366f1, #06b6d4);
  color: #fff; font-size: 20px; font-weight: 700;
  border-radius: 50%; display: flex; align-items: center; justify-content: center;
}
.user-email { font-size: 15px; font-weight: 600; color: #1a1a2e; }
.user-role-tag { font-size: 12px; color: #6366f1; margin-top: 2px; }

/* User list */
.user-list-section { margin-top: 24px; border-top: 1px solid rgba(0,0,0,0.06); padding-top: 20px; }
.user-management-head {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.user-stat {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid rgba(0,0,0,0.06);
  border-radius: 8px;
  background: #f5f6fa;
}
.user-stat span {
  color: #9495a0;
  font-size: 11px;
}
.user-stat strong {
  color: #1a1a2e;
  font-size: 16px;
}
.user-tools {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 128px;
  gap: 10px;
  margin-bottom: 12px;
}
.user-search,
.role-filter {
  width: 100%;
}
.section-title {
  font-size: 12px; font-weight: 600; color: #9495a0;
  text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px;
}
.loading-text { text-align: center; color: #9495a0; font-size: 13px; padding: 12px; }
.user-list {
  max-height: 420px;
  overflow: auto;
  border: 1px solid rgba(0,0,0,0.06);
  border-radius: 10px;
}
.user-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid rgba(0,0,0,0.04);
}
.user-row:last-child { border-bottom: none; }
.user-row-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.user-row-avatar {
  width: 32px; height: 32px; background: #f5f6fa; color: #5c5d6e;
  font-size: 13px; font-weight: 600; border-radius: 50%;
  flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
}
.user-row-email {
  min-width: 0;
  max-width: 270px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  color: #1a1a2e;
}
.user-row-role {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 11px;
  color: #9495a0;
}
.del-btn {
  font-size: 12px; color: #dc2626;
  background: none; border: 1px solid rgba(220,38,38,0.2);
  border-radius: 6px; padding: 4px 10px; cursor: pointer; font-family: inherit; transition: all 0.15s;
}
.del-btn:hover:not(:disabled) { background: rgba(220,38,38,0.06); }
.del-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.user-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.role-select {
  width: 108px;
}
.current-user-lock {
  color: #9495a0;
  font-size: 12px;
  white-space: nowrap;
}

.profile-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid rgba(0,0,0,0.06);
  margin-bottom: 20px;
}
.profile-tab {
  padding: 8px 16px;
  border: none;
  background: transparent;
  font-size: 13px;
  font-weight: 500;
  color: #9495a0;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
  font-family: inherit;
  margin-bottom: -1px;
}
.profile-tab:hover { color: #6366f1; }
.profile-tab.active {
  color: #6366f1;
  border-bottom-color: #6366f1;
  font-weight: 600;
}

.auth-footer { margin-top: 20px; text-align: center; }

/* OAuth button */
.oauth-divider {
  display: flex; align-items: center; gap: 12px;
  margin: -4px 0;
}
.oauth-divider::before, .oauth-divider::after {
  content: ''; flex: 1; height: 1px; background: #e5e7eb;
}
.oauth-divider span {
  font-size: 12px; color: #9495a0; white-space: nowrap;
}
.oauth-btn {
  width: 100%; padding: 12px;
  background: #fff; color: #1a1a2e;
  border: 1.5px solid #e5e7eb; border-radius: 10px;
  font-size: 14px; font-weight: 500;
  cursor: pointer; transition: all 0.2s; font-family: inherit;
  display: flex; align-items: center; justify-content: center; gap: 10px;
}
.oauth-btn:hover { border-color: #6366f1; background: rgba(99,102,241,0.04); }
.oauth-icon { width: 22px; height: 22px; flex-shrink: 0; }

@media (max-width: 640px) {
  .auth-card {
    padding: 28px 20px;
  }
  .user-management-head,
  .user-tools,
  .user-row {
    grid-template-columns: 1fr;
  }
  .user-actions {
    justify-content: flex-start;
  }
  .user-row-email {
    max-width: 100%;
  }
}
</style>

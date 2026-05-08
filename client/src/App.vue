<template>
  <AuthPage v-if="!isLoggedIn" @auth-changed="onAuthChanged" />
  <div v-else class="app-root">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="brand-icon">
          <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 16L12 8V13H20V8L28 16L20 24V19H12V24L4 16Z" fill="url(#grad1)"/>
            <defs><linearGradient id="grad1" x1="4" y1="8" x2="28" y2="24"><stop stop-color="#6366F1"/><stop offset="1" stop-color="#06B6D4"/></linearGradient></defs>
          </svg>
        </div>
        <div class="brand-text">
          <span class="brand-name">Teable Sync</span>
          <span class="brand-tag">SQL → Teable</span>
        </div>
      </div>

      <nav class="sidebar-nav">
        <button
          v-for="item in navItems" :key="item.key"
          class="nav-item" :class="{ active: activeTab === item.key }"
          @click="activeTab = item.key; showProfile = false"
        >
          <el-icon :size="18"><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
          <span v-if="item.badge" class="nav-badge">{{ item.badge }}</span>
        </button>
      </nav>

      <div class="sidebar-context">
        <div>
          <span class="context-label">当前身份</span>
          <strong>{{ currentUser?.role === 'super_admin' ? '管理员' : '普通用户' }}</strong>
        </div>
        <div>
          <span class="context-label">运行版本</span>
          <button class="context-link" type="button" @click="versionDialogVisible = true">
            {{ versionInfo.shortCommit || 'unknown' }}
          </button>
        </div>
      </div>

      <div class="sidebar-footer">
        <div class="status-indicator">
          <span class="status-dot"></span>
          <span class="status-text">服务运行中</span>
        </div>
        <button class="version" type="button" @click="versionDialogVisible = true">
          v{{ versionInfo.version || '1.0.0' }}
          <span v-if="versionInfo.shortCommit"> · {{ versionInfo.shortCommit }}</span>
        </button>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="main-area">
      <header class="top-bar">
        <div class="top-bar-left">
          <h1 class="page-title">{{ currentPageTitle }}</h1>
          <p class="page-desc">{{ currentPageDesc }}</p>
        </div>
        <div class="top-bar-right">
          <div class="user-menu" @click.stop="toggleUserMenu">
            <div class="user-avatar">{{ currentUser?.email?.[0]?.toUpperCase() || 'U' }}</div>
            <span class="user-name">{{ currentUser?.email || '未登录' }}</span>
            <el-icon><ArrowDown /></el-icon>
          </div>
          <!-- User dropdown -->
          <div v-if="showUserMenu" class="user-dropdown" v-click-outside="closeUserMenu">
            <div class="dropdown-item" @click="goProfile">
              <el-icon><User /></el-icon>个人中心
            </div>
            <div class="dropdown-divider"></div>
            <div class="dropdown-item danger" @click.stop="handleLogout">
              <el-icon><SwitchButton /></el-icon>退出登录
            </div>
          </div>
        </div>
      </header>

      <div class="content-area">
        <ConnectionsPanel v-if="activeTab === 'connections'" />
        <TasksPanel v-if="activeTab === 'tasks'" />
        <LogsPanel v-if="activeTab === 'logs'" />
        <SystemDoctorPanel v-if="activeTab === 'doctor'" />
        <AuthPage v-if="showProfile" @auth-changed="onAuthChanged" />
      </div>
    </main>

    <el-dialog v-model="versionDialogVisible" title="运行版本" width="420px">
      <div class="version-details">
        <div>
          <span>版本</span>
          <strong>v{{ versionInfo.version || '1.0.0' }}</strong>
        </div>
        <div>
          <span>Commit</span>
          <strong>{{ versionInfo.commit || 'unknown' }}</strong>
        </div>
        <div>
          <span>构建时间</span>
          <strong>{{ versionInfo.buildTime || 'unknown' }}</strong>
        </div>
        <div>
          <span>环境</span>
          <strong>{{ versionInfo.nodeEnv || '-' }}</strong>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import ConnectionsPanel from './components/ConnectionsPanel.vue'
import TasksPanel from './components/TasksPanel.vue'
import LogsPanel from './components/LogsPanel.vue'
import SystemDoctorPanel from './components/SystemDoctorPanel.vue'
import AuthPage from './components/AuthPage.vue'
import { getCurrentUser, clearToken, getToken, getVersionInfo, setStoredUser } from './api.js'

const activeTab = ref('tasks')
const isLoggedIn = ref(false)
const currentUser = ref(null)
const showUserMenu = ref(false)
const showProfile = ref(false)
const versionDialogVisible = ref(false)
const versionInfo = ref({ version: '1.0.0', commit: 'unknown', buildTime: 'unknown', nodeEnv: '-' })

const navItems = computed(() => {
  const items = [
    { key: 'connections', icon: 'Link', label: '数据源', badge: null },
    { key: 'tasks', icon: 'RefreshRight', label: '同步任务', badge: null },
    { key: 'logs', icon: 'Terminal', label: '日志', badge: null },
  ]
  if (currentUser.value?.role === 'super_admin') {
    items.push({ key: 'doctor', icon: 'FirstAidKit', label: '系统检查', badge: null })
  }
  return items
})

const currentPageTitle = computed(() => {
  const m = { connections: '数据源管理', tasks: '同步任务', logs: '运行日志', doctor: '系统检查' }
  return m[activeTab.value] || '个人中心'
})
const currentPageDesc = computed(() => {
  const m = {
    connections: '配置数据库与 Teable 实例连接',
    tasks: '管理 SQL → Teable 数据同步管线',
    logs: '实时查看同步执行记录',
    doctor: '检查配置、密钥、任务引用和运行数据目录',
  }
  return m[activeTab.value] || ''
})

// WebSocket for live logs
let ws = null
function connectWS() {
  // 避免重复连接
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    console.log('[WS] Already connected or connecting, skip')
    return
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsPort = import.meta.env.VITE_WS_PORT || location.port || '3101'
  const token = getToken()
  const wsUrl = `${protocol}//${location.hostname}:${wsPort}`
  ws = new WebSocket(wsUrl)
  ws.onopen = () => {
    // 延迟 50ms 确保 readyState 已更新
    setTimeout(() => {
      if (token && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'auth', token }))
      } else {
        console.warn('[WS] Cannot send: token=', !!token, 'readyState=', ws.readyState)
      }
    }, 50)
  }
  ws.onerror = (e) => console.error('[WS] Error:', e)
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === 'sync_log') {
        window.dispatchEvent(new CustomEvent('sync-log', { detail: msg.data }))
      }
    } catch {}
  }
  ws.onclose = () => {
    // Reconnect after 3s if still logged in
    if (isLoggedIn.value) {
      setTimeout(connectWS, 3000)
    }
  }
}

onMounted(async () => {
  try {
    const info = await getVersionInfo()
    versionInfo.value = {
      ...info,
      shortCommit: info.commit && info.commit !== 'unknown' ? info.commit.slice(0, 7) : '',
    }
  } catch {}
  // Check if already logged in
  const token = getToken()
  if (token) {
    try {
      currentUser.value = await getCurrentUser()
      setStoredUser(currentUser.value)
      isLoggedIn.value = true
    } catch {
      clearToken()
      isLoggedIn.value = false
    }
  }
  connectWS()
})

onUnmounted(() => { ws?.close() })

function onAuthChanged(user) {
  if (user) {
    currentUser.value = user
    isLoggedIn.value = true
    showProfile.value = false
    if (!ws || ws.readyState === WebSocket.CLOSED) connectWS()
  } else {
    currentUser.value = null
    isLoggedIn.value = false
    showProfile.value = false
    ws?.close()
  }
  showUserMenu.value = false
}

function goProfile() {
  showProfile.value = true
  showUserMenu.value = false
  activeTab.value = ''
}

function handleLogout() {
  clearToken()
  onAuthChanged(null)
}

function toggleUserMenu() {
  showUserMenu.value = !showUserMenu.value
}

function closeUserMenu() {
  showUserMenu.value = false
}

// Click outside directive
const vClickOutside = {
  mounted(el, binding) {
    el._clickOutside = (e) => {
      if (!el.contains(e.target)) binding.value(e)
    }
    document.addEventListener('click', el._clickOutside)
  },
  unmounted(el) {
    document.removeEventListener('click', el._clickOutside)
  },
}
</script>

<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

/* ========== CSS RESET & VARIABLES ========== */
:root {
  --bg-deep: #ffffff;
  --bg-base: #f5f6fa;
  --bg-surface: #ffffff;
  --bg-elevated: #eef0f5;
  --bg-hover: #e8eaf0;
  --border-subtle: rgba(0,0,0,0.04);
  --border-default: rgba(0,0,0,0.08);
  --border-strong: rgba(0,0,0,0.14);

  --text-primary: #1a1a2e;
  --text-secondary: #5c5d6e;
  --text-tertiary: #9495a0;

  --accent: #6366f1;
  --accent-hover: #818cf8;
  --accent-muted: rgba(99,102,241,0.10);
  --cyan: #0891b2;
  --green: #059669;
  --red: #dc2626;
  --amber: #d97706;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;

  --shadow-sm: 0 1px 3px rgba(0,0,0,0.06);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.08);
  --shadow-lg: 0 8px 32px rgba(0,0,0,0.10);

  --sidebar-w: 232px;

  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif;
  --font-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

html, body { height: 100%; }

body {
  font-family: var(--font-sans);
  background: var(--bg-base);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* ========== LAYOUT ========== */
.app-root {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

/* ========== SIDEBAR ========== */
.sidebar {
  width: var(--sidebar-w);
  background: var(--bg-surface);
  border-right: 1px solid var(--border-default);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  position: relative;
  z-index: 10;
}

.sidebar-brand {
  padding: 24px 20px 20px;
  display: flex;
  align-items: center;
  gap: 14px;
  border-bottom: 1px solid var(--border-subtle);
}

.brand-icon {
  width: 38px; height: 38px;
  background: var(--accent-muted);
  border-radius: var(--radius-md);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.brand-icon svg { width: 22px; height: 22px; }

.brand-text { display: flex; flex-direction: column; }
.brand-name {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
}
.brand-tag {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0;
  color: var(--text-tertiary);
  font-weight: 500;
}

.sidebar-nav {
  flex: 1;
  padding: 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
  font-family: var(--font-sans);
  width: 100%;
  text-align: left;
}
.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.nav-item.active {
  background: var(--accent-muted);
  color: var(--accent-hover);
}
.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  background: var(--accent);
  border-radius: 0 3px 3px 0;
}

.nav-badge {
  margin-left: auto;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
}

.sidebar-footer {
  padding: 16px 20px;
  border-top: 1px solid var(--border-subtle);
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.status-dot {
  width: 7px; height: 7px;
  background: var(--green);
  border-radius: 50%;
}
.status-text {
  font-size: 12px;
  color: var(--text-tertiary);
}
.version {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  border: 0;
  background: transparent;
  padding: 0;
  font-size: 11px;
  color: var(--text-tertiary);
  opacity: 0.65;
  cursor: pointer;
  font-family: var(--font-sans);
}
.version:hover {
  opacity: 1;
  color: var(--text-secondary);
}
.version-details {
  display: grid;
  gap: 12px;
}
.version-details div {
  display: grid;
  gap: 4px;
}
.version-details span {
  font-size: 12px;
  color: var(--text-tertiary);
}
.version-details strong {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-primary);
  word-break: break-all;
}

/* ========== MAIN AREA ========== */
.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-base);
}

.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 32px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-surface);
  flex-shrink: 0;
}

.top-bar-left {}

.page-title {
  font-size: 21px;
  font-weight: 700;
  color: var(--text-primary);
}
.page-desc {
  font-size: 13px;
  color: var(--text-tertiary);
  margin-top: 3px;
}

.top-bar-right {
  display: flex;
  align-items: center;
  gap: 16px;
  position: relative;
  overflow: visible;
}

/* User menu */
.user-menu {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.15s;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  user-select: none;
}
.user-menu:hover { background: var(--bg-hover); border-color: var(--border-strong); }
.user-avatar {
  width: 28px; height: 28px;
  background: linear-gradient(135deg, #6366f1, #06b6d4);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
}
.user-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

/* User dropdown */
.user-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  min-width: 160px;
  z-index: 100;
  overflow: hidden;
}
.dropdown-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 16px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}
.dropdown-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.dropdown-item.danger { color: var(--red); }
.dropdown-item.danger:hover { background: rgba(220,38,38,0.06); }
.dropdown-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: 4px 0;
}

.content-area {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}

/* ========== GLOBAL CARD STYLE ========== */
.fs-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 24px;
  transition: all 0.2s ease;
}
.fs-card:hover { border-color: var(--border-strong); }

/* ========== BUTTONS ========== */
.fs-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 14px;
  font-weight: 600;
  font-family: var(--font-sans);
  cursor: pointer;
  transition: all 0.15s ease;
}
.fs-btn-primary {
  background: var(--accent);
  color: #fff;
}
.fs-btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(99,102,241,0.3); }

.fs-btn-ghost {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
}
.fs-btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); border-color: var(--border-strong); }

.fs-btn-danger {
  background: transparent;
  color: var(--red);
  border: 1px solid rgba(220,38,38,0.2);
}
.fs-btn-danger:hover { background: rgba(220,38,38,0.06); border-color: rgba(220,38,38,0.35); }

/* Element Plus overrides */
.el-table th.el-table__cell { font-weight: 600 !important; font-size: 12px !important; }
.el-dialog__header { border-bottom: 1px solid var(--border-subtle) !important; padding: 20px 24px !important; }
.el-dialog__title { color: var(--text-primary) !important; font-weight: 600 !important; }
.el-dialog__body { color: var(--text-secondary) !important; padding: 24px !important; }
.el-dialog__footer { border-top: 1px solid var(--border-subtle) !important; padding: 16px 24px !important; }
.el-form-item__label { color: var(--text-secondary) !important; font-weight: 500 !important; }
.el-overlay { background-color: rgba(0,0,0,0.4) !important; }
.el-scrollbar__bar { opacity: 0.3; }

.sidebar-context {
  display: grid;
  gap: 12px;
  padding: 14px 16px;
  margin: 0 12px 12px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
}
.sidebar-context div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.context-label {
  font-size: 11px;
  color: var(--text-tertiary);
}
.sidebar-context strong,
.context-link {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}
.context-link {
  border: 0;
  background: transparent;
  cursor: pointer;
  font-family: var(--font-sans);
}
.context-link:hover { color: var(--accent); }

/* Scrollbar */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.20); }

@media (max-width: 900px) {
  .app-root { flex-direction: column; }
  .sidebar {
    width: 100%;
    height: auto;
    border-right: 0;
    border-bottom: 1px solid var(--border-default);
  }
  .sidebar-brand { padding: 14px 18px; }
  .sidebar-nav {
    flex-direction: row;
    overflow-x: auto;
    padding: 10px 12px;
  }
  .nav-item {
    width: auto;
    white-space: nowrap;
  }
  .sidebar-context,
  .sidebar-footer { display: none; }
  .top-bar {
    padding: 14px 18px;
    align-items: flex-start;
    gap: 12px;
  }
  .user-name { display: none; }
  .content-area { padding: 18px; }
}
</style>

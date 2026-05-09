import axios from 'axios'

const TOKEN_KEY = 'teable_sync_token'
const USER_KEY = 'user'

// 动态获取 API 地址：支持局域网访问
// 如果从 192.168.x.x 访问，API 也走 192.168.x.x
const getBaseURL = () => {
  const { protocol, hostname, port } = window.location
  return `${protocol}//${hostname}${port ? ':' + port : ''}/api`
}

const api = axios.create({
  baseURL: getBaseURL(),
  timeout: 30000,
})

api.interceptors.request.use(config => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
      window.location.hash = '#/login'
    }
    if (err.response?.data?.error) {
      err.message = err.response.data.error
    }
    if (err.response?.data?.preflight) {
      err.preflight = err.response.data.preflight
    }
    return Promise.reject(err)
  }
)

// Auth
export const login = (data) => api.post('/auth/login', data).then(r => r.data)
export const register = (data) => api.post('/auth/register', data).then(r => r.data)
export const getCurrentUser = () => api.get('/auth/me').then(r => r.data)
export const changePassword = (data) => api.put('/auth/password', data).then(r => r.data)
export const exchangeTeableLoginCode = (code) => api.post('/auth/teable-token-exchange', { code }).then(r => r.data)
export const getUsers = () => api.get('/auth/users').then(r => r.data)
export const deleteUser = (id) => api.delete(`/auth/users/${id}`).then(r => r.data)
export const updateUserRole = (id, role) => api.put(`/auth/users/${id}/role`, { role }).then(r => r.data)
export const setToken = (token, user = null) => {
  localStorage.setItem(TOKEN_KEY, token)
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user))
}
export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const getStoredUser = () => {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null')
  } catch {
    return null
  }
}
export const setStoredUser = (user) => {
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user))
}
export const clearToken = () => {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

// Connections
export const getConnections = () => api.get('/connections').then(r => r.data)
export const createConnection = (data) => api.post('/connections', data).then(r => r.data)
export const updateConnection = (id, data) => api.put(`/connections/${id}`, data).then(r => r.data)
export const deleteConnection = (id) => api.delete(`/connections/${id}`).then(r => r.data)
export const testConnection = (id) => api.post(`/connections/${id}/test`).then(r => r.data)
export const getTables = (id, database) => api.get(`/connections/${id}/tables`, { params: database ? { database } : {} }).then(r => r.data)
export const getWatermarkCandidates = (id, table, database) => api.get(`/connections/${id}/watermark-candidates`, { params: { table, ...(database ? { database } : {}) } }).then(r => r.data)
export const getMappingSuggestions = (sourceConnectionId, sourceTable, targetTableId, targetConnectionId, sourceDatabase) => api.get('/mapping-suggestions', { params: { sourceConnectionId, sourceTable, targetTableId, targetConnectionId, ...(sourceDatabase ? { sourceDatabase } : {}) } }).then(r => r.data)

// Teable
export const testTeable = (data) => api.post('/teable/test', data).then(r => r.data)
export const getTeableSpaces = (connectionId) => api.get('/teable/spaces', { params: { connectionId } }).then(r => r.data)
export const getTeableBases = (connectionId, spaceId) => api.get('/teable/bases', { params: { connectionId, spaceId } }).then(r => r.data)
export const getTeableTables = (baseId, connectionId) => api.get(`/teable/bases/${baseId}/tables`, { params: { connectionId } }).then(r => r.data)
export const getTeableFields = (tableId, connectionId) => api.get(`/teable/tables/${tableId}/fields`, { params: { connectionId } }).then(r => r.data)

// Tasks
export const getTasks = () => api.get('/tasks').then(r => r.data)
export const previewTaskData = (id, limit = 10) => api.get(`/tasks/${id}/preview`, { params: { limit } }).then(r => r.data)
export const createTask = (data) => api.post('/tasks', data).then(r => r.data)
export const updateTask = (id, data) => api.put(`/tasks/${id}`, data).then(r => r.data)
export const deleteTask = (id) => api.delete(`/tasks/${id}`).then(r => r.data)
export const copyTask = (id, data = {}) => api.post(`/tasks/${id}/copy`, data).then(r => r.data)
export const getTaskTemplates = () => api.get('/task-templates').then(r => r.data)
export const createTaskTemplate = (data) => api.post('/task-templates', data).then(r => r.data)
export const createTaskFromTemplate = (id, data = {}) => api.post(`/task-templates/${id}/create-task`, data).then(r => r.data)
export const deleteTaskTemplate = (id) => api.delete(`/task-templates/${id}`).then(r => r.data)
export const runTask = (id, options = {}) => api.post(`/tasks/${id}/run`, options).then(r => r.data)
export const continueInitialSync = (id) => api.post(`/tasks/${id}/run`, { initializationMode: true }).then(r => r.data)
export const startTask = (id) => api.post(`/tasks/${id}/start`).then(r => r.data)
export const stopTask = (id) => api.post(`/tasks/${id}/stop`).then(r => r.data)
export const cancelTask = (id) => api.post(`/tasks/${id}/cancel`).then(r => r.data)
export const getTaskProgress = (id) => api.get(`/tasks/${id}/progress`).then(r => r.data)
export const getTaskInitialization = (id) => api.get(`/tasks/${id}/initialization`).then(r => r.data)
export const getFailureCounts = () => api.get('/sync-failures/counts').then(r => r.data)
export const getTaskFailures = (id) => api.get(`/tasks/${id}/failures`).then(r => r.data)
export const retryTaskFailures = (id) => api.post(`/tasks/${id}/retry-failures`).then(r => r.data)
export const retryTaskFailure = (id, failureId) => api.post(`/tasks/${id}/failures/${failureId}/retry`).then(r => r.data)
export const clearTaskFailures = (id) => api.delete(`/tasks/${id}/failures`).then(r => r.data)
export const getTasksHealth = () => api.get('/tasks-health').then(r => r.data)
export const getTaskHealth = (id) => api.get(`/tasks/${id}/health`).then(r => r.data)
export const reconcileTask = (id, options = {}) => api.post(`/tasks/${id}/reconcile`, options).then(r => r.data)
export const preflightTask = (id) => api.post(`/tasks/${id}/preflight`).then(r => r.data)
export const getTaskSchemaDrift = (id) => api.get(`/tasks/${id}/schema-drift`).then(r => r.data)
export const refreshTaskSchemaSnapshot = (id) => api.post(`/tasks/${id}/schema-snapshot`).then(r => r.data)
export const getSchedulerStatus = () => api.get('/scheduler/status').then(r => r.data)

// Logs
export const getLogs = (params = {}) => api.get('/logs', { params }).then(r => r.data)
export const getSyncHistory = (params = {}) => api.get('/sync-history', { params }).then(r => r.data)
export const clearLogs = () => api.delete('/logs').then(r => r.data)
export const getAuditLogs = (params = {}) => api.get('/audit-logs', { params }).then(r => r.data)
export const getObservability = () => api.get('/observability').then(r => r.data)
export const acknowledgeAlert = (id) => api.post(`/observability/alerts/${encodeURIComponent(id)}/ack`).then(r => r.data)
export const muteAlert = (id, minutes = 60) => api.post(`/observability/alerts/${encodeURIComponent(id)}/mute`, { minutes }).then(r => r.data)
export const restoreAlert = (id) => api.post(`/observability/alerts/${encodeURIComponent(id)}/restore`).then(r => r.data)
export const getAlertNotificationSettings = () => api.get('/alert-notifications').then(r => r.data)
export const updateAlertNotificationSettings = (data) => api.put('/alert-notifications', data).then(r => r.data)
export const testAlertNotification = () => api.post('/alert-notifications/test').then(r => r.data)

// System
export const getVersionInfo = () => api.get('/version').then(r => r.data)
export const getSystemDoctor = () => api.get('/system/doctor').then(r => r.data)
export const getConfigBackups = (params = {}) => api.get('/system/config-backups', { params }).then(r => r.data)
export const exportConfigPackage = (params = {}) => api.get('/system/config-export', { params }).then(r => r.data)
export const previewConfigImport = (data) => api.post('/system/config-import/preview', data).then(r => r.data)
export const importConfigPackage = (data, params = {}) => api.post('/system/config-import', data, { params }).then(r => r.data)

export default api

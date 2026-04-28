import axios from 'axios'

const TOKEN_KEY = 'teable_sync_token'

// 动态获取 API 地址：支持局域网访问
// 如果从 192.168.x.x 访问，API 也走 192.168.x.x
const getBaseURL = () => {
  const { protocol, hostname } = window.location
  return `${protocol}//${hostname}:3100/api`
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
      window.location.hash = '#/login'
    }
    return Promise.reject(err)
  }
)

// Auth
export const login = (data) => api.post('/api/auth/login', data).then(r => r.data)
export const register = (data) => api.post('/api/auth/register', data).then(r => r.data)
export const getCurrentUser = () => api.get('/api/auth/me').then(r => r.data)
export const changePassword = (data) => api.put('/api/auth/password', data).then(r => r.data)
export const getUsers = () => api.get('/api/auth/users').then(r => r.data)
export const deleteUser = (id) => api.delete(`/api/auth/users/${id}`).then(r => r.data)
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token)
export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

// Connections
export const getConnections = () => api.get('/api/connections').then(r => r.data)
export const createConnection = (data) => api.post('/api/connections', data).then(r => r.data)
export const updateConnection = (id, data) => api.put(`/api/connections/${id}`, data).then(r => r.data)
export const deleteConnection = (id) => api.delete(`/api/connections/${id}`).then(r => r.data)
export const testConnection = (id) => api.post(`/api/connections/${id}/test`).then(r => r.data)
export const getTables = (id, database) => api.get(`/api/connections/${id}/tables`, { params: database ? { database } : {} }).then(r => r.data)

// Teable
export const testTeable = (data) => api.post('/api/teable/test', data).then(r => r.data)
export const getTeableSpaces = (connectionId) => api.get('/api/teable/spaces', { params: { connectionId } }).then(r => r.data)
export const getTeableBases = (connectionId, spaceId) => api.get('/api/teable/bases', { params: { connectionId, spaceId } }).then(r => r.data)
export const getTeableTables = (baseId, connectionId) => api.get(`/api/teable/bases/${baseId}/tables`, { params: { connectionId } }).then(r => r.data)
export const getTeableFields = (tableId, connectionId) => api.get(`/api/teable/tables/${tableId}/fields`, { params: { connectionId } }).then(r => r.data)

// Tasks
export const getTasks = () => api.get('/api/tasks').then(r => r.data)
export const createTask = (data) => api.post('/api/tasks', data).then(r => r.data)
export const updateTask = (id, data) => api.put(`/api/tasks/${id}`, data).then(r => r.data)
export const deleteTask = (id) => api.delete(`/api/tasks/${id}`).then(r => r.data)
export const runTask = (id) => api.post(`/api/tasks/${id}/run`).then(r => r.data)
export const startTask = (id) => api.post(`/api/tasks/${id}/start`).then(r => r.data)
export const stopTask = (id) => api.post(`/api/tasks/${id}/stop`).then(r => r.data)
export const getSchedulerStatus = () => api.get('/api/scheduler/status').then(r => r.data)

// Logs
export const getLogs = () => api.get('/api/logs').then(r => r.data)
export const clearLogs = () => api.delete('/api/logs').then(r => r.data)

export default api

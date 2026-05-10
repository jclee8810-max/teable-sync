#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { signToken } from '../src/middleware/auth.js';

const API_BASE = (process.env.API_CONTRACT_BASE || 'http://127.0.0.1:3101/api').replace(/\/+$/, '');
const CONFIG_FILE = process.env.API_CONTRACT_CONFIG_FILE || './data/config.json';
const USERS_FILE = process.env.API_CONTRACT_USERS_FILE || './data/users.json';
const HISTORY_FILE = process.env.API_CONTRACT_HISTORY_FILE || './data/sync-history.json';
const FAILURES_FILE = process.env.API_CONTRACT_FAILURES_FILE || './data/sync-failures.json';
const STATE_DIR = process.env.API_CONTRACT_STATE_DIR || './data/sync-state';
const STATE_FILE = `${STATE_DIR}/legacy-task.json`;
const backupStamp = Date.now();
const configBackupFile = `${CONFIG_FILE}.api-contract-${backupStamp}`;
const usersBackupFile = `${USERS_FILE}.api-contract-${backupStamp}`;
const historyBackupFile = `${HISTORY_FILE}.api-contract-${backupStamp}`;
const failuresBackupFile = `${FAILURES_FILE}.api-contract-${backupStamp}`;
const stateBackupFile = `${STATE_FILE}.api-contract-${backupStamp}`;
const checks = [];

function record(ok, name, detail = '') {
  checks.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
}

async function request(path, options = {}, token = null) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

function tokenFor(user) {
  return signToken({ id: user.id, email: user.email, role: user.role });
}

const now = new Date().toISOString();
const owner = { id: 'contract-owner', email: 'contract-owner@test.local', role: 'owner', passwordHash: 'x', createdAt: now };
const admin = { id: 'contract-admin', email: 'contract-admin@test.local', role: 'super_admin', passwordHash: 'x', createdAt: now };
const user = { id: 'contract-user', email: 'contract-user@test.local', role: 'user', passwordHash: 'x', createdAt: now };
const roleTarget = { id: 'contract-role-target', email: 'contract-role-target@test.local', role: 'user', passwordHash: 'x', createdAt: now };
const ownerToken = tokenFor(owner);
const adminToken = tokenFor(admin);
const userToken = tokenFor(user);

const readySource = { id: 'ready-src', name: 'Ready SQL', type: 'mssql', host: 'sql.local', database: 'db', username: 'u', password: 'secret', ownerId: owner.id, shared: true, createdAt: now, lastTest: { success: true, testedAt: now } };
const readyTarget = { id: 'ready-tgt', name: 'Ready Teable', type: 'teable', host: 'http://teable.local', token: 'teable-secret', ownerId: owner.id, shared: true, createdAt: now, lastTest: { success: true, testedAt: now } };
const untestedSource = { id: 'untested-src', name: 'Untested SQL', type: 'mssql', host: 'sql.local', database: 'db', ownerId: owner.id, shared: true, createdAt: now };
const failedSource = { id: 'failed-src', name: 'Failed SQL', type: 'mssql', host: 'sql.local', database: 'db', ownerId: owner.id, shared: true, createdAt: now, lastTest: { success: false, testedAt: now, error: 'bad password' } };
const untestedTarget = { id: 'untested-tgt', name: 'Untested Teable', type: 'teable', host: 'http://teable.local', token: 'teable-secret', ownerId: owner.id, shared: true, createdAt: now };
const legacyTask = {
  id: 'legacy-task',
  name: 'Legacy Task',
  sourceConnectionId: untestedSource.id,
  sourceTable: 'Orders',
  targetConnectionId: readyTarget.id,
  targetTableId: 'tbl',
  columnMapping: { id: 'Name' },
  sourcePrimaryKey: 'id',
  syncMode: 'manual',
  syncDirection: 'one_way',
  conflictStrategy: 'upsert',
  userId: owner.id,
  createdAt: now,
  status: 'idle',
  enabled: false,
};
const baseTask = {
  name: 'Contract Task',
  sourceConnectionId: readySource.id,
  sourceTable: 'Orders',
  targetConnectionId: readyTarget.id,
  targetTableId: 'tbl',
  columnMapping: { id: 'Name' },
  sourcePrimaryKey: 'id',
  syncMode: 'manual',
  syncDirection: 'one_way',
  conflictStrategy: 'upsert',
};

try {
  if (existsSync(CONFIG_FILE)) writeFileSync(configBackupFile, readFileSync(CONFIG_FILE));
  if (existsSync(USERS_FILE)) writeFileSync(usersBackupFile, readFileSync(USERS_FILE));
  if (existsSync(HISTORY_FILE)) writeFileSync(historyBackupFile, readFileSync(HISTORY_FILE));
  if (existsSync(FAILURES_FILE)) writeFileSync(failuresBackupFile, readFileSync(FAILURES_FILE));
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(STATE_FILE)) writeFileSync(stateBackupFile, readFileSync(STATE_FILE));
  writeFileSync(USERS_FILE, JSON.stringify([owner, admin, user, roleTarget], null, 2));
  writeFileSync(CONFIG_FILE, JSON.stringify({
    connections: [readySource, readyTarget, untestedSource, failedSource, untestedTarget],
    syncTasks: [legacyTask],
    taskTemplates: [{ id: 'tpl-untested', name: 'Untested Template', userId: owner.id, config: { ...baseTask, sourceConnectionId: untestedSource.id } }],
    syncLogs: [],
    alertNotifications: { enabled: false, webhookUrl: 'https://example.invalid/hook', cooldownMinutes: 10 },
    alertStates: {},
  }, null, 2));

  writeFileSync(HISTORY_FILE, JSON.stringify([{
    id: 'contract-run-001',
    runId: 'contract-run-001',
    taskId: legacyTask.id,
    taskName: legacyTask.name,
    sourceTable: legacyTask.sourceTable,
    targetTableId: legacyTask.targetTableId,
    trigger: 'manual',
    startTime: now,
    endTime: now,
    status: 'success',
    mode: 'full',
    sourceRows: 42,
    inserted: 40,
    updated: 2,
    skipped: 0,
    deleted: 0,
    softDeleted: 0,
    failed: 0,
    errorMessage: null,
    durationMs: 1234,
  }], null, 2));
  writeFileSync(FAILURES_FILE, JSON.stringify([{
    id: 'contract-failure-001',
    taskId: legacyTask.id,
    taskName: legacyTask.name,
    runId: 'contract-run-001',
    batchNo: 2,
    writeBatchNo: 1,
    operation: 'insert',
    tableId: legacyTask.targetTableId,
    records: [{ fields: { Name: 'A001', Amount: 10 } }],
    recordIds: null,
    primaryKeys: ['A001'],
    pkFieldName: 'Name',
    sourceRange: { start: 501, end: 1000, count: 500 },
    sourceOffset: 500,
    sourceCursorBefore: '500',
    sourceCursorAfter: '1000',
    count: 1,
    errorMessage: 'simulated failure',
    createdAt: now,
    retryCount: 0,
    lastRetryAt: null,
  }], null, 2));
  writeFileSync(STATE_FILE, JSON.stringify({
    lastSyncAt: null,
    watermark: null,
    syncedIds: [],
    lastRunAt: now,
    watermarkType: 'full_scan',
    watermarkColumn: null,
    checkpoint: {
      runId: 'contract-run-001',
      taskId: legacyTask.id,
      taskName: legacyTask.name,
      mode: 'full',
      watermarkType: 'full_scan',
      watermarkColumn: null,
      batchNo: 2,
      sourceKind: 'sql',
      sourceOffset: 1000,
      sourceCursor: null,
      sourceRange: { start: 501, end: 1000, count: 500 },
      processedRows: 1000,
      inserted: 900,
      updated: 80,
      skipped: 20,
      failed: 0,
      savedAt: now,
    },
    checkpoints: [],
  }, null, 2));

  let res = await request('/auth/users', {}, userToken);
  record(res.status === 403, 'regular user cannot list users');
  res = await request('/auth/users', {}, adminToken);
  record(res.status === 200, 'admin can list users');
  res = await request(`/auth/users/${roleTarget.id}/role`, { method: 'PUT', body: JSON.stringify({ role: 'super_admin' }) }, adminToken);
  record(res.status === 403, 'admin cannot promote users');
  res = await request(`/auth/users/${roleTarget.id}/role`, { method: 'PUT', body: JSON.stringify({ role: 'super_admin' }) }, ownerToken);
  record(res.status === 200 && res.data.role === 'super_admin', 'owner can promote users');

  res = await request('/connections', {}, userToken);
  const serializedConnections = JSON.stringify(res.data);
  record(res.status === 200 && !serializedConnections.includes('secret') && !serializedConnections.includes('"password"') && !serializedConnections.includes('"token"'), 'connection list is sanitized');

  res = await request('/system/config-export?includeSecrets=false', {}, adminToken);
  const safeExport = JSON.stringify(res.data);
  record(res.status === 200 && !safeExport.includes('secret'), 'admin can export sanitized config');
  res = await request('/system/config-export?includeSecrets=true', {}, adminToken);
  record(res.status === 403, 'admin cannot export secret config');
  res = await request('/system/config-export?includeSecrets=true', {}, ownerToken);
  const secretExport = JSON.stringify(res.data);
  record(res.status === 200 && secretExport.includes('secret'), 'owner can export secret config');

  res = await request('/tasks', { method: 'POST', body: JSON.stringify({ ...baseTask, sourceConnectionId: untestedSource.id }) }, ownerToken);
  record(res.status === 400 && /尚未测试通过/.test(res.data?.error || ''), 'task create rejects untested source');
  res = await request('/tasks', { method: 'POST', body: JSON.stringify({ ...baseTask, sourceConnectionId: failedSource.id }) }, ownerToken);
  record(res.status === 400 && /最近测试失败/.test(res.data?.error || ''), 'task create rejects failed source');
  res = await request('/tasks', { method: 'POST', body: JSON.stringify({ ...baseTask, targetConnectionId: untestedTarget.id }) }, ownerToken);
  record(res.status === 400 && /尚未测试通过/.test(res.data?.error || ''), 'task create rejects untested target');
  res = await request('/tasks', { method: 'POST', body: JSON.stringify(baseTask) }, ownerToken);
  record(res.status === 200 && res.data.id, 'task create accepts tested connections');

  res = await request('/tasks/legacy-task', { method: 'PUT', body: JSON.stringify({ name: 'Legacy Renamed' }) }, ownerToken);
  record(res.status === 200 && res.data.name === 'Legacy Renamed', 'legacy task allows non-connection edit');
  res = await request('/tasks/legacy-task', { method: 'PUT', body: JSON.stringify({ sourceConnectionId: untestedSource.id }) }, ownerToken);
  record(res.status === 400 && /尚未测试通过/.test(res.data?.error || ''), 'legacy task rejects connection edit');
  res = await request('/tasks/legacy-task/run', { method: 'POST', body: JSON.stringify({}) }, ownerToken);
  record(res.status === 400 && /尚未测试通过/.test(res.data?.error || ''), 'run rejects untested connection');
  res = await request('/tasks/legacy-task/copy', { method: 'POST', body: JSON.stringify({}) }, ownerToken);
  record(res.status === 400 && /尚未测试通过/.test(res.data?.error || ''), 'copy rejects untested connection');
  res = await request('/task-templates/tpl-untested/create-task', { method: 'POST', body: JSON.stringify({}) }, ownerToken);
  record(res.status === 400 && /尚未测试通过/.test(res.data?.error || ''), 'template create rejects untested connection');

  res = await request('/tasks/legacy-task/initialization', {}, ownerToken);
  record(res.status === 200 && res.data.hasCheckpoint === true && res.data.checkpoint?.processedRows === 1000, 'initialization endpoint exposes checkpoint');
  record(res.data.runState?.initializationQueue?.concurrency >= 1 && typeof res.data.runState.initializationQueue.queueLength === 'number', 'initialization endpoint exposes queue metadata');
  res = await request('/tasks/legacy-task/failures', {}, ownerToken);
  const failure = res.data?.[0];
  record(res.status === 200 && failure?.id === 'contract-failure-001' && failure.hasPayload === true, 'failure list exposes batch summary');
  record(!JSON.stringify(res.data).includes('"records"') && !JSON.stringify(res.data).includes('"recordIds"'), 'failure list hides replay payload');
  res = await request('/tasks/legacy-task/failures/contract-failure-001/retry', { method: 'POST', body: JSON.stringify({}) }, ownerToken);
  record(res.status === 400 && /尚未测试通过/.test(res.data?.error || ''), 'single failure replay rejects untested connection');
  res = await request('/tasks/legacy-task/retry-failures', { method: 'POST', body: JSON.stringify({}) }, ownerToken);
  record(res.status === 400 && /尚未测试通过/.test(res.data?.error || ''), 'all failure replay rejects untested connection');

  res = await request('/sync-history?taskId=legacy-task&limit=5', {}, ownerToken);
  const run = res.data?.[0];
  record(res.status === 200 && run?.runId === 'contract-run-001', 'sync history exposes run id');
  record(run?.trigger === 'manual' && run?.sourceRows === 42 && run?.inserted === 40 && run?.updated === 2 && run?.durationMs === 1234, 'sync history exposes run metrics');


  res = await request('/observability', {}, ownerToken);
  record(res.status === 200 && res.data.summary && Array.isArray(res.data.alerts), 'observability snapshot loads');
  const targetAlert = res.data.alerts?.[0];
  record(Boolean(targetAlert?.id), 'observability exposes alert ids');
  res = await request(`/observability/alerts/${encodeURIComponent(targetAlert.id)}/ack`, { method: 'POST', body: JSON.stringify({}) }, ownerToken);
  record(res.status === 200, 'alert can be acknowledged');
  res = await request('/observability', {}, ownerToken);
  record(res.data.alerts.find((item) => item.id === targetAlert.id)?.state === 'acknowledged', 'acknowledged alert state is visible');
  res = await request(`/observability/alerts/${encodeURIComponent(targetAlert.id)}/mute`, { method: 'POST', body: JSON.stringify({ minutes: 30 }) }, ownerToken);
  record(res.status === 200 && res.data.mutedUntil, 'alert can be muted');
  res = await request('/observability', {}, ownerToken);
  record(res.data.alerts.find((item) => item.id === targetAlert.id)?.state === 'muted', 'muted alert state is visible');
  res = await request(`/observability/alerts/${encodeURIComponent(targetAlert.id)}/restore`, { method: 'POST', body: JSON.stringify({}) }, ownerToken);
  record(res.status === 200, 'alert state can be restored');
  res = await request('/observability', {}, ownerToken);
  record(res.data.alerts.find((item) => item.id === targetAlert.id)?.state === 'open', 'restored alert returns to open');

  console.log(`\nAPI contract smoke: PASS (${checks.length}/${checks.length})`);
} finally {
  if (existsSync(configBackupFile)) renameSync(configBackupFile, CONFIG_FILE);
  else if (existsSync(CONFIG_FILE)) unlinkSync(CONFIG_FILE);
  if (existsSync(usersBackupFile)) renameSync(usersBackupFile, USERS_FILE);
  else if (existsSync(USERS_FILE)) unlinkSync(USERS_FILE);
  if (existsSync(historyBackupFile)) renameSync(historyBackupFile, HISTORY_FILE);
  else if (existsSync(HISTORY_FILE)) unlinkSync(HISTORY_FILE);
  if (existsSync(failuresBackupFile)) renameSync(failuresBackupFile, FAILURES_FILE);
  else if (existsSync(FAILURES_FILE)) unlinkSync(FAILURES_FILE);
  if (existsSync(stateBackupFile)) renameSync(stateBackupFile, STATE_FILE);
  else if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
}

#!/usr/bin/env node
import bcrypt from 'bcryptjs';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.RUNTIME_STORE_DATA_DIR || join(__dirname, '..', 'data');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const USERS_FILE = join(DATA_DIR, 'users.json');
const DB_FILE = process.env.RUNTIME_SQLITE_FILE || join(DATA_DIR, 'runtime.sqlite');
const SQLITE_BIN = process.env.SQLITE_BIN || 'sqlite3';
const PREFIX = 'ui-e2e-';
const now = new Date().toISOString();

const user = {
  id: `${PREFIX}owner`,
  email: 'ui-e2e-owner@test.local',
  password: 'ui-e2e-pass',
  role: 'owner',
};

const readySource = {
  id: `${PREFIX}ready-src`,
  name: 'UI E2E Ready SQL',
  type: 'mssql',
  host: 'sql.local',
  database: 'db',
  username: 'ui',
  password: 'ui-e2e-secret',
  ownerId: user.id,
  shared: true,
  createdAt: now,
  lastTest: { success: true, testedAt: now, message: 'UI fixture' },
};
const readyTarget = {
  id: `${PREFIX}ready-tgt`,
  name: 'UI E2E Ready Teable',
  type: 'teable',
  host: 'http://teable.local',
  token: 'ui-e2e-token',
  ownerId: user.id,
  shared: true,
  createdAt: now,
  lastTest: { success: true, testedAt: now, message: 'UI fixture' },
};
const untestedSource = {
  id: `${PREFIX}untested-src`,
  name: 'UI E2E Untested SQL',
  type: 'mssql',
  host: 'sql.local',
  database: 'db',
  ownerId: user.id,
  shared: true,
  createdAt: now,
};
const failedSource = {
  id: `${PREFIX}failed-src`,
  name: 'UI E2E Failed SQL',
  type: 'mssql',
  host: 'sql.local',
  database: 'db',
  ownerId: user.id,
  shared: true,
  createdAt: now,
  lastTest: { success: false, testedAt: now, error: 'UI fixture bad password' },
};

const failureTask = {
  id: `${PREFIX}failure-task`,
  name: 'UI E2E Failure Guidance',
  sourceConnectionId: readySource.id,
  sourceTable: 'Orders',
  targetConnectionId: readyTarget.id,
  targetTableId: 'tbl-ui-e2e',
  columnMapping: { id: 'Name' },
  sourcePrimaryKey: 'id',
  syncMode: 'manual',
  syncDirection: 'one_way',
  conflictStrategy: 'upsert',
  userId: user.id,
  createdAt: now,
  status: 'error',
  enabled: false,
};
const realtimeTask = {
  ...failureTask,
  id: `${PREFIX}realtime-task`,
  name: 'UI E2E Realtime Disabled Run',
  syncMode: 'realtime',
  syncInterval: 10,
  status: 'scheduled',
  enabled: true,
};

const failedHistory = {
  id: `${PREFIX}run-001`,
  runId: `${PREFIX}run-001`,
  taskId: failureTask.id,
  taskName: failureTask.name,
  sourceTable: failureTask.sourceTable,
  targetTableId: failureTask.targetTableId,
  trigger: 'manual',
  startTime: now,
  endTime: now,
  status: 'failed',
  mode: 'full',
  sourceRows: 1000,
  inserted: 0,
  updated: 0,
  skipped: 0,
  deleted: 0,
  softDeleted: 0,
  failed: 1,
  errorMessage: 'failed batch replay still failing',
  errorType: 'failure_batch',
  errorSummary: '存在可重放的失败批次',
  suggestedAction: '打开失败批次页面，先重试单批；确认无效数据后再清理记录。',
  actionTarget: 'task_failures',
  durationMs: 1200,
};
const failedBatch = {
  id: `${PREFIX}failure-001`,
  taskId: failureTask.id,
  taskName: failureTask.name,
  runId: failedHistory.runId,
  batchNo: 1,
  writeBatchNo: 1,
  operation: 'insert',
  tableId: failureTask.targetTableId,
  records: [{ fields: { Name: 'UI-001' } }],
  recordIds: null,
  primaryKeys: ['UI-001'],
  pkFieldName: 'Name',
  sourceRange: { start: 1, end: 1, count: 1 },
  count: 1,
  errorMessage: 'UI fixture failed batch',
  createdAt: now,
  retryCount: 0,
  lastRetryAt: null,
};

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

function isUiE2e(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function cleanConfig(config) {
  return {
    ...config,
    connections: (config.connections || []).filter((item) => !isUiE2e(item.id)),
    syncTasks: (config.syncTasks || []).filter((item) => !isUiE2e(item.id)),
    taskTemplates: (config.taskTemplates || []).filter((item) => !isUiE2e(item.id)),
    syncLogs: (config.syncLogs || []).filter((item) => !isUiE2e(item.taskId)),
    alertStates: Object.fromEntries(Object.entries(config.alertStates || {}).filter(([key]) => !key.includes(PREFIX))),
  };
}

function cleanupRuntimeStore() {
  if (!existsSync(DB_FILE)) return;
  const sql = `
DELETE FROM sync_history WHERE id LIKE '${PREFIX}%' OR task_id LIKE '${PREFIX}%';
DELETE FROM sync_failures WHERE id LIKE '${PREFIX}%' OR task_id LIKE '${PREFIX}%';
DELETE FROM audit_logs WHERE id LIKE '${PREFIX}%' OR user_id LIKE '${PREFIX}%';
`;
  spawnSync(SQLITE_BIN, [DB_FILE], { input: sql, encoding: 'utf8' });
}

async function setup() {
  cleanupRuntimeStore();
  const users = readJson(USERS_FILE, []).filter((item) => !isUiE2e(item.id) && item.email !== user.email);
  users.push({
    id: user.id,
    email: user.email,
    passwordHash: await bcrypt.hash(user.password, 10),
    role: user.role,
    createdAt: now,
  });
  writeJson(USERS_FILE, users);

  const config = cleanConfig(readJson(CONFIG_FILE, {
    connections: [],
    syncTasks: [],
    syncLogs: [],
    taskTemplates: [],
    alertNotifications: {},
    alertStates: {},
  }));
  config.connections.push(readySource, readyTarget, untestedSource, failedSource);
  config.syncTasks.push(failureTask, realtimeTask);
  config.syncLogs.push({
    taskId: failureTask.id,
    userId: user.id,
    level: 'error',
    message: failedHistory.errorMessage,
    ts: now,
  });
  writeJson(CONFIG_FILE, config);

  const { insertSyncHistoryRecord } = await import('../src/services/runtimeStore.js');
  const { insertSyncFailureRecord } = await import('../src/services/runtimeStore.js');
  insertSyncHistoryRecord(failedHistory);
  insertSyncFailureRecord(failedBatch);

  console.log(JSON.stringify({
    ok: true,
    user: { email: user.email, password: user.password },
    taskIds: { failure: failureTask.id, realtime: realtimeTask.id },
  }));
}

function cleanup() {
  const users = readJson(USERS_FILE, []).filter((item) => !isUiE2e(item.id) && item.email !== user.email);
  writeJson(USERS_FILE, users);
  writeJson(CONFIG_FILE, cleanConfig(readJson(CONFIG_FILE, {
    connections: [],
    syncTasks: [],
    syncLogs: [],
    taskTemplates: [],
    alertNotifications: {},
    alertStates: {},
  })));
  cleanupRuntimeStore();
  console.log(JSON.stringify({ ok: true, cleaned: true }));
}

const command = process.argv[2] || 'setup';
if (command === 'setup') await setup();
else if (command === 'cleanup') cleanup();
else {
  console.error('Usage: ui-e2e-fixture.mjs setup|cleanup');
  process.exit(2);
}

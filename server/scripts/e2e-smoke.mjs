#!/usr/bin/env node
import fs from 'fs';
import process from 'process';
import { decryptConfigSecrets } from '../src/services/secretStore.js';

const API_BASE = (process.env.E2E_API_BASE || 'http://127.0.0.1:3101/api').replace(/\/+$/, '');
const CONFIG_FILE = process.env.E2E_CONFIG_FILE || './data/config.json';
const USERS_FILE = process.env.E2E_USERS_FILE || './data/users.json';
const PASSWORD = process.env.E2E_PASSWORD || `CodexE2E-${Date.now()}!`;
const PREFIX = `codex-e2e-${Date.now()}`;
const RUN_TIMEOUT_MS = Number(process.env.E2E_RUN_TIMEOUT_MS || 30000);
const TEST_BASE_NAME_HINT = process.env.E2E_TEABLE_BASE_HINT || 'SyncPilot';

const checks = [];
const cleanup = { connectionIds: [], taskIds: [] };

function logStep(name, detail = '') {
  console.log(`\n== ${name}${detail ? `: ${detail}` : ''}`);
}

function record(ok, name, detail = '') {
  checks.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
}

function assertCondition(condition, name, detail = '') {
  record(Boolean(condition), name, detail);
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
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

async function requestJson(path, options = {}, token = null) {
  const result = await request(path, options, token);
  if (!result.ok) throw new Error(`${path} returned ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function ensureTestUsers() {
  const users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')) : [];
  const bcrypt = await import('bcryptjs');
  const mkUser = async (email, role) => ({
    id: crypto.randomUUID(),
    email,
    passwordHash: await bcrypt.hash(PASSWORD, 10),
    role,
    createdAt: new Date().toISOString(),
    codexE2E: true,
  });
  const admin = await mkUser(`${PREFIX}-admin@test.local`, 'super_admin');
  const user = await mkUser(`${PREFIX}-user@test.local`, 'user');
  users.push(admin, user);
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  return { admin, user };
}

function loadConfig() {
  return decryptConfigSecrets(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')));
}

function pickConnections(config) {
  const sql = (config.connections || []).find((conn) => {
    return !conn.deletedAt && conn.shared === true && ['mssql', 'mysql', 'pg'].includes(conn.type) && conn.password;
  });
  const teable = (config.connections || []).find((conn) => {
    return !conn.deletedAt && conn.shared === true && conn.type === 'teable' && conn.token;
  });
  if (!sql) throw new Error('No shared SQL connection with a top-level password found');
  if (!teable) throw new Error('No shared Teable connection found');
  return { sql, teable };
}

function safeSqlConnectionPayload(conn) {
  return {
    name: `${PREFIX}-private-${conn.name || conn.type}`,
    type: conn.type,
    host: conn.host,
    port: conn.port,
    database: conn.database,
    username: conn.username,
    password: conn.password,
    shared: false,
  };
}

async function teableRequest(conn, path, options = {}) {
  const baseUrl = (conn.host || '').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${conn.token}`,
      'Content-Type': 'application/json',
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
  if (!res.ok) throw new Error(`Teable ${path} returned ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function createTeableSmokeTable(conn) {
  const bases = [];
  const spaces = await teableRequest(conn, '/api/space');
  for (const space of spaces) {
    try {
      bases.push(...await teableRequest(conn, `/api/space/${space.id}/base`));
    } catch {
      // Ignore spaces the token cannot read.
    }
  }
  const base = bases.find((item) => item.name?.includes(TEST_BASE_NAME_HINT)) || bases[0];
  if (!base) throw new Error('No Teable base available for smoke test');
  const tableName = `${PREFIX}-target`;
  const created = await teableRequest(conn, `/api/base/${base.id}/table`, {
    method: 'POST',
    body: JSON.stringify({ name: tableName }),
  });
  return { base, table: created };
}

function chooseSourceTable(tables) {
  return tables.find((table) => table.name === 'Orders') || tables[0];
}

function buildTaskPayload({ taskName, sqlConnId, teableConnId, sourceTable, targetTableId }) {
  const pk = sourceTable.columns?.find((col) => ['id', 'ID'].includes(col.name))?.name || sourceTable.columns?.[0]?.name;
  if (!pk) throw new Error(`No source columns found for ${sourceTable.name}`);
  const mapping = Object.fromEntries((sourceTable.columns || []).map((col) => [col.name, col.name]));
  mapping[pk] = 'Name';
  return {
    name: taskName,
    sourceConnectionId: sqlConnId,
    sourceTable: sourceTable.name,
    targetConnectionId: teableConnId,
    targetTableId,
    columnMapping: mapping,
    sourcePrimaryKey: pk,
    conflictStrategy: 'upsert',
    syncMode: 'manual',
    syncInterval: 300,
    watermarkType: 'full_scan',
    deletionMode: 'ignore',
    pageSize: 100,
    batchSize: 50,
    retryCount: 2,
  };
}

async function waitForRun(taskId, token) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < RUN_TIMEOUT_MS) {
    const progress = await requestJson(`/tasks/${taskId}/progress`, {}, token);
    if (!['running', 'cancelling'].includes(progress.status)) return progress;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for task ${taskId}`);
}

async function cleanupAssets(userToken) {
  for (const taskId of cleanup.taskIds.reverse()) {
    await request(`/tasks/${taskId}`, { method: 'DELETE' }, userToken).catch(() => {});
  }
  for (const connectionId of cleanup.connectionIds.reverse()) {
    await request(`/connections/${connectionId}`, { method: 'DELETE' }, userToken).catch(() => {});
  }
}

async function main() {
  logStep('Prepare users');
  const { admin, user } = await ensureTestUsers();
  const adminLogin = await requestJson('/auth/login', { method: 'POST', body: JSON.stringify({ email: admin.email, password: PASSWORD }) });
  const userLogin = await requestJson('/auth/login', { method: 'POST', body: JSON.stringify({ email: user.email, password: PASSWORD }) });
  const adminToken = adminLogin.token;
  const userToken = userLogin.token;
  record(adminLogin.user.role === 'super_admin', 'admin login');
  record(userLogin.user.role === 'user', 'user login');

  try {
    logStep('Permission boundaries');
    record((await request('/system/doctor', {}, userToken)).status === 403, 'user cannot run system doctor');
    record((await request('/auth/users', {}, userToken)).status === 403, 'user cannot list users');
    record((await request('/auth/users', {}, adminToken)).status === 200, 'admin can list users');
    const adminRoleChange = await request(`/auth/users/${user.id}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role: 'super_admin' }),
    }, adminToken);
    assertCondition(adminRoleChange.status === 403, 'admin cannot promote user');

    logStep('Discover shared connections');
    const config = loadConfig();
    const { sql, teable } = pickConnections(config);
    const userConnections = await requestJson('/connections', {}, userToken);
    const serializedConnections = JSON.stringify(userConnections);
    assertCondition(!serializedConnections.includes('"password"') && !serializedConnections.includes('"token"'), 'connection list is sanitized');
    assertCondition(userConnections.some((conn) => conn.id === sql.id), 'user sees shared SQL connection', sql.name);
    assertCondition(userConnections.some((conn) => conn.id === teable.id), 'user sees shared Teable connection', teable.name);

    logStep('Create and test private source connection');
    const privateConn = await requestJson('/connections', {
      method: 'POST',
      body: JSON.stringify(safeSqlConnectionPayload(sql)),
    }, userToken);
    cleanup.connectionIds.push(privateConn.id);
    record(Boolean(privateConn.id), 'private source created', privateConn.name);
    const testResult = await requestJson(`/connections/${privateConn.id}/test`, { method: 'POST' }, userToken);
    assertCondition(testResult.success === true, 'private source connection test succeeds');
    const tables = await requestJson(`/connections/${privateConn.id}/tables`, {}, userToken);
    const sourceTable = chooseSourceTable(tables);
    assertCondition(Boolean(sourceTable?.name), 'source table discovered', sourceTable?.name);

    logStep('Create Teable target table');
    const { base, table } = await createTeableSmokeTable(teable);
    assertCondition(Boolean(table?.id), 'Teable target table created', `${base.name}/${table.name}`);

    logStep('Create, preview, run, and reconcile task');
    const taskPayload = buildTaskPayload({
      taskName: `${PREFIX}-task`,
      sqlConnId: privateConn.id,
      teableConnId: teable.id,
      sourceTable,
      targetTableId: table.id,
    });
    const task = await requestJson('/tasks', { method: 'POST', body: JSON.stringify(taskPayload) }, userToken);
    cleanup.taskIds.push(task.id);
    record(Boolean(task.id), 'task created', task.name);
    const preview = await requestJson(`/tasks/${task.id}/preview?limit=3`, {}, userToken);
    assertCondition(preview.rows?.length > 0, 'task preview returns rows', `${preview.rows?.length || 0}`);
    const run = await requestJson(`/tasks/${task.id}/run`, { method: 'POST' }, userToken);
    assertCondition(run.started === true, 'manual run accepted');
    const progress = await waitForRun(task.id, userToken);
    assertCondition(progress.status === 'success', 'manual run succeeds', JSON.stringify(progress));
    const failures = await requestJson(`/tasks/${task.id}/failures`, {}, userToken);
    assertCondition(Array.isArray(failures) && failures.length === 0, 'no failed batches');
    const reconcile = await requestJson(`/tasks/${task.id}/reconcile`, {
      method: 'POST',
      body: JSON.stringify({ limit: 500, sampleLimit: 20 }),
    }, userToken);
    assertCondition(reconcile.missingInTarget === 0 && reconcile.extraInTarget === 0 && reconcile.mismatched === 0, 'reconcile is clean', JSON.stringify(reconcile));

    logStep('Operational views');
    const audit = await requestJson('/audit-logs?limit=20', {}, userToken);
    assertCondition(audit.some((entry) => entry.action === 'task.run'), 'audit logs include task run');
    const backups = await requestJson('/system/config-backups?limit=5', {}, adminToken);
    assertCondition(Array.isArray(backups), 'admin can list config backups', `${backups.length}`);

    await cleanupAssets(userToken);
    record(true, 'cleanup completed');
  } catch (err) {
    await cleanupAssets(userLogin.token).catch(() => {});
    throw err;
  }

  const failed = checks.filter((check) => !check.ok);
  console.log(`\nSmoke result: ${failed.length === 0 ? 'PASS' : 'FAIL'} (${checks.length - failed.length}/${checks.length})`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\nSmoke result: FAIL`);
  console.error(err.stack || err.message);
  process.exit(1);
});

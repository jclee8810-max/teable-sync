#!/usr/bin/env node
import fs from 'fs';
import { decryptConfigSecrets } from '../src/services/secretStore.js';
import { getTeableBases, createTeableField, createTeableRecords, getTeableRecords, normalizeTeableRecordsResponse } from '../src/services/teableService.js';
import { runSyncWithControl } from '../src/services/syncEngine.js';

const CONFIG_FILE = process.env.E2E_CONFIG_FILE || (fs.existsSync('./server/data/config.json') ? './server/data/config.json' : './data/config.json');
const PREFIX = `codex-bidir-${Date.now()}`;
const CLEANUP_TIMEOUT_MS = Number(process.env.E2E_CLEANUP_TIMEOUT_MS || 8000);

function loadConfig() {
  return decryptConfigSecrets(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')));
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

async function createTable(conn, baseId, name) {
  const table = await teableRequest(conn, `/api/base/${baseId}/table`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  await createTeableField(conn, table.id, 'Code', 'varchar');
  await createTeableField(conn, table.id, 'Amount', 'int');
  return table;
}

async function deleteTable(conn, baseId, tableId) {
  try {
    await teableRequest(conn, `/api/base/${baseId}/table/${tableId}/permanent`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    });
  } catch (err) {
    try {
      await teableRequest(conn, `/api/base/${baseId}/table/${tableId}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      });
    } catch (err2) {
      console.warn(`cleanup failed for ${tableId}: ${err2.message}`);
    }
  }
}

function rowsByCode(records) {
  const map = new Map();
  for (const rec of records) {
    const fields = rec.fields || {};
    const code = fields.Code || fields.Name;
    if (code !== undefined && code !== null && code !== '') map.set(String(code), fields);
  }
  return map;
}

async function main() {
  const config = loadConfig();
  const conn = config.connections.find((item) => !item.deletedAt && item.type === 'teable' && item.token);
  if (!conn) throw new Error('No Teable connection with token found');

  const bases = await getTeableBases(conn);
  const base = bases.find((item) => item.name?.includes('SyncPilot')) || bases[0];
  if (!base) throw new Error('No Teable base found');

  const sourceTable = await createTable(conn, base.id, `${PREFIX}-source`);
  const targetTable = await createTable(conn, base.id, `${PREFIX}-target`);
  try {
    await createTeableRecords(conn, sourceTable.id, [
      { fields: { Name: 'A', Code: 'A', Amount: 10 } },
      { fields: { Name: 'B', Code: 'B', Amount: 20 } },
    ]);
    await createTeableRecords(conn, targetTable.id, [
      { fields: { Name: 'B', Code: 'B', Amount: 25 } },
      { fields: { Name: 'C', Code: 'C', Amount: 30 } },
    ]);

    const logs = [];
    const task = {
      id: `smoke-${Date.now()}`,
      name: `${PREFIX}-task`,
      sourceConnectionId: conn.id,
      sourceTable: sourceTable.id,
      targetConnectionId: conn.id,
      targetTableId: targetTable.id,
      syncDirection: 'bidirectional',
      conflictStrategy: 'source_wins',
      sourcePrimaryKey: 'Code',
      columnMapping: { Name: 'Name', Code: 'Code', Amount: 'Amount' },
      pageSize: 100,
      batchSize: 50,
      retryCount: 2,
      deletionMode: 'ignore',
      watermarkType: 'full_scan',
    };
    const result = await runSyncWithControl(task, conn, conn, (entry) => logs.push(entry));
    if (result.status !== 'success') throw new Error(`Unexpected result: ${JSON.stringify(result)}`);

    const sourceRows = rowsByCode(normalizeTeableRecordsResponse(await getTeableRecords(conn, sourceTable.id, { take: 100 })));
    const targetRows = rowsByCode(normalizeTeableRecordsResponse(await getTeableRecords(conn, targetTable.id, { take: 100 })));

    if (!sourceRows.has('A') || !sourceRows.has('B') || !sourceRows.has('C')) throw new Error('Source did not receive all keys');
    if (!targetRows.has('A') || !targetRows.has('B') || !targetRows.has('C')) throw new Error('Target did not receive all keys');
    if (Number(targetRows.get('B').Amount) !== 20) throw new Error(`source_wins conflict did not update target B, got ${targetRows.get('B').Amount}`);

    console.log(JSON.stringify({
      ok: true,
      result,
      sourceKeys: [...sourceRows.keys()].sort(),
      targetKeys: [...targetRows.keys()].sort(),
      conflictAmountB: targetRows.get('B').Amount,
      logCount: logs.length,
    }, null, 2));
  } finally {
    await deleteTable(conn, base.id, sourceTable.id);
    await deleteTable(conn, base.id, targetTable.id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

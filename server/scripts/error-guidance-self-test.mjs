#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { classifySyncError } from '../src/services/errorGuidance.js';

function expectType(message, errorType, actionTarget) {
  const guidance = classifySyncError(message);
  assert.equal(guidance.errorType, errorType, message);
  if (actionTarget) assert.equal(guidance.actionTarget, actionTarget, message);
  assert.ok(guidance.suggestedAction, 'suggested action should be present');
}

expectType('源连接「业务库」尚未测试通过，请先在数据源页面测试连接。', 'connection', 'connections');
expectType('源连接「业务库」测试已过期超过 30 天，请重新测试连接。', 'connection_expired', 'connections');
expectType('Request failed with status code 429 Too Many Requests', 'rate_limit', 'task_settings');
expectType('ETIMEDOUT socket hang up while writing Teable records', 'timeout', 'task_settings');
expectType('403 forbidden: token has no permission for table', 'permission', 'connections');
expectType('字段映射缺少主键字段 source id', 'field_mapping', 'task_mapping');
expectType('column CustomerName not found in target table', 'schema_drift', 'task_mapping');
expectType('Cannot convert invalid date value to Date field', 'data_type', 'task_mapping');
expectType('SYNC_INITIALIZATION_PAUSED: 初始化达到最大连续运行时间', 'initialization_paused', 'task_detail');
expectType('failed batch replay still failing', 'failure_batch', 'task_failures');
expectType('something surprising happened', 'unknown', 'task_detail');

const ROOT = process.cwd();
const TEST_DIR = join(ROOT, 'server', 'data', 'error-guidance-self-test');
mkdirSync(TEST_DIR, { recursive: true });
rmSync(join(TEST_DIR, 'sync-history.json'), { force: true });
rmSync(join(TEST_DIR, 'sync-failures.json'), { force: true });
rmSync(join(TEST_DIR, 'audit-logs.json'), { force: true });

process.env.RUNTIME_STORE_DATA_DIR = TEST_DIR;
process.env.TEABLE_SYNC_RUNTIME_STORE = '';

const { createSyncHistory, getSyncHistoryRecord, updateSyncHistory } = await import('../src/services/syncHistory.js');
const { getTaskHealth } = await import('../src/services/taskHealth.js');

const record = createSyncHistory('guidance-task', 'Guidance Task', 'Orders', 'tbl', { runId: 'guidance-run', trigger: 'manual' });
updateSyncHistory(record.id, {
  status: 'failed',
  errorMessage: 'Request failed with status code 429 Too Many Requests',
  durationMs: 321,
});
const failed = getSyncHistoryRecord(record.id);
assert.equal(failed.errorType, 'rate_limit');
assert.equal(failed.actionTarget, 'task_settings');
assert.match(failed.suggestedAction, /降低写入批量/);

const health = getTaskHealth({ id: 'guidance-task', name: 'Guidance Task' });
assert.equal(health.latestErrorType, 'rate_limit');
assert.equal(health.latestActionTarget, 'task_settings');
assert.match(health.latestSuggestedAction, /降低写入批量/);

console.log('error guidance self-test PASS');

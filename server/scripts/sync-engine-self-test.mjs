#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = dirname(__dirname);
const DATA_DIR = join(SERVER_DIR, 'data');
const STATE_DIR = join(DATA_DIR, 'sync-state');
const TASK_ID = `self-test-${Date.now()}`;
const RUN_ID = `${TASK_ID}-run`;
const backupStamp = Date.now();
const files = [
  join(DATA_DIR, 'sync-failures.json'),
  join(DATA_DIR, 'sync-history.json'),
  join(STATE_DIR, `${TASK_ID}.json`),
].map((file) => ({ file, backup: `${file}.self-test-${backupStamp}`, existed: existsSync(file) }));

function backupFiles() {
  mkdirSync(STATE_DIR, { recursive: true });
  for (const item of files) {
    if (item.existed) writeFileSync(item.backup, readFileSync(item.file));
  }
}

function restoreFiles() {
  for (const item of files.reverse()) {
    if (item.existed && existsSync(item.backup)) renameSync(item.backup, item.file);
    else if (!item.existed && existsSync(item.file)) unlinkSync(item.file);
  }
}

let exitCode = 0;
let timeout = null;
try {
  timeout = setTimeout(() => {
    console.error('sync-engine reliability self-test timed out');
    process.exit(1);
  }, 10000);
  const {
    compareWatermarkValues,
    normalizeTimestampWatermark,
    resolveWatermark,
    clearTaskSyncState,
    createPerMinuteLimiter,
    getTaskInitializationState,
  } = await import('../src/services/syncEngine.js');
  const {
    convertValue,
    isTypeCompatible,
    normalizeAttachmentValue,
    suggestTeableType,
  } = await import('../src/services/typeConverter.js');
  const {
    addSyncFailure,
    clearSyncFailures,
    getSyncFailure,
    getSyncFailureCounts,
    getSyncFailures,
    markSyncFailureRetried,
    removeSyncFailures,
  } = await import('../src/services/syncFailures.js');
  const {
    createSyncHistory,
    getSyncHistory,
    getSyncHistoryRecord,
    updateSyncHistory,
  } = await import('../src/services/syncHistory.js');

  backupFiles();

  assert.deepEqual(
    resolveWatermark({}, 'id', { rowversion: [], timestamp: ['created_at', 'updated_at'], auto_pk: ['id'] }),
    { type: 'timestamp', col: 'updated_at', description: '时间戳增量 (updated_at)' },
  );

  assert.deepEqual(
    resolveWatermark({ watermarkType: 'auto_pk' }, 'id', { rowversion: [], timestamp: [], auto_pk: [] }),
    { type: 'auto_pk', col: 'id', description: '自增主键增量 (id)' },
  );

  assert.deepEqual(
    resolveWatermark({ sourceTimestampColumn: 'modified_at' }, 'id', { rowversion: [], timestamp: [], auto_pk: ['id'] }),
    { type: 'timestamp', col: 'modified_at', description: '时间戳增量 (modified_at)' },
  );

  assert.equal(compareWatermarkValues('2026-05-08T01:00:00.000Z', new Date('2026-05-08T00:59:59.000Z')) > 0, true);
  assert.equal(normalizeTimestampWatermark(new Date('2026-05-08T01:00:00.000Z')), '2026-05-08T01:00:00.000Z');
  assert.deepEqual(normalizeAttachmentValue('https://example.com/files/a.png'), [{ url: 'https://example.com/files/a.png', name: 'a.png' }]);
  assert.deepEqual(convertValue('["https://example.com/a.png","https://example.com/b.jpg"]', 'json', 'attachment').map((item) => item.name), ['a.png', 'b.jpg']);
  assert.equal(convertValue(Buffer.from('raw'), 'blob', 'attachment'), null);
  assert.equal(isTypeCompatible('teable:attachment', 'attachment').safe, true);
  assert.match(isTypeCompatible('varchar', 'attachment').warning, /URL/);
  assert.equal(suggestTeableType('teable:attachment').type, 'attachment');
  {
    let cancelChecks = 0;
    const logs = [];
    const limiter = createPerMinuteLimiter(1, 'self-test', (level, message) => logs.push({ level, message }), () => {
      cancelChecks += 1;
      if (cancelChecks > 2) {
        const err = new Error('cancelled during limiter wait');
        err.code = 'SELF_TEST_CANCELLED';
        throw err;
      }
    });
    await limiter();
    await assert.rejects(() => limiter(), /cancelled during limiter wait/);
    assert.equal(logs.some((entry) => entry.message.includes('初始化限速')), true);
  }

  clearTaskSyncState(TASK_ID);
  const state = JSON.parse(readFileSync(join(STATE_DIR, `${TASK_ID}.json`), 'utf-8'));
  assert.deepEqual(state, { lastSyncAt: null, watermark: null, syncedIds: [], checkpoint: null, checkpoints: [] });
  assert.equal(getTaskInitializationState(TASK_ID).hasCheckpoint, false);

  clearSyncFailures(TASK_ID);
  const task = { id: TASK_ID, name: 'Reliability Self Test' };
  const failure = addSyncFailure({
    task,
    operation: 'insert',
    tableId: 'tbl-self-test',
    records: [{ fields: { SourceId: 'A001', Name: 'Alpha' } }],
    primaryKeys: ['A001'],
    runId: RUN_ID,
    batchNo: 2,
    writeBatchNo: 1,
    sourceRange: { start: 501, end: 1000, count: 500 },
    sourceOffset: 500,
    sourceCursorBefore: '500',
    sourceCursorAfter: '1000',
    pkFieldName: 'SourceId',
    error: new Error('simulated write failure'),
  });
  assert.equal(getSyncFailures(TASK_ID).length, 1);
  assert.equal(getSyncFailure(failure.id).id, failure.id);
  assert.equal(getSyncFailureCounts()[TASK_ID], 1);
  assert.equal(getSyncFailures(TASK_ID)[0].sourceRange.end, 1000);
  const retried = markSyncFailureRetried(failure.id, new Error('still failing'));
  assert.equal(retried.retryCount, 1);
  assert.match(retried.errorMessage, /still failing/);
  assert.equal(removeSyncFailures([failure.id]), 1);
  assert.equal(getSyncFailures(TASK_ID).length, 0);

  const history = createSyncHistory(TASK_ID, task.name, 'Orders', 'tbl-self-test', { runId: RUN_ID, trigger: 'self-test' });
  assert.equal(history.runId, RUN_ID);
  assert.equal(getSyncHistory(TASK_ID, 5)[0].status, 'running');
  const progress = updateSyncHistory(history.id, {
    status: 'running',
    runId: RUN_ID,
    mode: 'full',
    sourceRows: 500,
    inserted: 400,
    durationMs: 500,
  });
  assert.equal(progress.endTime, null);
  assert.equal(progress.sourceRows, 500);
  const updated = updateSyncHistory(history.id, {
    status: 'success',
    runId: RUN_ID,
    mode: 'full',
    sourceRows: 1000,
    inserted: 998,
    updated: 2,
    skipped: 0,
    failed: 0,
    durationMs: 1234,
  });
  assert.equal(updated.status, 'success');
  assert.equal(updated.sourceRows, 1000);
  assert.equal(getSyncHistoryRecord(history.id).durationMs, 1234);

  console.log('sync-engine reliability self-test passed');
} catch (err) {
  exitCode = 1;
  console.error(err.stack || err.message);
} finally {
  if (timeout) clearTimeout(timeout);
  restoreFiles();
  process.exit(exitCode);
}

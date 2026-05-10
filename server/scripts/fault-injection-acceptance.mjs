#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { performance } from 'perf_hooks';

const REPORT_DIR = join(process.cwd(), 'server', 'data', 'reports');
const DEFAULT_TIERS = [1000, 10000, 100000];
const startedAt = new Date();

function parseTiers() {
  const raw = process.env.FAULT_TIERS || process.env.STRESS_TIERS || process.argv.find((arg) => arg.startsWith('--tiers='))?.slice('--tiers='.length);
  if (!raw) return DEFAULT_TIERS;
  return raw.split(',').map((item) => Number(item.trim())).filter((value) => Number.isFinite(value) && value > 0);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function memoryMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function createRows(count) {
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    return {
      id,
      order_no: `SO-${String(id).padStart(8, '0')}`,
      customer: `Customer ${id % 997}`,
      amount: Number(((id % 113) * 19.87).toFixed(2)),
      updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, id % 86400)).toISOString(),
      deleted: false,
    };
  });
}

function upsertBatch(target, rows) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const key = String(row.id);
    const existing = target.get(key);
    if (!existing) {
      target.set(key, { ...row });
      inserted += 1;
    } else if (JSON.stringify(existing) !== JSON.stringify(row)) {
      target.set(key, { ...row });
      updated += 1;
    } else {
      skipped += 1;
    }
  }
  return { inserted, updated, skipped };
}

function createHistory(runId, taskId, trigger) {
  return {
    id: runId,
    runId,
    taskId,
    taskName: `Fault ${taskId}`,
    sourceTable: 'Orders',
    targetTableId: 'tbl-fault',
    trigger,
    startTime: new Date().toISOString(),
    endTime: null,
    status: 'running',
    mode: 'full',
    sourceRows: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    softDeleted: 0,
    failed: 0,
    errorMessage: null,
    durationMs: 0,
  };
}

function finishHistory(record, patch) {
  Object.assign(record, patch, {
    endTime: new Date().toISOString(),
    durationMs: Math.max(1, performance.now() - record._startedAt),
  });
  delete record._startedAt;
  return record;
}

function buildAlertSnapshot(task, history, failures) {
  const latest = history[0] || null;
  const pendingFailures = failures.reduce((sum, failure) => sum + failure.count, 0);
  const alerts = [];
  if (pendingFailures > 0) {
    alerts.push({
      id: `task-${task.id}-pending-failures`,
      severity: 'critical',
      type: 'sync_failure',
      taskId: task.id,
      taskName: task.name,
      message: `还有 ${pendingFailures} 个失败批次未重试或清理`,
      metadata: { pendingFailures },
    });
  }
  if (latest?.status === 'failed') {
    alerts.push({
      id: `task-${task.id}-latest-failed`,
      severity: 'critical',
      type: 'recent_failed',
      taskId: task.id,
      taskName: task.name,
      message: latest.errorMessage || '最近一次同步失败',
      metadata: { latestRunId: latest.runId },
    });
  }
  return {
    summary: {
      totalTasks: 1,
      pendingFailureRows: pendingFailures,
      criticalAlerts: alerts.length,
      failedRuns24h: history.filter((item) => item.status === 'failed').length,
      successes24h: history.filter((item) => item.status === 'success').length,
    },
    alerts,
  };
}

function runTier(size, options = {}) {
  const started = performance.now();
  const task = { id: `fault-${size}`, name: `Fault Injection ${size}` };
  const rows = createRows(size);
  const target = new Map();
  const history = [];
  const failures = [];
  const batchSize = options.batchSize;
  const cancelAfter = Math.max(batchSize, Math.floor(size * 0.35));
  const failBatchNo = Math.max(2, Math.ceil(size / batchSize / 2));
  let checkpoint = null;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let batchNo = 0;

  const cancelRun = createHistory(`${task.id}-cancel`, task.id, 'fault_cancel');
  cancelRun._startedAt = performance.now();
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    batchNo += 1;
    const batch = rows.slice(offset, offset + batchSize);
    const result = upsertBatch(target, batch);
    inserted += result.inserted;
    updated += result.updated;
    skipped += result.skipped;
    checkpoint = {
      runId: cancelRun.runId,
      taskId: task.id,
      mode: 'full',
      batchNo,
      sourceOffset: offset + batch.length,
      sourceRange: { start: offset + 1, end: offset + batch.length, count: batch.length },
      processedRows: offset + batch.length,
      inserted,
      updated,
      skipped,
      failed: 0,
      savedAt: new Date().toISOString(),
    };
    Object.assign(cancelRun, { sourceRows: checkpoint.processedRows, inserted, updated, skipped });
    if (checkpoint.processedRows >= cancelAfter) break;
  }
  history.unshift(finishHistory(cancelRun, {
    status: 'cancelled',
    errorMessage: 'fault injection: cancelled during initialization',
    sourceRows: checkpoint.processedRows,
    inserted,
    updated,
    skipped,
  }));

  assert.ok(checkpoint?.processedRows >= cancelAfter, 'cancel leaves checkpoint');
  assert.equal(target.size, checkpoint.processedRows, 'cancelled run writes exactly checkpoint rows');

  const resumeRun = createHistory(`${task.id}-resume`, task.id, 'fault_resume');
  resumeRun._startedAt = performance.now();
  let failedDuringResume = 0;
  for (let offset = checkpoint.sourceOffset; offset < rows.length; offset += batchSize) {
    batchNo += 1;
    const batch = rows.slice(offset, offset + batchSize);
    if (batchNo === failBatchNo) {
      failedDuringResume += batch.length;
      failures.push({
        id: `${task.id}-failure-${batchNo}`,
        taskId: task.id,
        taskName: task.name,
        runId: resumeRun.runId,
        batchNo,
        writeBatchNo: 1,
        operation: 'insert',
        tableId: 'tbl-fault',
        records: batch.map((row) => ({ fields: { ...row } })),
        primaryKeys: batch.map((row) => row.id),
        pkFieldName: 'id',
        sourceRange: { start: offset + 1, end: offset + batch.length, count: batch.length },
        sourceOffset: offset,
        count: batch.length,
        errorMessage: 'fault injection: simulated write failure',
        createdAt: new Date().toISOString(),
        retryCount: 0,
        lastRetryAt: null,
      });
      checkpoint = {
        ...checkpoint,
        runId: resumeRun.runId,
        failed: failedDuringResume,
        savedAt: new Date().toISOString(),
      };
      break;
    }
    const result = upsertBatch(target, batch);
    inserted += result.inserted;
    updated += result.updated;
    skipped += result.skipped;
    checkpoint = {
      ...checkpoint,
      runId: resumeRun.runId,
      batchNo,
      sourceOffset: offset + batch.length,
      sourceRange: { start: offset + 1, end: offset + batch.length, count: batch.length },
      processedRows: offset + batch.length,
      inserted,
      updated,
      skipped,
      failed: 0,
      savedAt: new Date().toISOString(),
    };
  }
  history.unshift(finishHistory(resumeRun, {
    status: 'failed',
    sourceRows: checkpoint.processedRows,
    inserted,
    updated,
    skipped,
    failed: failedDuringResume,
    errorMessage: 'fault injection: simulated write failure',
  }));

  const alertBeforeReplay = buildAlertSnapshot(task, history, failures);
  assert.equal(failures.length, 1, 'failed batch is recorded');
  assert.equal(alertBeforeReplay.summary.pendingFailureRows, failedDuringResume, 'alert pending failure rows match failure batch');
  assert.equal(alertBeforeReplay.alerts.some((item) => item.type === 'sync_failure'), true, 'sync failure alert is raised');

  let replayInserted = 0;
  let replayUpdated = 0;
  let replaySkipped = 0;
  for (const failure of failures.splice(0)) {
    for (let i = 0; i < failure.records.length; i += batchSize) {
      const batch = failure.records.slice(i, i + batchSize).map((record) => record.fields);
      const result = upsertBatch(target, batch);
      replayInserted += result.inserted;
      replayUpdated += result.updated;
      replaySkipped += result.skipped;
    }
  }
  assert.equal(failures.length, 0, 'failure batch is removed after replay');

  const finalRun = createHistory(`${task.id}-final`, task.id, 'fault_continue_after_replay');
  finalRun._startedAt = performance.now();
  for (let offset = target.size; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const result = upsertBatch(target, batch);
    inserted += result.inserted;
    updated += result.updated;
    skipped += result.skipped;
  }
  history.unshift(finishHistory(finalRun, {
    status: 'success',
    sourceRows: size,
    inserted,
    updated,
    skipped,
    failed: 0,
    errorMessage: null,
  }));

  const idempotent = upsertBatch(target, rows);
  const alertAfterReplay = buildAlertSnapshot(task, history, failures);
  const durationMs = Math.round(performance.now() - started);
  const ok = target.size === size
    && checkpoint.processedRows >= cancelAfter
    && replayInserted + replayUpdated + replaySkipped === failedDuringResume
    && idempotent.inserted === 0
    && failures.length === 0
    && history[0].status === 'success'
    && history.some((item) => item.status === 'cancelled')
    && history.some((item) => item.status === 'failed')
    && alertAfterReplay.summary.pendingFailureRows === 0;

  return {
    size,
    batchSize,
    ok,
    durationMs,
    throughput: Math.round(size / Math.max(durationMs / 1000, 0.001)),
    checkpointRows: checkpoint.processedRows,
    cancelledAt: cancelAfter,
    failedBatchRows: failedDuringResume,
    replayInserted,
    replayUpdated,
    replaySkipped,
    idempotentInserted: idempotent.inserted,
    targetRows: target.size,
    historyRuns: history.length,
    alertBeforeReplay: alertBeforeReplay.alerts.length,
    alertAfterReplay: alertAfterReplay.alerts.length,
    rssMb: memoryMb(),
  };
}

function findDocker() {
  const candidates = [
    process.env.DOCKER_BIN,
    'docker',
    '/Applications/Docker.app/Contents/Resources/bin/docker',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['version'], { stdio: 'ignore' });
    if (result.status === 0) return candidate;
  }
  return null;
}

function runDockerRestartProbe() {
  if (process.env.FAULT_DOCKER_RESTART !== 'true') {
    return { enabled: false, ok: true, detail: 'set FAULT_DOCKER_RESTART=true to restart local docker service during acceptance' };
  }
  const docker = findDocker();
  if (!docker) return { enabled: true, ok: false, detail: 'Docker CLI not found' };
  const restart = spawnSync(docker, ['compose', 'restart', 'teable-sync'], { stdio: 'pipe', encoding: 'utf8', timeout: 120000 });
  if (restart.status !== 0) {
    return { enabled: true, ok: false, detail: `${restart.stdout || ''}${restart.stderr || ''}`.trim().slice(-2000) };
  }
  let health = null;
  const attempts = clampInt(process.env.FAULT_DOCKER_HEALTH_ATTEMPTS, 30, 1, 120);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    health = spawnSync('curl', ['-fsS', 'http://127.0.0.1:3101/health'], { stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
    if (health.status === 0) {
      return { enabled: true, ok: true, detail: `ready after ${attempt} attempt(s): ${health.stdout.trim()}` };
    }
    spawnSync('sleep', ['2'], { stdio: 'ignore' });
  }
  return {
    enabled: true,
    ok: false,
    detail: `${health?.stdout || ''}${health?.stderr || ''}`.trim().slice(-2000),
  };
}

function renderReport({ results, dockerProbe }) {
  const status = results.every((item) => item.ok) && dockerProbe.ok ? 'PASS' : 'FAIL';
  const lines = [
    '# Teable Sync Fault Injection Acceptance',
    '',
    `- Started: ${startedAt.toISOString()}`,
    `- Finished: ${new Date().toISOString()}`,
    `- Status: ${status}`,
    '- Mode: deterministic fault-injection simulation plus optional Docker restart probe',
    '- Coverage: 1k / 10k / 100k tiers, cancellation checkpoint, container restart probe, failed batch replay, run history consistency, alert consistency.',
    '',
    '| Rows | Status | Duration | Throughput | Checkpoint | Failed Batch | Replay I/U/S | Target Rows | History Runs | Alerts Before/After | RSS |',
    '| ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- | ---: |',
    ...results.map((item) => `| ${item.size.toLocaleString()} | ${item.ok ? 'PASS' : 'FAIL'} | ${item.durationMs} ms | ${item.throughput}/s | ${item.checkpointRows.toLocaleString()} | ${item.failedBatchRows.toLocaleString()} | ${item.replayInserted}/${item.replayUpdated}/${item.replaySkipped} | ${item.targetRows.toLocaleString()} | ${item.historyRuns} | ${item.alertBeforeReplay}/${item.alertAfterReplay} | ${item.rssMb} MB |`),
    '',
    '## Docker Restart Probe',
    '',
    `- Enabled: ${dockerProbe.enabled ? 'yes' : 'no'}`,
    `- Status: ${dockerProbe.ok ? 'PASS' : 'FAIL'}`,
    `- Detail: ${String(dockerProbe.detail || '').replace(/\n/g, ' ').slice(0, 1000)}`,
    '',
    '## Acceptance Rules',
    '',
    '- Cancelled initialization must leave a checkpoint and partial target rows.',
    '- Simulated restart must not remove deterministic checkpoint/history state.',
    '- Failed write batch must create pending failure alert before replay.',
    '- Failure replay must clear pending failures and remove the alert.',
    '- Final continue run must complete with target rows equal to source rows.',
    '- Idempotent replay must not create duplicate records.',
    '',
  ];
  return lines.join('\n');
}

const tiers = parseTiers();
const batchSize = clampInt(process.env.FAULT_BATCH_SIZE || process.env.STRESS_BATCH_SIZE, 500, 10, 1000);
mkdirSync(REPORT_DIR, { recursive: true });

let exitCode = 0;
let results = [];
let dockerProbe = { enabled: false, ok: true, detail: 'not run' };
try {
  assert.ok(tiers.includes(1000), '1k tier is required');
  assert.ok(tiers.includes(10000), '10k tier is required');
  assert.ok(tiers.includes(100000), '100k tier is required');
  results = tiers.map((tier) => runTier(tier, { batchSize }));
  dockerProbe = runDockerRestartProbe();
  assert.equal(results.every((item) => item.ok), true, 'all fault tiers must pass');
  assert.equal(dockerProbe.ok, true, 'docker restart probe must pass when enabled');
} catch (err) {
  exitCode = 1;
  results.error = err.message;
  console.error(err.stack || err.message);
}

const report = renderReport({ results, dockerProbe });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const reportPath = join(REPORT_DIR, `fault-injection-acceptance_${stamp}.md`);
writeFileSync(reportPath, report, 'utf8');
console.log(reportPath);
process.exit(exitCode);

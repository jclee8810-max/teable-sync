#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const tiers = (process.env.STRESS_TIERS || '1000,10000,100000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const pageSize = clampInt(process.env.STRESS_PAGE_SIZE, 1000, 100, 5000);
const batchSize = clampInt(process.env.STRESS_BATCH_SIZE, 500, 10, 1000);
const readPagesPerMinute = clampInt(process.env.STRESS_READ_PAGES_PER_MINUTE, 120, 0, 100000);
const writeBatchesPerMinute = clampInt(process.env.STRESS_WRITE_BATCHES_PER_MINUTE, 60, 0, 100000);
const maxInitialRows = clampInt(process.env.STRESS_MAX_INITIAL_ROWS, 100000, 1000, 10000000);
const warnRows = Math.min(maxInitialRows, clampInt(process.env.STRESS_WARN_ROWS, 50000, 1000, 10000000));
const maxContinuousMinutes = clampInt(process.env.STRESS_INITIAL_MAX_RUN_MINUTES, 30, 0, 1440);
const teableMaxBatchSize = 1000;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'unlimited';
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${Math.ceil(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.ceil(minutes % 60);
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function estimate(rows) {
  const pages = Math.ceil(rows / pageSize);
  const writes = Math.ceil(rows / batchSize);
  const teableReadRequests = Math.ceil(rows / teableMaxBatchSize);
  const teableRequests = writes + teableReadRequests;
  const readMinutes = readPagesPerMinute > 0 ? pages / readPagesPerMinute : 0;
  const writeMinutes = writeBatchesPerMinute > 0 ? writes / writeBatchesPerMinute : 0;
  const throttledMinutes = Math.max(readMinutes, writeMinutes);
  const durationMin = throttledMinutes > 0 ? Math.max(1, Math.floor(throttledMinutes)) : 0;
  const durationMax = throttledMinutes > 0 ? Math.max(1, Math.ceil(throttledMinutes * 1.3)) : 0;
  const windows = maxContinuousMinutes > 0 && durationMax > 0 ? Math.max(1, Math.ceil(durationMax / maxContinuousMinutes)) : 1;
  const blocked = rows > maxInitialRows;
  const warn = !blocked && rows > warnRows;
  const status = blocked ? 'BLOCK' : warn ? 'WARN' : 'PASS';
  const suggestions = blocked
    ? ['调高初始全量上限', '低峰执行', '拆分源表或增加过滤条件']
    : warn
      ? ['低峰执行', '保留初始化限速', '必要时分段继续初始化']
      : ['可直接执行', '仍建议保留预检'];
  return {
    rows,
    pages,
    writes,
    teableReadRequests,
    teableRequests,
    durationMin,
    durationMax,
    windows,
    status,
    suggestions,
  };
}

function assertReadiness(rows) {
  assert.ok(tiers.length > 0, 'at least one stress tier must be configured');
  assert.ok(pageSize >= 100 && pageSize <= 5000, 'page size must match backend limits');
  assert.ok(batchSize >= 10 && batchSize <= teableMaxBatchSize, 'Teable write batch must stay within backend/API limits');
  assert.ok(maxInitialRows >= 1000 && maxInitialRows <= 10000000, 'initial full sync max rows must match backend limits');
  assert.ok(rows.some((item) => item.rows === 1000), '1k-row readiness tier is required');
  assert.ok(rows.some((item) => item.rows === 10000), '10k-row readiness tier is required');
  assert.ok(rows.some((item) => item.rows === 100000), '100k-row readiness tier is required');
  assert.ok(rows.find((item) => item.rows === 100000)?.status !== 'BLOCK', '100k-row tier should be allowed by the default protection threshold');
}

const reportDir = join(process.cwd(), 'server', 'data', 'reports');
mkdirSync(reportDir, { recursive: true });
const generatedAt = new Date();
const reportPath = join(reportDir, `large-sync-readiness_${generatedAt.toISOString().replace(/[:.]/g, '-')}.md`);
const rows = tiers.map(estimate);
assertReadiness(rows);

const lines = [
  '# Teable Sync Large Initial Sync Readiness',
  '',
  `- Generated: ${generatedAt.toISOString()}`,
  '- Status: PASS',
  `- Page size: ${pageSize}`,
  `- Write batch size: ${batchSize}`,
  `- Initial full sync warn rows: ${warnRows.toLocaleString()}`,
  `- Initial full sync max rows: ${maxInitialRows.toLocaleString()}`,
  `- Read pages/minute: ${readPagesPerMinute || 'unlimited'}`,
  `- Write batches/minute: ${writeBatchesPerMinute || 'unlimited'}`,
  `- Max continuous initialization window: ${maxContinuousMinutes ? `${maxContinuousMinutes} min` : 'unlimited'}`,
  '',
  '| Rows | Status | Source pages | Teable write batches | Teable/API requests | Estimated duration | Suggested windows | Advice |',
  '| ---: | --- | ---: | ---: | ---: | --- | ---: | --- |',
  ...rows.map((item) => `| ${item.rows.toLocaleString()} | ${item.status} | ${item.pages.toLocaleString()} | ${item.writes.toLocaleString()} | ${item.teableRequests.toLocaleString()} | ${item.durationMin ? `${formatDuration(item.durationMin)}-${formatDuration(item.durationMax)}` : 'unlimited'} | ${item.windows} | ${item.suggestions.join('; ')} |`),
  '',
  '## Release Gates',
  '',
  '- 1k, 10k and 100k tiers must be present.',
  '- Teable write batch size must stay within 10-1000.',
  '- Default 100k tier must not be blocked by the initial full sync protection threshold.',
  '- Report must show estimated read pages, write batches, requests and run windows.',
  '',
  '## Acceptance Scenarios',
  '',
  '- First full sync completes without duplicate records when run twice.',
  '- Cancel during initialization leaves checkpoint and does not advance final watermark.',
  '- Continue initialization resumes from checkpoint.',
  '- Failed write batch can be replayed and removed from failure list.',
  '- Reconciliation after initialization reports no unexpected differences.',
];
writeFileSync(reportPath, lines.join('\n'), 'utf8');
console.log(reportPath);

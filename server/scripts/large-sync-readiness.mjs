#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const tiers = [1000, 10000, 100000];
const pageSize = Number(process.env.STRESS_PAGE_SIZE || 1000);
const batchSize = Number(process.env.STRESS_BATCH_SIZE || 500);
const readPagesPerMinute = Number(process.env.STRESS_READ_PAGES_PER_MINUTE || 0);
const writeBatchesPerMinute = Number(process.env.STRESS_WRITE_BATCHES_PER_MINUTE || 0);

function estimate(rows) {
  const pages = Math.ceil(rows / pageSize);
  const writes = Math.ceil(rows / batchSize);
  const requests = pages + writes;
  const readMinutes = readPagesPerMinute > 0 ? pages / readPagesPerMinute : 0;
  const writeMinutes = writeBatchesPerMinute > 0 ? writes / writeBatchesPerMinute : 0;
  const throttledMinutes = Math.max(readMinutes, writeMinutes);
  return {
    rows,
    pages,
    writes,
    requests,
    duration: throttledMinutes > 0 ? `${Math.max(1, Math.floor(throttledMinutes))}-${Math.max(1, Math.ceil(throttledMinutes * 1.3))} min` : 'unlimited',
  };
}

const reportDir = join(process.cwd(), 'server', 'data', 'reports');
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, `large-sync-readiness_${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
const rows = tiers.map(estimate);
const lines = [
  '# Teable Sync Large Initial Sync Readiness',
  '',
  `- Generated: ${new Date().toISOString()}`,
  `- Page size: ${pageSize}`,
  `- Write batch size: ${batchSize}`,
  `- Read pages/minute: ${readPagesPerMinute || 'unlimited'}`,
  `- Write batches/minute: ${writeBatchesPerMinute || 'unlimited'}`,
  '',
  '| Rows | Source pages | Teable write batches | Estimated Teable/API requests | Duration estimate |',
  '| ---: | ---: | ---: | ---: | --- |',
  ...rows.map((item) => `| ${item.rows.toLocaleString()} | ${item.pages.toLocaleString()} | ${item.writes.toLocaleString()} | ${item.requests.toLocaleString()} | ${item.duration} |`),
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

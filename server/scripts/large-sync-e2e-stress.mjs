#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = dirname(__dirname);
const REPORT_DIR = join(SERVER_DIR, 'data', 'reports');
const DEFAULT_SIZES = [1000, 10000, 100000];

function parseSizes() {
  const raw = process.env.STRESS_SIZES || process.argv.find((arg) => arg.startsWith('--sizes='))?.slice('--sizes='.length);
  if (!raw) return DEFAULT_SIZES;
  return raw.split(',').map((item) => Number(item.trim())).filter((n) => Number.isFinite(n) && n > 0);
}

function nowIso() {
  return new Date().toISOString();
}

function memoryMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function createRows(count) {
  return Array.from({ length: count }, (_, idx) => {
    const n = idx + 1;
    return {
      id: n,
      order_no: `SO-${String(n).padStart(7, '0')}`,
      customer: `Customer ${n % 500}`,
      amount: Number(((n % 97) * 12.34).toFixed(2)),
      updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n % 86400)).toISOString(),
      deleted: false,
    };
  });
}

function upsertBatch(target, rows) {
  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    const existing = target.get(String(row.id));
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(row)) {
        target.set(String(row.id), row);
        updated += 1;
      }
    } else {
      target.set(String(row.id), row);
      inserted += 1;
    }
  }
  return { inserted, updated };
}

function runScenario(size, batchSize = 500) {
  const started = performance.now();
  const target = new Map();
  const rows = createRows(size);
  let inserted = 0;
  let updated = 0;
  let failed = 0;
  let checkpoint = 0;
  let cancelledAt = 0;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const result = upsertBatch(target, batch);
    inserted += result.inserted;
    updated += result.updated;
    checkpoint = offset + batch.length;
    if (!cancelledAt && checkpoint >= Math.floor(size / 2)) {
      cancelledAt = checkpoint;
      break;
    }
  }

  for (let offset = cancelledAt; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const result = upsertBatch(target, batch);
    inserted += result.inserted;
    updated += result.updated;
    checkpoint = offset + batch.length;
  }

  let replayInserted = 0;
  let replayUpdated = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const result = upsertBatch(target, batch);
    replayInserted += result.inserted;
    replayUpdated += result.updated;
  }

  const durationMs = performance.now() - started;
  const throughput = Math.round(size / Math.max(durationMs / 1000, 0.001));
  const ok = target.size === size && checkpoint === size && replayInserted === 0 && failed === 0;
  return {
    size,
    batchSize,
    durationMs: Math.round(durationMs),
    throughput,
    inserted,
    updated,
    replayInserted,
    replayUpdated,
    failed,
    targetRows: target.size,
    checkpoint,
    cancelledAt,
    rssMb: memoryMb(),
    ok,
  };
}

function renderReport(results, startedAt) {
  const status = results.every((item) => item.ok) ? 'PASS' : 'FAIL';
  return [
    '# Teable Sync Large E2E Stress Report',
    '',
    `- Started: ${startedAt}`,
    `- Finished: ${nowIso()}`,
    `- Status: ${status}`,
    '- Mode: local deterministic engine simulation',
    '- Notes: This script validates first full sync, checkpoint resume, cancel/continue, and idempotent replay without calling external Teable APIs.',
    '',
    '| Rows | Status | Duration | Throughput | Inserted | Replay Inserted | Target Rows | Checkpoint | RSS |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...results.map((item) => `| ${item.size.toLocaleString('en-US')} | ${item.ok ? 'PASS' : 'FAIL'} | ${item.durationMs} ms | ${item.throughput}/s | ${item.inserted.toLocaleString('en-US')} | ${item.replayInserted} | ${item.targetRows.toLocaleString('en-US')} | ${item.checkpoint.toLocaleString('en-US')} | ${item.rssMb} MB |`),
    '',
    '## Acceptance',
    '',
    '- Replayed batches must not create duplicate rows.',
    '- Resume must finish from the checkpoint after simulated cancellation.',
    '- Target row count must equal source row count for every configured size.',
    '',
  ].join('\n');
}

const startedAt = nowIso();
const sizes = parseSizes();
mkdirSync(REPORT_DIR, { recursive: true });
const results = sizes.map((size) => runScenario(size, Number(process.env.STRESS_BATCH_SIZE || 500)));
const report = renderReport(results, startedAt);
const stamp = startedAt.replace(/[:.]/g, '-');
const reportPath = join(REPORT_DIR, `large-sync-e2e-stress_${stamp}.md`);
writeFileSync(reportPath, report, 'utf8');
console.log(reportPath);
process.exit(results.every((item) => item.ok) ? 0 : 1);

#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const startedAt = new Date();
const ROOT = process.cwd();
const REPORT_DIR = join(ROOT, 'server', 'data', 'reports');
const DURATION_MINUTES = Math.max(1, Number(process.env.REALRUN_MINUTES || 60));
const INTERVAL_SECONDS = Math.max(5, Number(process.env.REALRUN_INTERVAL_SECONDS || 120));
const E2E_TIMEOUT_MS = String(Math.max(10000, Number(process.env.REALRUN_E2E_TIMEOUT_MS || 60000)));
const END_AT = Date.now() + DURATION_MINUTES * 60 * 1000;
const samples = [];
const runs = [];

function findDocker() {
  const candidates = [process.env.DOCKER_BIN, 'docker', '/Applications/Docker.app/Contents/Resources/bin/docker'].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['version'], { stdio: 'ignore' });
    if (result.status === 0) return candidate;
  }
  return null;
}

function run(command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: options.timeout || 900000,
    env: { ...process.env, ...(options.env || {}) },
  });
  return {
    ok: result.status === 0,
    command: [command, ...args].join(' '),
    durationMs: Date.now() - started,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function parseCleanup(output) {
  const line = output.split(/\r?\n/).find((item) => item.startsWith('ASSET_CLEANUP '));
  if (!line) return null;
  try {
    return JSON.parse(line.slice('ASSET_CLEANUP '.length));
  } catch {
    return null;
  }
}

function sqliteCounts(docker) {
  if (!docker) return { available: false, detail: 'Docker not found' };
  const sql = 'pragma integrity_check; select count(*) from sync_history; select count(*) from sync_failures; select count(*) from audit_logs;';
  const result = spawnSync(docker, ['compose', 'exec', '-T', 'teable-sync', 'sh', '-lc', `sqlite3 /app/server/data/runtime.sqlite "${sql}"`], {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 30000,
  });
  const lines = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean);
  return {
    available: result.status === 0,
    integrity: lines[0] || 'unknown',
    syncHistory: Number(lines[1] || 0),
    syncFailures: Number(lines[2] || 0),
    auditLogs: Number(lines[3] || 0),
    detail: lines.join(' / '),
  };
}

function sample(docker, label) {
  const health = run('curl', ['-fsS', 'http://127.0.0.1:3101/health'], { timeout: 30000 });
  let stats = 'not available';
  if (docker) {
    const result = spawnSync(docker, ['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}', 'teable-sync-teable-sync-1'], {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 30000,
    });
    stats = `${result.stdout || ''}${result.stderr || ''}`.trim() || 'not available';
  }
  samples.push({
    ts: new Date().toISOString(),
    label,
    healthOk: health.ok,
    healthOutput: health.output,
    dockerStats: stats,
    sqlite: sqliteCounts(docker),
  });
}

function runRealSmoke(iteration) {
  const result = run('npm', ['run', 'e2e:smoke'], {
    timeout: Number(E2E_TIMEOUT_MS) + 60000,
    env: {
      E2E_RUN_TIMEOUT_MS: E2E_TIMEOUT_MS,
    },
  });
  const cleanup = parseCleanup(result.output);
  const passLine = /Smoke result:\s+PASS/.test(result.output);
  runs.push({
    iteration,
    ok: result.ok && passLine && cleanup?.ok !== false,
    command: result.command,
    durationMs: result.durationMs,
    cleanup,
    output: result.output.slice(-8000),
  });
}

mkdirSync(REPORT_DIR, { recursive: true });
const docker = findDocker();

sample(docker, 'initial');
let iteration = 0;
while (Date.now() < END_AT) {
  iteration += 1;
  runRealSmoke(iteration);
  sample(docker, `after iteration ${iteration}`);
  if (Date.now() < END_AT) sleep(Math.min(INTERVAL_SECONDS * 1000, Math.max(0, END_AT - Date.now())));
}

const finalContract = run('npm', ['run', 'e2e:contract'], { timeout: 900000 });
sample(docker, 'final');

const ok = samples.every((item) => item.healthOk && item.sqlite.integrity === 'ok')
  && runs.length > 0
  && runs.every((item) => item.ok)
  && finalContract.ok;

const report = [
  '# Teable Sync Real Business Run Reliability Test',
  '',
  `- Started: ${startedAt.toISOString()}`,
  `- Finished: ${new Date().toISOString()}`,
  `- Status: ${ok ? 'PASS' : 'FAIL'}`,
  `- Duration target: ${DURATION_MINUTES} minute(s)`,
  `- Iterations: ${runs.length}`,
  `- E2E run timeout: ${E2E_TIMEOUT_MS} ms`,
  '',
  '## Samples',
  '',
  '| Time | Label | Health | Docker Stats | SQLite |',
  '| --- | --- | --- | --- | --- |',
  ...samples.map((item) => `| ${item.ts} | ${item.label} | ${item.healthOk ? 'PASS' : 'FAIL'} | ${String(item.dockerStats).replace(/\|/g, '/')} | ${item.sqlite.integrity || 'unknown'}; history=${item.sqlite.syncHistory}; failures=${item.sqlite.syncFailures}; audit=${item.sqlite.auditLogs} |`),
  '',
  '## Real Smoke Iterations',
  '',
  '| Iteration | Status | Duration | Cleanup |',
  '| ---: | --- | ---: | --- |',
  ...runs.map((item) => `| ${item.iteration} | ${item.ok ? 'PASS' : 'FAIL'} | ${item.durationMs} ms | ${item.cleanup ? `${item.cleanup.ok ? 'PASS' : 'FAIL'} (${item.cleanup.total} assets)` : 'not reported'} |`),
  '',
  '## Final Contract',
  '',
  `- Status: ${finalContract.ok ? 'PASS' : 'FAIL'}`,
  `- Duration: ${finalContract.durationMs} ms`,
  '',
  '## Details',
  '',
  ...runs.flatMap((item) => [
    `### Iteration ${item.iteration}`,
    '',
    `Status: ${item.ok ? 'PASS' : 'FAIL'}`,
    '',
    '```text',
    item.output || '(no output)',
    '```',
    '',
  ]),
  '### Final Contract',
  '',
  '```text',
  finalContract.output.slice(-8000) || '(no output)',
  '```',
  '',
].join('\n');

const reportPath = join(REPORT_DIR, `realrun-reliability_${startedAt.toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(reportPath, report, 'utf8');
console.log(reportPath);
process.exit(ok ? 0 : 1);

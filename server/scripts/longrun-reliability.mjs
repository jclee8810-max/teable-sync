#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const startedAt = new Date();
const ROOT = process.cwd();
const REPORT_DIR = join(ROOT, 'server', 'data', 'reports');
const DURATION_MINUTES = Math.max(1, Number(process.env.LONGRUN_MINUTES || 15));
const INTERVAL_SECONDS = Math.max(5, Number(process.env.LONGRUN_INTERVAL_SECONDS || 30));
const SIZES = process.env.LONGRUN_STRESS_SIZES || '1000,10000,100000';
const END_AT = Date.now() + DURATION_MINUTES * 60 * 1000;
const steps = [];
const samples = [];

function runStep(name, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8', timeout: options.timeout || 600000, env: { ...process.env, ...(options.env || {}) } });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const step = {
    name,
    ok: result.status === 0,
    command: [command, ...args].join(' '),
    durationMs: Date.now() - started,
    output: output.slice(-5000),
  };
  steps.push(step);
  return step;
}

function findDocker() {
  const candidates = [process.env.DOCKER_BIN, 'docker', '/Applications/Docker.app/Contents/Resources/bin/docker'].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue;
    const result = spawnSync(candidate, ['version'], { stdio: 'ignore' });
    if (result.status === 0) return candidate;
  }
  return null;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sample(docker) {
  const health = runStep('Health sample', 'curl', ['-fsS', 'http://127.0.0.1:3101/health'], { timeout: 30000 });
  let stats = null;
  if (docker) {
    const result = spawnSync(docker, ['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'], { stdio: 'pipe', encoding: 'utf8', timeout: 30000 });
    stats = `${result.stdout || ''}${result.stderr || ''}`.trim();
  }
  samples.push({
    ts: new Date().toISOString(),
    healthOk: health.ok,
    healthOutput: health.output,
    dockerStats: stats || 'not available',
  });
}

mkdirSync(REPORT_DIR, { recursive: true });
const docker = findDocker();

runStep('Initial release gate', 'npm', ['run', 'check:release'], { timeout: 900000 });
runStep('Initial fault acceptance with Docker restart', 'npm', ['run', 'acceptance:fault'], { env: { FAULT_DOCKER_RESTART: 'true' }, timeout: 900000 });

let iteration = 0;
while (Date.now() < END_AT) {
  iteration += 1;
  sample(docker);
  runStep(`Longrun stress iteration ${iteration}`, 'npm', ['run', 'stress:e2e'], {
    env: { STRESS_SIZES: SIZES },
    timeout: 900000,
  });
  if (Date.now() < END_AT) sleep(Math.min(INTERVAL_SECONDS * 1000, Math.max(0, END_AT - Date.now())));
}

sample(docker);
runStep('Final API contract', 'npm', ['run', 'e2e:contract'], { timeout: 900000 });
runStep('Final fault acceptance', 'npm', ['run', 'acceptance:fault'], { timeout: 900000 });

const requiredStepsOk = steps.every((step) => step.ok);
const samplesOk = samples.every((item) => item.healthOk);
const ok = requiredStepsOk && samplesOk;
const report = [
  '# Teable Sync Longrun Reliability Test',
  '',
  `- Started: ${startedAt.toISOString()}`,
  `- Finished: ${new Date().toISOString()}`,
  `- Status: ${ok ? 'PASS' : 'FAIL'}`,
  `- Duration target: ${DURATION_MINUTES} minute(s)`,
  `- Stress sizes: ${SIZES}`,
  `- Samples: ${samples.length}`,
  '',
  '## Samples',
  '',
  '| Time | Health | Docker Stats |',
  '| --- | --- | --- |',
  ...samples.map((item) => `| ${item.ts} | ${item.healthOk ? 'PASS' : 'FAIL'} | ${String(item.dockerStats).replace(/\|/g, '/')} |`),
  '',
  '## Steps',
  '',
  '| Step | Status | Duration | Command |',
  '| --- | --- | ---: | --- |',
  ...steps.map((step) => `| ${step.name} | ${step.ok ? 'PASS' : 'FAIL'} | ${step.durationMs} ms | \`${step.command.replace(/`/g, '')}\` |`),
  '',
  '## Details',
  '',
  ...steps.flatMap((step) => [
    `### ${step.name}`,
    '',
    `Status: ${step.ok ? 'PASS' : 'FAIL'}`,
    '',
    '```text',
    step.output || '(no output)',
    '```',
    '',
  ]),
].join('\n');

const reportPath = join(REPORT_DIR, `longrun-reliability_${startedAt.toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(reportPath, report, 'utf8');
console.log(reportPath);
process.exit(ok ? 0 : 1);

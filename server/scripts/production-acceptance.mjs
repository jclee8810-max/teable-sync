#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const startedAt = new Date();
const REPORT_DIR = join(process.cwd(), 'server', 'data', 'reports');
const results = [];

function runStep(name, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const ok = result.status === 0;
  results.push({
    name,
    ok,
    required: options.required !== false,
    command: [command, ...args].join(' '),
    durationMs: Date.now() - started,
    output: output.slice(-8000),
  });
  if (!ok && options.required !== false) throw new Error(`${name} failed`);
  return result;
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

function latestReportPath(output) {
  return output.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith('.md')).pop() || '';
}

function assetCleanupSummary() {
  for (const result of results) {
    const line = result.output.split(/\r?\n/).find((item) => item.startsWith('ASSET_CLEANUP '));
    if (!line) continue;
    try {
      return JSON.parse(line.slice('ASSET_CLEANUP '.length));
    } catch {
      return null;
    }
  }
  return null;
}

function imageVerificationSummary() {
  const result = results.find((item) => item.name === 'Image release verification');
  if (!result) return null;
  const reportPath = latestReportPath(result.output);
  const warned = /\bStatus:\s+WARN\b/.test(result.output) || /\bWARN\b/.test(result.output);
  return {
    ok: result.ok && !warned,
    warned,
    required: result.required,
    reportPath,
  };
}

function renderReport(exitCode) {
  const finishedAt = new Date();
  const passed = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok).length;
  const status = exitCode === 0 ? 'PASS' : 'FAIL';
  const cleanup = assetCleanupSummary();
  const image = imageVerificationSummary();
  return [
    '# Teable Sync Production Acceptance',
    '',
    `- Started: ${startedAt.toISOString()}`,
    `- Finished: ${finishedAt.toISOString()}`,
    `- Status: ${status}`,
    `- Steps: ${passed} passed, ${failed} failed`,
    '',
    '| Step | Status | Required | Duration | Command |',
    '| --- | --- | --- | ---: | --- |',
    ...results.map((item) => `| ${item.name} | ${item.ok ? 'PASS' : 'FAIL'} | ${item.required ? 'yes' : 'no'} | ${item.durationMs} ms | \`${item.command.replace(/`/g, '')}\` |`),
    '',
    '## Included Coverage',
    '',
    '- Release gate: syntax, reliability self-test, readiness estimate, frontend build, Docker status, health, API contract.',
    '- Real business smoke: users, permissions, shared connection sanitization, private data source creation/test, task creation, preview, run, reconciliation, audit and backup visibility.',
    '- Large sync pressure simulation: first full sync, checkpoint resume, cancel/continue, idempotent replay.',
    '- Configuration migration: sanitized export and import preview are covered by release/API contract checks.',
    '- Alert notification permissions and webhook payload contract are covered by release/API contract checks.',
    '- Published image verification checks GitHub Actions, GHCR latest manifest, and Docker pull when network access allows.',
    '',
    '## Test Asset Cleanup',
    '',
    cleanup
      ? `- Status: ${cleanup.ok ? 'PASS' : 'FAIL'}`
      : '- Status: not reported',
    cleanup
      ? `- Assets processed: ${cleanup.total}, failed: ${cleanup.failed}`
      : '- Assets processed: unknown',
    cleanup?.leftovers?.length
      ? `- Leftovers: ${cleanup.leftovers.map((item) => `${item.type}:${item.name || item.id || 'unknown'}`).join(', ')}`
      : '- Leftovers: none',
    '',
    '## Published Image',
    '',
    image
      ? `- Status: ${image.ok ? 'PASS' : 'WARN'}`
      : '- Status: not run',
    image?.reportPath
      ? `- Report: ${image.reportPath}`
      : '- Report: none',
    '- Note: image verification is non-blocking in production acceptance; run `IMAGE_VERIFY_STRICT=true npm run verify:image` to make it a hard gate.',
    '',
    '## Details',
    '',
    ...results.flatMap((item) => [
      `### ${item.name}`,
      '',
      `Status: ${item.ok ? 'PASS' : 'FAIL'}`,
      '',
      '```text',
      item.output || '(no output)',
      '```',
      '',
    ]),
  ].join('\n');
}

let exitCode = 0;
try {
  runStep('Git diff whitespace check', 'git', ['diff', '--check']);
  const docker = findDocker();
  if (!docker) throw new Error('Docker CLI not found');
  runStep('Docker service status', docker, ['compose', 'ps']);
  runStep('API health', 'curl', ['-fsS', 'http://127.0.0.1:3101/health']);
  runStep('Release gate', 'npm', ['run', 'check:release']);
  runStep('Real business smoke', 'npm', ['run', 'e2e:smoke']);
  const stressSizes = process.env.ACCEPTANCE_STRESS_SIZES || '1000,10000,100000';
  runStep('Large sync stress', 'npm', ['run', 'stress:e2e'], {
    env: { ...process.env, STRESS_SIZES: stressSizes },
  });
  runStep('Image release verification', 'npm', ['run', 'verify:image'], { required: false });
} catch (err) {
  exitCode = 1;
  results.push({ name: 'Production acceptance', ok: false, required: true, command: '-', durationMs: 0, output: err.message });
}

mkdirSync(REPORT_DIR, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const reportPath = join(REPORT_DIR, `production-acceptance_${stamp}.md`);
const report = renderReport(exitCode);
writeFileSync(reportPath, report, 'utf8');

const relatedReports = results
  .map((item) => latestReportPath(item.output))
  .filter(Boolean);
if (relatedReports.length) {
  console.log('Related reports:');
  for (const path of relatedReports) console.log(path);
}
console.log(reportPath);
process.exit(exitCode);

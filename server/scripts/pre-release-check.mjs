#!/usr/bin/env node
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const startedAt = new Date();
const results = [];

function runStep(name, command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options });
  const ok = result.status === 0;
  results.push({
    name,
    ok,
    command: [command, ...args].join(' '),
    output: `${result.stdout || ''}${result.stderr || ''}`.trim().slice(-4000),
  });
  if (!ok && options.required !== false) {
    throw new Error(`${name} failed`);
  }
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

let exitCode = 0;
try {
  runStep('Git diff whitespace check', 'git', ['diff', '--check']);
  runStep('Server entry syntax check', 'node', ['--check', 'server/src/index.js']);
  runStep('Sync engine syntax check', 'node', ['--check', 'server/src/services/syncEngine.js']);
  runStep('Sync reliability self-test', 'npm', ['run', 'test:reliability']);
  runStep('Task UI state self-test', 'npm', ['run', 'test:ui-state']);
  runStep('Connection health self-test', 'npm', ['run', 'test:connection-health']);
  runStep('Error guidance self-test', 'npm', ['run', 'test:error-guidance']);
  runStep('Runtime store self-test', 'npm', ['run', 'test:runtime-store']);
  runStep('Test environment self-test', 'npm', ['run', 'test:environment']);
  runStep('Large initial sync readiness', 'npm', ['run', 'stress:readiness']);
  runStep('Frontend build', 'npm', ['run', 'build']);

  const docker = findDocker();
  if (!docker) throw new Error('Docker CLI not found');
  runStep('Docker compose config', docker, ['compose', 'config', '--quiet']);
  runStep('Docker service status', docker, ['compose', 'ps']);
  runStep('API health', 'curl', ['-fsS', 'http://127.0.0.1:3101/health']);
  runStep('API version', 'curl', ['-fsS', 'http://127.0.0.1:3101/api/version']);
  runStep('API contract smoke', 'npm', ['run', 'e2e:contract']);
  runStep('Security audit', 'npm', ['run', 'audit:security']);
  runStep('Backup restore rehearsal', 'npm', ['run', 'backup:rehearse']);
  runStep('SQLite shadow migration', 'npm', ['run', 'storage:sqlite:shadow']);
  runStep('Onboarding path check', 'npm', ['run', 'check:onboarding']);
  runStep('Production acceptance script syntax', 'node', ['--check', 'server/scripts/production-acceptance.mjs']);
  runStep('Fault injection acceptance syntax', 'node', ['--check', 'server/scripts/fault-injection-acceptance.mjs']);
  runStep('Image verification script syntax', 'node', ['--check', 'server/scripts/verify-image-release.mjs']);
  runStep('Image fallback script syntax', 'node', ['--check', 'server/scripts/image-pull-fallback.mjs']);
  runStep('Longrun script syntax', 'node', ['--check', 'server/scripts/longrun-reliability.mjs']);
  runStep('Auto resume log check', docker, ['compose', 'logs', '--tail=80', 'teable-sync'], { required: false });
  runStep('GitHub Actions workflow exists', 'test', ['-f', '.github/workflows/docker-publish.yml']);
} catch (err) {
  exitCode = 1;
  results.push({ name: 'Pre-release check', ok: false, command: '-', output: err.message });
}

const reportDir = join(process.cwd(), 'server', 'data', 'reports');
mkdirSync(reportDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const reportPath = join(reportDir, `pre-release-check_${stamp}.md`);
const lines = [
  '# Teable Sync Pre-release Check',
  '',
  `- Started: ${startedAt.toISOString()}`,
  `- Finished: ${new Date().toISOString()}`,
  `- Status: ${exitCode === 0 ? 'PASS' : 'FAIL'}`,
  '',
  '| Step | Status | Command |',
  '| --- | --- | --- |',
  ...results.map((item) => `| ${item.name} | ${item.ok ? 'PASS' : 'FAIL'} | \`${item.command.replace(/`/g, '')}\` |`),
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
];
writeFileSync(reportPath, lines.join('\n'), 'utf8');
console.log(reportPath);
process.exit(exitCode);

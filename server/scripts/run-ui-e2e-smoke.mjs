#!/usr/bin/env node
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', encoding: 'utf8', ...options });
  if (result.status !== 0) process.exit(result.status || 1);
  return result;
}

function optional(command, args, options = {}) {
  return spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options });
}

function findDocker() {
  for (const candidate of [process.env.DOCKER_BIN, 'docker', '/Applications/Docker.app/Contents/Resources/bin/docker'].filter(Boolean)) {
    if (candidate.includes('/') && !existsSync(candidate)) continue;
    if (optional(candidate, ['version']).status === 0) return candidate;
  }
  return null;
}

const docker = findDocker();
if (!docker) {
  console.error('Cannot find Docker CLI. Set DOCKER_BIN=/path/to/docker and retry.');
  process.exit(1);
}

try {
  await import('playwright');
} catch {
  console.error('Playwright is not installed. Run: npm install');
  process.exit(1);
}

const fixtureResult = optional(docker, ['compose', 'exec', '-T', 'teable-sync', 'sh', '-lc', 'cd /app/server && node scripts/ui-e2e-fixture.mjs setup']);
if (fixtureResult.status !== 0) {
  process.stderr.write(fixtureResult.stderr || fixtureResult.stdout || 'Failed to seed UI E2E fixture\n');
  process.exit(fixtureResult.status || 1);
}

try {
  run('node', ['server/scripts/ui-e2e-smoke.mjs']);
} finally {
  optional(docker, ['compose', 'exec', '-T', 'teable-sync', 'sh', '-lc', 'cd /app/server && node scripts/ui-e2e-fixture.mjs cleanup']);
}

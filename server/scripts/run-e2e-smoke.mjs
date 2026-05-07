#!/usr/bin/env node
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';

const candidates = [
  process.env.DOCKER_BIN,
  'docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
].filter(Boolean);

let dockerBin = null;
for (const candidate of candidates) {
  if (candidate.includes('/') && !existsSync(candidate)) continue;
  const result = spawnSync(candidate, ['version'], { stdio: 'ignore' });
  if (result.status === 0) {
    dockerBin = candidate;
    break;
  }
}

if (!dockerBin) {
  console.error('Cannot find Docker CLI. Set DOCKER_BIN=/path/to/docker and retry.');
  process.exit(1);
}

const result = spawnSync(dockerBin, [
  'compose',
  'exec',
  '-T',
  'teable-sync',
  'sh',
  '-lc',
  'cd /app/server && node scripts/e2e-smoke.mjs',
], { stdio: 'inherit' });

process.exit(result.status ?? 1);

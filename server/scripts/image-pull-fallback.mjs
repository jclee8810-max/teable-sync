#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const startedAt = new Date();
const REPORT_DIR = join(process.cwd(), 'server', 'data', 'reports');
const RELEASE_DIR = join(process.cwd(), 'server', 'data', 'releases');
const IMAGE = process.env.IMAGE_PULL_FALLBACK_IMAGE || 'ghcr.io/jclee8810-max/teable-sync:latest';
const LOCAL_IMAGE = process.env.IMAGE_PULL_FALLBACK_LOCAL_IMAGE || 'teable-sync-teable-sync:latest';
const RETRIES = Math.max(1, Math.floor(Number(process.env.IMAGE_PULL_FALLBACK_RETRIES || 3)));
const BUILD_ON_FAILURE = process.env.IMAGE_PULL_FALLBACK_BUILD !== 'false';
const SAVE_TAR = process.env.IMAGE_PULL_FALLBACK_SAVE_TAR === 'true';

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
  const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8', timeout: options.timeout || 600000, ...options });
  return {
    ok: result.status === 0,
    command: [command, ...args].join(' '),
    output: `${result.stdout || ''}${result.stderr || ''}`.trim().slice(-4000),
  };
}

mkdirSync(REPORT_DIR, { recursive: true });
mkdirSync(RELEASE_DIR, { recursive: true });
const docker = findDocker();
const steps = [];
let pulled = false;
let built = false;
let tarPath = '';

if (!docker) {
  steps.push({ ok: false, name: 'Find Docker CLI', command: '-', output: 'Docker CLI not found' });
} else {
  steps.push({ ok: true, name: 'Find Docker CLI', command: docker, output: docker });
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    const step = run(docker, ['pull', IMAGE], { timeout: 120000 });
    steps.push({ ...step, name: `Pull published image attempt ${attempt}/${RETRIES}` });
    if (step.ok) {
      pulled = true;
      break;
    }
  }
  if (!pulled && BUILD_ON_FAILURE) {
    const build = run(docker, ['compose', 'build', 'teable-sync'], { timeout: 900000 });
    steps.push({ ...build, name: 'Build local fallback image' });
    built = build.ok;
  }
  if ((pulled || built) && SAVE_TAR) {
    tarPath = join(RELEASE_DIR, `teable-sync-image_${startedAt.toISOString().replace(/[:.]/g, '-')}.tar`);
    const save = run(docker, ['save', '-o', tarPath, pulled ? IMAGE : LOCAL_IMAGE], { timeout: 900000 });
    steps.push({ ...save, name: 'Save image tarball' });
    if (!save.ok) tarPath = '';
  }
}

const ok = pulled || built;
const report = [
  '# Teable Sync Image Pull Fallback',
  '',
  `- Started: ${startedAt.toISOString()}`,
  `- Finished: ${new Date().toISOString()}`,
  `- Status: ${ok ? 'PASS' : 'FAIL'}`,
  `- Published image: ${IMAGE}`,
  `- Local fallback image: ${LOCAL_IMAGE}`,
  `- Pull retries: ${RETRIES}`,
  `- Pulled published image: ${pulled ? 'yes' : 'no'}`,
  `- Built local fallback image: ${built ? 'yes' : 'no'}`,
  tarPath ? `- Saved tarball: ${tarPath}` : '- Saved tarball: no',
  '',
  '## Steps',
  '',
  '| Step | Status | Command |',
  '| --- | --- | --- |',
  ...steps.map((step) => `| ${step.name} | ${step.ok ? 'PASS' : 'FAIL'} | \`${step.command.replace(/`/g, '')}\` |`),
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

const reportPath = join(REPORT_DIR, `image-pull-fallback_${startedAt.toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(reportPath, report, 'utf8');
console.log(reportPath);
process.exit(ok ? 0 : 1);

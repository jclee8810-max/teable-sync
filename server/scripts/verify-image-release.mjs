#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const startedAt = new Date();
const REPORT_DIR = join(process.cwd(), 'server', 'data', 'reports');
const OWNER = process.env.IMAGE_VERIFY_OWNER || 'jclee8810-max';
const REPO = process.env.IMAGE_VERIFY_REPO || 'teable-sync';
const WORKFLOW = process.env.IMAGE_VERIFY_WORKFLOW || 'docker-publish.yml';
const IMAGE = process.env.IMAGE_VERIFY_IMAGE || `ghcr.io/${OWNER}/${REPO}:latest`;
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const PULL_RETRIES = Math.max(1, Math.floor(Number(process.env.IMAGE_VERIFY_PULL_RETRIES || 3)));
const softMode = process.env.IMAGE_VERIFY_STRICT !== 'true';
const checks = [];
let hasWarning = false;

function record(ok, name, detail = '', required = false) {
  if (!ok) hasWarning = true;
  checks.push({ ok, name, detail, required });
  console.log(`${ok ? 'PASS' : 'WARN'} ${name}${detail ? ` - ${detail}` : ''}`);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'teable-sync-image-verify',
      ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${url} returned ${res.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  return data;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkWorkflow() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=main&per_page=1`;
  const data = await fetchJson(url);
  const run = data.workflow_runs?.[0];
  if (!run) throw new Error('No workflow runs found');
  const ok = run.status === 'completed' && run.conclusion === 'success';
  record(ok, 'GitHub Actions Docker workflow', `${run.status}/${run.conclusion || 'n/a'} · ${run.html_url}`, true);
  return ok;
}

async function checkRegistryManifest() {
  const tokenUrl = `https://ghcr.io/token?service=ghcr.io&scope=repository:${OWNER}/${REPO}:pull`;
  const tokenData = await fetchJson(tokenUrl, { headers: { Accept: 'application/json' } });
  const res = await fetch(`https://ghcr.io/v2/${OWNER}/${REPO}/manifests/latest`, {
    headers: {
      Authorization: `Bearer ${tokenData.token}`,
      Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json',
    },
  });
  const digest = res.headers.get('docker-content-digest') || '';
  const ok = res.ok && Boolean(digest);
  record(ok, 'GHCR latest manifest', ok ? digest : `status ${res.status}`, true);
  if (!ok) throw new Error(`GHCR latest manifest unavailable: ${res.status}`);
  return digest;
}

async function checkDockerPull() {
  const docker = findDocker();
  if (!docker) {
    record(false, 'Docker pull latest image', 'Docker CLI not found', false);
    return false;
  }

  let lastOutput = '';
  for (let attempt = 1; attempt <= PULL_RETRIES; attempt += 1) {
    const result = spawnSync(docker, ['pull', IMAGE], { stdio: 'pipe', encoding: 'utf8', timeout: 120000 });
    lastOutput = `${result.stdout || ''}${result.stderr || ''}`.trim().slice(-2000);
    if (result.status === 0) {
      record(true, 'Docker pull latest image', `attempt ${attempt}/${PULL_RETRIES}: ${lastOutput || IMAGE}`, true);
      return true;
    }
    if (attempt < PULL_RETRIES) await sleep(Math.min(30000, attempt * 5000));
  }

  record(false, 'Docker pull latest image', `failed after ${PULL_RETRIES} attempts: ${lastOutput}`, true);
  throw new Error(`docker pull failed after ${PULL_RETRIES} attempts: ${lastOutput}`);
}

function renderReport(exitCode) {
  const status = exitCode === 0 && !hasWarning ? 'PASS' : softMode ? 'WARN' : 'FAIL';
  return [
    '# Teable Sync Image Release Verification',
    '',
    `- Started: ${startedAt.toISOString()}`,
    `- Finished: ${new Date().toISOString()}`,
    `- Status: ${status}`,
    `- Image: ${IMAGE}`,
    `- Workflow: ${OWNER}/${REPO}/${WORKFLOW}`,
    `- Strict: ${process.env.IMAGE_VERIFY_STRICT === 'true' ? 'true' : 'false'}`,
    `- Docker pull retries: ${PULL_RETRIES}`,
    '',
    '| Check | Status | Required | Detail |',
    '| --- | --- | --- | --- |',
    ...checks.map((item) => `| ${item.name} | ${item.ok ? 'PASS' : 'WARN'} | ${item.required ? 'yes' : 'no'} | ${String(item.detail || '').replace(/\|/g, '/') } |`),
    '',
  ].join('\n');
}

let exitCode = 0;
try {
  await checkWorkflow();
  await checkRegistryManifest();
  await checkDockerPull();
} catch (err) {
  exitCode = softMode ? 0 : 1;
  record(false, 'Image release verification', err.message, !softMode);
}

mkdirSync(REPORT_DIR, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const reportPath = join(REPORT_DIR, `image-release-verify_${stamp}.md`);
writeFileSync(reportPath, renderReport(exitCode), 'utf8');
console.log(reportPath);
process.exit(exitCode);

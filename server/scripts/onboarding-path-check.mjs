#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const startedAt = new Date();
const ROOT = process.cwd();
const REPORT_DIR = join(ROOT, 'server', 'data', 'reports');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const checks = [];

function add(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function has(pattern) {
  return pattern.test(README);
}

mkdirSync(REPORT_DIR, { recursive: true });

add('One-command image deployment exists', has(/ghcr\.io\/jclee8810-max\/teable-sync:latest/) && has(/docker compose pull/) && has(/docker compose up -d/), 'README should let non-developers pull and run the published image.');
add('LAN multi-user URL guidance exists', has(/192\.168\.10\.2:3101/) && has(/SERVER_PUBLIC_URL/) && has(/FRONTEND_BASE_URL/), 'README should explain LAN URLs and OAuth callback URLs.');
add('Environment variable table exists', has(/\| `JWT_SECRET` \|/) && has(/\| `CONFIG_ENCRYPTION_KEY` \|/) && has(/\| `INITIALIZATION_CONCURRENCY` \|/), 'README should explain security and reliability env vars.');
add('Data source creation flow exists', has(/创建数据源/) && has(/测试连接/), 'README should describe creating and testing data sources.');
add('Task creation flow exists', has(/创建同步任务/) && has(/字段映射/) && has(/预检/), 'README should describe connection, table, mapping, preflight, save/run.');
add('Observability and alert notification flow exists', has(/观测告警/) && has(/Webhook/) && has(/告警/), 'README should explain alert dashboard and notification channel.');
add('Backup and migration flow exists', has(/导出/) && has(/导入/) && has(/密钥/), 'README should explain config export/import and secret package restrictions.');
add('Reliability verification commands exist', has(/acceptance:prod/) && has(/acceptance:fault/) && has(/stress:e2e/), 'README should include release and stress validation commands.');

const ok = checks.every((check) => check.ok);
const report = [
  '# Teable Sync Onboarding Path Check',
  '',
  `- Started: ${startedAt.toISOString()}`,
  `- Finished: ${new Date().toISOString()}`,
  `- Status: ${ok ? 'PASS' : 'FAIL'}`,
  '',
  '| Check | Status | Detail |',
  '| --- | --- | --- |',
  ...checks.map((check) => `| ${check.name} | ${check.ok ? 'PASS' : 'FAIL'} | ${check.detail} |`),
  '',
].join('\n');

const reportPath = join(REPORT_DIR, `onboarding-path-check_${startedAt.toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(reportPath, report, 'utf8');
console.log(reportPath);
process.exit(ok ? 0 : 1);

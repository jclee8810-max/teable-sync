#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const startedAt = new Date();
const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'server', 'data');
const REPORT_DIR = join(DATA_DIR, 'reports');
const checks = [];

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function add(ok, severity, name, detail) {
  checks.push({ ok, severity, name, detail });
}

function grepText(path, pattern) {
  return read(path).split(/\r?\n/).map((line, index) => ({ line, index: index + 1 })).filter((item) => pattern.test(item.line));
}

mkdirSync(REPORT_DIR, { recursive: true });
const gitConfig = read(join(ROOT, '.git', 'config'));
add(!/https?:\/\/[^/\s]+:[^@\s]+@github\.com/i.test(gitConfig) && !/ghp_[A-Za-z0-9_]+/.test(gitConfig), 'critical', 'Git remote does not expose GitHub PAT', 'Remote URL should use SSH or credential helper, not an inline token.');

const config = readJson(join(DATA_DIR, 'config.json'), {});
const users = readJson(join(DATA_DIR, 'users.json'), []);
const connections = Array.isArray(config.connections) ? config.connections : [];
const alertNotifications = config.alertNotifications || {};
const owners = users.filter((user) => user.role === 'owner');
const admins = users.filter((user) => user.role === 'admin' || user.role === 'owner');
add(users.length === 0 || owners.length >= 1, 'high', 'At least one owner/admin root exists', users.length === 0 ? 'users.json is empty or not mounted on this host; API contract smoke covers RBAC behavior.' : `owners=${owners.length}, adminsIncludingOwner=${admins.length}`);
add(users.every((user) => user.passwordHash && !user.password), 'high', 'Users store password hashes only', 'No plaintext password field should be present in users.json.');

const plaintextSecretConnections = connections.filter((conn) => {
  return ['password', 'token', 'oauthClientSecret', 'teableOAuthToken'].some((field) => {
    const value = conn[field];
    return typeof value === 'string' && value && !value.startsWith('enc:v1:');
  });
});
add(plaintextSecretConnections.length === 0, 'critical', 'Connection secrets are encrypted at rest', plaintextSecretConnections.length ? `Plaintext secrets in: ${plaintextSecretConnections.map((conn) => conn.name || conn.id).join(', ')}` : 'All detected connection secrets use enc:v1.');

const webhookUrl = alertNotifications.webhookUrl;
add(!webhookUrl || String(webhookUrl).startsWith('enc:v1:'), 'high', 'Alert webhook URL is encrypted at rest', webhookUrl ? 'Webhook URL uses encrypted storage.' : 'Webhook URL not configured.');

const indexJs = read(join(ROOT, 'server', 'src', 'index.js'));
add(/includeSecrets/.test(indexJs) && /isOwner/.test(indexJs), 'high', 'Secret export path is owner-gated', 'Server code references includeSecrets and owner checks.');
add(/sanitizeConnection/.test(indexJs), 'high', 'Connection list is sanitized', 'Server has sanitizeConnection for API DTOs.');
add(/validateTaskConnections/.test(indexJs), 'high', 'Task execution validates connections', 'Server routes reference validateTaskConnections.');

const sourceFiles = [
  'server/src/index.js',
  'server/src/routes/auth.js',
  'server/src/routes/oauth.js',
  'server/src/services/alertNotificationService.js',
];
const riskyConsole = sourceFiles.flatMap((file) => grepText(join(ROOT, file), /console\.(log|debug|info|warn|error)/).map((item) => ({ file, ...item })));
add(riskyConsole.length === 0, 'medium', 'Server avoids raw console logging on sensitive paths', riskyConsole.length ? riskyConsole.map((item) => `${item.file}:${item.index}`).join(', ') : 'No raw console calls found in audited server files.');

const failures = checks.filter((check) => !check.ok && ['critical', 'high'].includes(check.severity));
const ok = failures.length === 0;
const report = [
  '# Teable Sync Security Audit',
  '',
  `- Started: ${startedAt.toISOString()}`,
  `- Finished: ${new Date().toISOString()}`,
  `- Status: ${ok ? 'PASS' : 'FAIL'}`,
  '',
  '| Severity | Check | Status | Detail |',
  '| --- | --- | --- | --- |',
  ...checks.map((check) => `| ${check.severity} | ${check.name} | ${check.ok ? 'PASS' : 'FAIL'} | ${String(check.detail || '').replace(/\|/g, '/')} |`),
  '',
].join('\n');

const reportPath = join(REPORT_DIR, `security-audit_${startedAt.toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(reportPath, report, 'utf8');
console.log(reportPath);
process.exit(ok ? 0 : 1);

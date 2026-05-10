#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { basename, join } from 'path';

const startedAt = new Date();
const ROOT = process.cwd();
const DATA_DIR = process.env.BACKUP_DATA_DIR || join(ROOT, 'server', 'data');
const REPORT_DIR = join(DATA_DIR, 'reports');
const REHEARSAL_DIR = join(DATA_DIR, 'backup-rehearsals', startedAt.toISOString().replace(/[:.]/g, '-'));
const BACKUP_DIR = join(REHEARSAL_DIR, 'backup');
const RESTORE_DIR = join(REHEARSAL_DIR, 'restore');
const FILES = [
  'config.json',
  'users.json',
  'sync-history.json',
  'sync-failures.json',
  'sync-state',
  'audit-logs.json',
];

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listFiles(path, prefix = '') {
  if (!existsSync(path)) return [];
  const stats = statSync(path);
  if (stats.isFile()) return [{ source: path, relative: prefix || basename(path), size: stats.size, hash: hashFile(path) }];
  if (!stats.isDirectory()) return [];
  return readdirSync(path).flatMap((entry) => listFiles(join(path, entry), prefix ? join(prefix, entry) : entry));
}

function copyRecursive(src, dest) {
  if (!existsSync(src)) return;
  const stats = statSync(src);
  if (stats.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src)) copyRecursive(join(src, entry), join(dest, entry));
    return;
  }
  mkdirSync(join(dest, '..'), { recursive: true });
  copyFileSync(src, dest);
}

function readJsonSafe(path) {
  if (!existsSync(path)) return { ok: true, missing: true };
  try {
    JSON.parse(readFileSync(path, 'utf8'));
    return { ok: true, missing: false };
  } catch (err) {
    return { ok: false, missing: false, error: err.message };
  }
}

mkdirSync(BACKUP_DIR, { recursive: true });
mkdirSync(RESTORE_DIR, { recursive: true });
mkdirSync(REPORT_DIR, { recursive: true });

const copied = [];
const skipped = [];
for (const item of FILES) {
  const src = join(DATA_DIR, item);
  if (!existsSync(src)) {
    skipped.push(item);
    continue;
  }
  copyRecursive(src, join(BACKUP_DIR, item));
  copyRecursive(join(BACKUP_DIR, item), join(RESTORE_DIR, item));
  copied.push(item);
}

const backupFiles = listFiles(BACKUP_DIR).sort((a, b) => a.relative.localeCompare(b.relative));
const restoreFiles = listFiles(RESTORE_DIR).sort((a, b) => a.relative.localeCompare(b.relative));
const restoreByName = new Map(restoreFiles.map((file) => [file.relative, file]));
const mismatches = backupFiles.filter((file) => restoreByName.get(file.relative)?.hash !== file.hash);
const missingRestored = backupFiles.filter((file) => !restoreByName.has(file.relative));
const extraRestored = restoreFiles.filter((file) => !backupFiles.some((backup) => backup.relative === file.relative));
const jsonChecks = ['config.json', 'users.json', 'sync-history.json', 'sync-failures.json', 'audit-logs.json']
  .map((file) => ({ file, ...readJsonSafe(join(RESTORE_DIR, file)) }));
const ok = copied.length > 0
  && mismatches.length === 0
  && missingRestored.length === 0
  && extraRestored.length === 0
  && jsonChecks.every((item) => item.ok);

const report = [
  '# Teable Sync Backup Restore Rehearsal',
  '',
  `- Started: ${startedAt.toISOString()}`,
  `- Finished: ${new Date().toISOString()}`,
  `- Status: ${ok ? 'PASS' : 'FAIL'}`,
  `- Data dir: ${DATA_DIR}`,
  `- Rehearsal dir: ${REHEARSAL_DIR}`,
  '',
  '## Summary',
  '',
  `- Copied entries: ${copied.length ? copied.join(', ') : 'none'}`,
  `- Skipped missing entries: ${skipped.length ? skipped.join(', ') : 'none'}`,
  `- Files verified: ${backupFiles.length}`,
  `- Hash mismatches: ${mismatches.length}`,
  `- Missing restored files: ${missingRestored.length}`,
  `- Extra restored files: ${extraRestored.length}`,
  '',
  '## JSON Parse Check',
  '',
  '| File | Status | Detail |',
  '| --- | --- | --- |',
  ...jsonChecks.map((item) => `| ${item.file} | ${item.ok ? 'PASS' : 'FAIL'} | ${item.missing ? 'missing' : item.error || 'valid JSON'} |`),
  '',
  '## Restore Drill Notes',
  '',
  '- This rehearsal copies the persisted data files into an isolated restore directory and validates byte-level hashes.',
  '- It does not replace the live data volume.',
  '- For a real restore, stop the container, copy the selected backup files back into `server/data`, then start the container and run `npm run check:release`.',
  '',
].join('\n');

const reportPath = join(REPORT_DIR, `backup-restore-rehearsal_${startedAt.toISOString().replace(/[:.]/g, '-')}.md`);
writeFileSync(reportPath, report, 'utf8');
if (process.env.BACKUP_REHEARSAL_KEEP !== 'true') {
  rmSync(REHEARSAL_DIR, { recursive: true, force: true });
}
console.log(reportPath);
process.exit(ok ? 0 : 1);

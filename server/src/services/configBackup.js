import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { basename, dirname, join } from 'path';

const BACKUP_PREFIX = 'config-';
const BACKUP_SUFFIX = '.json';
const MAX_BACKUPS = Number(process.env.CONFIG_BACKUP_LIMIT || 30);

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function backupDirFor(configFile) {
  return join(dirname(configFile), 'backups');
}

function listBackupFiles(configFile) {
  const backupDir = backupDirFor(configFile);
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
    .map((name) => {
      const path = join(backupDir, name);
      const stat = statSync(path);
      return { name, path, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneBackups(configFile, keep = MAX_BACKUPS) {
  const backups = listBackupFiles(configFile);
  for (const backup of backups.slice(Math.max(keep, 1))) {
    unlinkSync(backup.path);
  }
}

export function createConfigBackup(configFile, reason = 'write') {
  if (!existsSync(configFile)) return null;
  const backupDir = backupDirFor(configFile);
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const latest = listBackupFiles(configFile)[0];
  if (latest && readFileSync(latest.path, 'utf-8') === readFileSync(configFile, 'utf-8')) {
    return { name: latest.name, path: latest.path, createdAt: latest.createdAt, reused: true };
  }
  const name = `${BACKUP_PREFIX}${timestampForFile()}-${reason}${BACKUP_SUFFIX}`;
  const path = join(backupDir, name);
  copyFileSync(configFile, path);
  pruneBackups(configFile);
  return { name, path, createdAt: new Date().toISOString() };
}

export function getConfigBackups(configFile, limit = 20) {
  return listBackupFiles(configFile)
    .slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100))
    .map((backup) => ({
      name: backup.name,
      createdAt: backup.createdAt,
      size: backup.size,
    }));
}

export function getConfigBackupStatus(configFile) {
  const backups = listBackupFiles(configFile);
  return {
    count: backups.length,
    latest: backups[0] || null,
    maxBackups: MAX_BACKUPS,
    directory: backupDirFor(configFile),
    configFile: basename(configFile),
  };
}

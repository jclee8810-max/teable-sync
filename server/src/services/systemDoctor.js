import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import { decryptConfigSecrets, isEncryptedSecret } from './secretStore.js';
import { getSyncFailureCounts } from './syncFailures.js';
import { getConfigBackupStatus } from './configBackup.js';

function addCheck(checks, status, title, message, meta = {}) {
  checks.push({ id: crypto.randomUUID(), status, title, message, ...meta });
}

function requiredConnectionFields(conn) {
  if (conn.type === 'teable') return ['name', 'type', 'host'];
  if (conn.type === 'mssql' || conn.type === 'mysql' || conn.type === 'pg') return ['name', 'type', 'host', 'database'];
  return ['name', 'type'];
}

export function runSystemDoctor({ dataDir, configFile, config }) {
  const checks = [];

  if (process.env.CONFIG_ENCRYPTION_KEY) {
    addCheck(checks, 'pass', '配置加密密钥', 'CONFIG_ENCRYPTION_KEY 已设置');
  } else if (process.env.JWT_SECRET) {
    addCheck(checks, 'warn', '配置加密密钥', '未设置 CONFIG_ENCRYPTION_KEY，当前使用 JWT_SECRET 派生配置加密密钥');
  } else {
    addCheck(checks, 'warn', '配置加密密钥', '未设置 CONFIG_ENCRYPTION_KEY/JWT_SECRET，敏感配置会以兼容模式明文保存');
  }

  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const probe = join(dataDir, `.doctor-${Date.now()}.tmp`);
    writeFileSync(probe, 'ok', 'utf-8');
    unlinkSync(probe);
    addCheck(checks, 'pass', '数据目录写入', `${dataDir} 可写`);
  } catch (err) {
    addCheck(checks, 'fail', '数据目录写入', `无法写入数据目录: ${err.message}`);
  }

  let rawConfig = null;
  if (!existsSync(configFile)) {
    addCheck(checks, 'warn', '配置文件', 'config.json 不存在，服务会在首次保存时创建');
  } else {
    try {
      rawConfig = JSON.parse(readFileSync(configFile, 'utf-8'));
      addCheck(checks, 'pass', '配置文件解析', 'config.json JSON 格式正常');
    } catch (err) {
      addCheck(checks, 'fail', '配置文件解析', `config.json 无法解析: ${err.message}`);
    }
  }

  if (rawConfig) {
    try {
      decryptConfigSecrets(rawConfig);
      addCheck(checks, 'pass', '配置解密', '已保存的敏感配置可正常解密');
    } catch (err) {
      addCheck(checks, 'fail', '配置解密', `配置解密失败，请确认加密密钥未变更: ${err.message}`);
    }
    const encryptedCount = (rawConfig.connections || []).reduce((sum, conn) => {
      return sum + ['password', 'token', 'oauthClientSecret', 'teableOAuthToken'].filter((field) => isEncryptedSecret(conn[field])).length;
    }, 0);
    addCheck(checks, encryptedCount > 0 ? 'pass' : 'warn', '敏感字段加密', encryptedCount > 0 ? `检测到 ${encryptedCount} 个已加密敏感字段` : '尚未检测到加密敏感字段，保存连接后会自动加密');
  }

  try {
    const backupStatus = getConfigBackupStatus(configFile);
    addCheck(
      checks,
      backupStatus.count > 0 ? 'pass' : 'warn',
      '配置自动备份',
      backupStatus.count > 0
        ? `已保留 ${backupStatus.count}/${backupStatus.maxBackups} 个备份，最近一次 ${backupStatus.latest.createdAt}`
        : '暂未生成配置备份，下一次配置写入时会自动创建',
      { backupStatus },
    );
  } catch (err) {
    addCheck(checks, 'fail', '配置自动备份', `无法读取配置备份状态: ${err.message}`);
  }

  const connections = config.connections || [];
  const tasks = config.syncTasks || [];
  const activeConnections = connections.filter((c) => !c.deletedAt);
  const activeTasks = tasks.filter((t) => !t.deletedAt);
  addCheck(checks, 'pass', '配置规模', `${activeConnections.length} 个有效连接，${activeTasks.length} 个有效任务`);

  for (const conn of activeConnections) {
    const missing = requiredConnectionFields(conn).filter((field) => !conn[field]);
    if (missing.length > 0) {
      addCheck(checks, 'warn', `连接缺字段: ${conn.name || conn.id}`, `缺少 ${missing.join(', ')}`, { targetId: conn.id });
    }
    if (conn.type === 'teable' && !conn.token && !conn.hasToken) {
      addCheck(checks, 'warn', `Teable 连接未授权: ${conn.name || conn.id}`, '缺少 token，任务执行会失败', { targetId: conn.id });
    }
  }

  const connectionIds = new Set(connections.map((c) => c.id));
  for (const task of activeTasks) {
    const sourceId = task.sourceConnectionId || task.sourceId;
    const targetId = task.targetConnectionId || task.targetId;
    if (!sourceId || !connectionIds.has(sourceId)) {
      addCheck(checks, 'fail', `任务源连接失效: ${task.name || task.id}`, '源连接不存在或未配置', { targetId: task.id });
    }
    if (!targetId || !connectionIds.has(targetId)) {
      addCheck(checks, 'fail', `任务目标连接失效: ${task.name || task.id}`, '目标 Teable 连接不存在或未配置', { targetId: task.id });
    }
    if (!task.sourceTable || !task.targetTableId) {
      addCheck(checks, 'warn', `任务表配置不完整: ${task.name || task.id}`, '缺少源表或目标表', { targetId: task.id });
    }
    if (task.deletionMode && task.deletionMode !== 'ignore' && task.watermarkType !== 'full_scan') {
      addCheck(checks, 'warn', `删除同步不会执行: ${task.name || task.id}`, '删除同步仅在全量扫描策略下执行', { targetId: task.id });
    }
  }

  const failureCounts = getSyncFailureCounts();
  const failedRows = Object.values(failureCounts).reduce((sum, count) => sum + count, 0);
  addCheck(checks, failedRows > 0 ? 'warn' : 'pass', '失败批次', failedRows > 0 ? `当前仍有 ${failedRows} 条失败记录待处理` : '没有待处理失败记录');

  const severity = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
  return {
    status: severity,
    checkedAt: new Date().toISOString(),
    summary: {
      pass: checks.filter((c) => c.status === 'pass').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      fail: checks.filter((c) => c.status === 'fail').length,
    },
    checks,
  };
}

import { isAdmin } from './roles.js';

export function canReadConnection(user, conn) {
  if (!user || !conn || conn.deletedAt) return false;
  return isAdmin(user) || conn.ownerId === user.id || conn.shared === true;
}

export function canWriteConnection(user, conn) {
  if (!user || !conn || conn.deletedAt) return false;
  return isAdmin(user) || conn.ownerId === user.id;
}

export function findReadableConnection(config, user, id) {
  const conn = config.connections.find((c) => c.id === id);
  return canReadConnection(user, conn) ? conn : null;
}

function connectionLabel(conn, fallbackId) {
  return conn?.name || fallbackId || '未配置';
}

function connectionReadyError(label, conn) {
  if (!conn.lastTest) {
    return `${label}「${connectionLabel(conn)}」尚未测试通过，请先在数据源页面测试连接。`;
  }
  if (conn.lastTest.success !== true) {
    return `${label}「${connectionLabel(conn)}」最近测试失败：${conn.lastTest.error || '未知错误'}，请重新测试通过后再使用。`;
  }
  return null;
}

export function validateTaskConnections(config, user, task, options = {}) {
  const { requireTested = false, requireTarget = true } = options;
  const sourceId = task.sourceConnectionId || task.sourceId;
  const targetId = task.targetConnectionId || task.targetId;
  const srcConn = sourceId ? findReadableConnection(config, user, sourceId) : null;
  const tgtConn = targetId ? findReadableConnection(config, user, targetId) : null;

  if (sourceId && !srcConn) return { error: '无权使用源连接或连接不存在' };
  if (requireTarget && targetId && !tgtConn) return { error: '无权使用目标连接或连接不存在' };
  if (requireTarget && !targetId) return { error: '未配置目标连接' };
  if (srcConn && !['mssql', 'mysql', 'pg', 'teable'].includes(srcConn.type)) return { error: '源连接必须是 SQL 数据库或 Teable' };
  if (requireTarget && tgtConn && tgtConn.type !== 'teable') return { error: '目标连接必须是 Teable' };
  if ((task.syncDirection === 'bidirectional' || task.direction === 'bidirectional') && srcConn?.type !== 'teable') {
    return { error: '双向同步仅支持 Teable ↔ Teable' };
  }
  if (requireTested) {
    const checks = [
      ['源连接', srcConn],
      ...(requireTarget ? [['目标连接', tgtConn]] : []),
    ];
    for (const [label, conn] of checks) {
      if (!conn) return { error: `${label}不存在或无权访问` };
      const error = connectionReadyError(label, conn);
      if (error) return { error };
    }
  }

  return { srcConn, tgtConn };
}

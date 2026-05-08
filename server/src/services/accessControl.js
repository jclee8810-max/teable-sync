export function canReadConnection(user, conn) {
  if (!user || !conn || conn.deletedAt) return false;
  return user.role === 'super_admin' || conn.ownerId === user.id || conn.shared === true;
}

export function canWriteConnection(user, conn) {
  if (!user || !conn || conn.deletedAt) return false;
  return user.role === 'super_admin' || conn.ownerId === user.id;
}

export function findReadableConnection(config, user, id) {
  const conn = config.connections.find((c) => c.id === id);
  return canReadConnection(user, conn) ? conn : null;
}

export function validateTaskConnections(config, user, task) {
  const sourceId = task.sourceConnectionId || task.sourceId;
  const targetId = task.targetConnectionId || task.targetId;
  const srcConn = sourceId ? findReadableConnection(config, user, sourceId) : null;
  const tgtConn = targetId ? findReadableConnection(config, user, targetId) : null;

  if (sourceId && !srcConn) return { error: '无权使用源连接或连接不存在' };
  if (targetId && !tgtConn) return { error: '无权使用目标连接或连接不存在' };
  if (srcConn && !['mssql', 'mysql', 'pg', 'teable'].includes(srcConn.type)) return { error: '源连接必须是 SQL 数据库或 Teable' };
  if (tgtConn && tgtConn.type !== 'teable') return { error: '目标连接必须是 Teable' };
  if ((task.syncDirection === 'bidirectional' || task.direction === 'bidirectional') && srcConn?.type !== 'teable') {
    return { error: '双向同步仅支持 Teable ↔ Teable' };
  }

  return { srcConn, tgtConn };
}

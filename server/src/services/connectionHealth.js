const DAY_MS = 24 * 60 * 60 * 1000;

export const CONNECTION_TEST_WARN_DAYS = Math.max(1, Number(process.env.CONNECTION_TEST_WARN_DAYS || 7));
export const CONNECTION_TEST_MAX_AGE_DAYS = Math.max(CONNECTION_TEST_WARN_DAYS, Number(process.env.CONNECTION_TEST_MAX_AGE_DAYS || 30));

function testedAtMs(conn) {
  const value = conn?.lastTest?.testedAt;
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function connectionTestAgeDays(conn, now = Date.now()) {
  const time = testedAtMs(conn);
  if (!time) return null;
  return Math.max(0, Math.floor((now - time) / DAY_MS));
}

export function connectionLabel(conn, fallbackId) {
  return conn?.name || fallbackId || '未配置';
}

export function getConnectionHealth(conn, options = {}) {
  const now = options.now || Date.now();
  const label = connectionLabel(conn, options.fallbackId);
  if (!conn) {
    return { status: 'missing', severity: 'error', ok: false, label, message: `${label}不存在` };
  }
  if (!conn.lastTest) {
    return { status: 'untested', severity: 'error', ok: false, label, message: `${label}尚未测试通过` };
  }
  if (conn.lastTest.success !== true) {
    return {
      status: 'failed',
      severity: 'error',
      ok: false,
      label,
      testedAt: conn.lastTest.testedAt || null,
      ageDays: connectionTestAgeDays(conn, now),
      message: `${label}最近测试失败: ${conn.lastTest.error || '未知错误'}`,
    };
  }
  const ageDays = connectionTestAgeDays(conn, now);
  if (ageDays === null) {
    return { status: 'untested', severity: 'error', ok: false, label, message: `${label}缺少测试时间，请重新测试连接。` };
  }
  if (ageDays >= CONNECTION_TEST_MAX_AGE_DAYS) {
    return {
      status: 'expired',
      severity: 'error',
      ok: false,
      label,
      testedAt: conn.lastTest.testedAt,
      ageDays,
      maxAgeDays: CONNECTION_TEST_MAX_AGE_DAYS,
      warnDays: CONNECTION_TEST_WARN_DAYS,
      message: `${label}最近测试已超过 ${CONNECTION_TEST_MAX_AGE_DAYS} 天，请在数据源页面重新测试通过后再使用。`,
    };
  }
  if (ageDays >= CONNECTION_TEST_WARN_DAYS) {
    return {
      status: 'stale',
      severity: 'warn',
      ok: true,
      label,
      testedAt: conn.lastTest.testedAt,
      ageDays,
      maxAgeDays: CONNECTION_TEST_MAX_AGE_DAYS,
      warnDays: CONNECTION_TEST_WARN_DAYS,
      message: `${label}最近测试已超过 ${CONNECTION_TEST_WARN_DAYS} 天，建议重新测试连接。`,
    };
  }
  return {
    status: 'fresh',
    severity: 'ok',
    ok: true,
    label,
    testedAt: conn.lastTest.testedAt,
    ageDays,
    maxAgeDays: CONNECTION_TEST_MAX_AGE_DAYS,
    warnDays: CONNECTION_TEST_WARN_DAYS,
    message: conn.lastTest.message || '最近测试通过',
  };
}

export function connectionReadyError(label, conn) {
  const health = getConnectionHealth(conn);
  const name = connectionLabel(conn);
  if (health.status === 'untested') {
    return `${label}「${name}」尚未测试通过，请先在数据源页面测试连接。`;
  }
  if (health.status === 'failed') {
    return `${label}「${name}」最近测试失败：${conn.lastTest.error || '未知错误'}，请重新测试通过后再使用。`;
  }
  if (health.status === 'expired') {
    return `${label}「${name}」最近测试已超过 ${CONNECTION_TEST_MAX_AGE_DAYS} 天，请先在数据源页面重新测试连接。`;
  }
  return null;
}

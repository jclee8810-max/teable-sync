const DAY_MS = 24 * 60 * 60 * 1000;
export const CONNECTION_TEST_WARN_DAYS = 7;
export const CONNECTION_TEST_MAX_AGE_DAYS = 30;

export function connectionTestAgeDays(conn, now = Date.now()) {
  const value = conn?.lastTest?.testedAt;
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((now - time) / DAY_MS));
}

export function getConnectionHealth(conn, now = Date.now()) {
  if (!conn?.lastTest) return { status: 'untested', severity: 'error', ok: false, ageDays: null };
  if (conn.lastTest.success !== true) {
    return { status: 'failed', severity: 'error', ok: false, ageDays: connectionTestAgeDays(conn, now) };
  }
  const ageDays = connectionTestAgeDays(conn, now);
  if (ageDays === null) return { status: 'untested', severity: 'error', ok: false, ageDays: null };
  if (ageDays >= CONNECTION_TEST_MAX_AGE_DAYS) {
    return { status: 'expired', severity: 'error', ok: false, ageDays };
  }
  if (ageDays >= CONNECTION_TEST_WARN_DAYS) {
    return { status: 'stale', severity: 'warn', ok: true, ageDays };
  }
  return { status: 'fresh', severity: 'ok', ok: true, ageDays };
}

export function isConnectionReady(conn) {
  return getConnectionHealth(conn).ok === true;
}

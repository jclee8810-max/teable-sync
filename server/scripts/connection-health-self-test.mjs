#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  CONNECTION_TEST_MAX_AGE_DAYS,
  CONNECTION_TEST_WARN_DAYS,
  connectionReadyError,
  getConnectionHealth,
} from '../src/services/connectionHealth.js';

const now = new Date('2026-05-10T00:00:00.000Z').getTime();
const daysAgo = (days) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

function conn(lastTest) {
  return { id: 'c1', name: '业务库', lastTest };
}

assert.equal(getConnectionHealth(conn({ success: true, testedAt: daysAgo(1) }), { now }).status, 'fresh');
assert.equal(getConnectionHealth(conn({ success: true, testedAt: daysAgo(CONNECTION_TEST_WARN_DAYS) }), { now }).status, 'stale');
assert.equal(getConnectionHealth(conn({ success: true, testedAt: daysAgo(CONNECTION_TEST_MAX_AGE_DAYS) }), { now }).status, 'expired');
assert.equal(getConnectionHealth(conn({ success: false, testedAt: daysAgo(1), error: 'bad password' }), { now }).status, 'failed');
assert.equal(getConnectionHealth(conn(null), { now }).status, 'untested');

assert.equal(connectionReadyError('源连接', conn({ success: true, testedAt: daysAgo(1) })), null);
assert.match(connectionReadyError('源连接', conn({ success: true, testedAt: daysAgo(CONNECTION_TEST_MAX_AGE_DAYS) })), /超过 30 天/);
assert.match(connectionReadyError('源连接', conn({ success: false, testedAt: daysAgo(1), error: 'bad password' })), /最近测试失败/);
assert.match(connectionReadyError('源连接', conn(null)), /尚未测试通过/);

console.log('connection health self-test PASS');

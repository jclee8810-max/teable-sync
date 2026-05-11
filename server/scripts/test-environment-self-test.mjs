#!/usr/bin/env node
import assert from 'node:assert/strict';
import { applyTestEnvironmentCleanup, buildTestEnvironmentPlan } from '../src/services/testEnvironmentService.js';

const now = new Date('2026-05-10T00:00:00.000Z').toISOString();
const config = {
  connections: [
    { id: 'sales', name: 'SalesDB', type: 'mssql', host: 'host.docker.internal', lastTest: { success: true, testedAt: now } },
    { id: 'teable', name: 'Teable', type: 'teable', host: 'http://teable.local', lastTest: { success: true, testedAt: now } },
    { id: 'tmp-conn', name: 'codex-e2e-temp-SalesDB', type: 'mssql', host: 'host.docker.internal' },
    { id: 'blocked-conn', name: 'codex-e2e-blocked-SalesDB', type: 'mssql', host: 'host.docker.internal' },
  ],
  syncTasks: [
    { id: 'task-real', name: 'Business Task', sourceConnectionId: 'blocked-conn', targetConnectionId: 'teable', status: 'idle' },
    { id: 'codex-e2e-task', name: 'codex-e2e-task', sourceConnectionId: 'tmp-conn', targetConnectionId: 'teable', status: 'scheduled', enabled: true },
  ],
  taskTemplates: [
    { id: 'tpl-real', name: 'Real Template' },
    { id: 'tpl-temp', name: 'codex-e2e-template' },
  ],
  syncLogs: Array.from({ length: 260 }, (_, i) => ({ id: `log-${i}`, taskId: i % 2 ? 'codex-e2e-task' : 'task-real', message: i % 2 ? 'codex-e2e temp' : 'business' })),
  alertStates: {
    'task:codex-e2e-task': { acknowledgedAt: now },
    'task:task-real': { acknowledgedAt: now },
  },
};

const plan = buildTestEnvironmentPlan(config, { keepRecentLogs: 100 });
assert.equal(plan.summary.baselineConnections, 2);
assert.equal(plan.summary.readyBaselineConnections, 2);
assert.equal(plan.summary.removableConnections, 1);
assert.equal(plan.summary.blockedTemporaryConnections, 1);
assert.equal(plan.summary.removableTasks, 1);
assert.equal(plan.summary.removableTemplates, 1);
assert.ok(plan.summary.removableLogs > 0);

const result = applyTestEnvironmentCleanup(config, { keepRecentLogs: 100 });
assert.equal(result.removed.connections, 1);
assert.equal(result.removed.tasks, 1);
assert.equal(result.removed.templates, 1);
assert.ok(config.connections.find((item) => item.id === 'sales' && !item.deletedAt));
assert.ok(config.connections.find((item) => item.id === 'teable' && !item.deletedAt));
assert.ok(config.connections.find((item) => item.id === 'tmp-conn' && item.deletedAt));
assert.ok(config.connections.find((item) => item.id === 'blocked-conn' && !item.deletedAt));
assert.ok(config.syncTasks.find((item) => item.id === 'codex-e2e-task' && item.deletedAt && item.enabled === false));
assert.ok(config.taskTemplates.find((item) => item.id === 'tpl-temp' && item.deletedAt));
assert.ok(config.syncLogs.length <= 100);
assert.ok(config.alertStates['task:task-real']);
assert.equal(config.alertStates['task:codex-e2e-task'], undefined);

console.log('test environment self-test PASS');

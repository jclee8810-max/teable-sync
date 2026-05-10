#!/usr/bin/env node
import assert from 'node:assert/strict'
import { buildTaskUiState, isTaskRunning, setActionBusy } from './taskUiState.js'

function task(overrides = {}) {
  return {
    id: 'task-1',
    syncMode: 'manual',
    status: 'idle',
    connectionStatus: { ok: true },
    ...overrides,
  }
}

function test(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (err) {
    console.error(`FAIL ${name}`)
    throw err
  }
}

test('manual task can run when idle and connected', () => {
  const state = buildTaskUiState(task())
  assert.equal(state.manualRunDisabled, false)
  assert.equal(state.restartFullSyncDisabled, false)
  assert.equal(state.scheduleActionDisabled, true)
})

test('realtime task disables manual run with a clear title', () => {
  const state = buildTaskUiState(task({ syncMode: 'realtime' }))
  assert.equal(state.manualRunDisabled, true)
  assert.match(state.manualRunTitle, /准实时/)
})

test('running progress disables all run-start actions', () => {
  const progressByTask = { 'task-1': { status: 'queued' } }
  const state = buildTaskUiState(task(), { progressByTask })
  assert.equal(isTaskRunning(task(), progressByTask), true)
  assert.equal(state.manualRunDisabled, true)
  assert.equal(state.restartFullSyncDisabled, true)
  assert.equal(state.continueInitializationDisabled, true)
})

test('local action lock closes the API-to-polling click gap', () => {
  const actionLocks = setActionBusy({}, task(), 'continueInitialization', true)
  const state = buildTaskUiState(task(), { actionLocks })
  assert.equal(state.runActionPending, true)
  assert.equal(state.manualRunDisabled, true)
  assert.equal(state.restartFullSyncDisabled, true)
  assert.equal(state.continueInitializationDisabled, true)
})

test('detail continue initialization requires a known checkpoint', () => {
  const currentTask = task()
  const withoutCheckpoint = buildTaskUiState(currentTask, {
    detailTask: currentTask,
    initializationState: { hasCheckpoint: false },
  })
  const withCheckpoint = buildTaskUiState(currentTask, {
    detailTask: currentTask,
    initializationState: { hasCheckpoint: true },
  })
  assert.equal(withoutCheckpoint.continueInitializationDisabled, true)
  assert.equal(withCheckpoint.continueInitializationDisabled, false)
})

test('cancel remains disabled once cancellation is requested', () => {
  const progressByTask = { 'task-1': { status: 'cancelling' } }
  const state = buildTaskUiState(task(), { progressByTask })
  assert.equal(state.running, true)
  assert.equal(state.cancelling, true)
  assert.equal(state.cancelDisabled, true)
})

test('scheduled task allows schedule toggle only when idle and connected', () => {
  const scheduled = task({ syncMode: 'scheduled' })
  const connectedState = buildTaskUiState(scheduled)
  const disconnectedState = buildTaskUiState(task({ syncMode: 'scheduled', connectionStatus: { ok: false } }))
  assert.equal(connectedState.scheduleActionDisabled, false)
  assert.equal(disconnectedState.scheduleActionDisabled, true)
})

console.log('task UI state tests PASS')

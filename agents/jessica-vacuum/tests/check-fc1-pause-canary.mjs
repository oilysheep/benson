import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHaCanaryDriver } from '../lib/ha-control.mjs';
import { assertFreshMap, loadRegistry } from '../lib/registry.mjs';
import { validateResult } from '../lib/results.mjs';

const REGISTRY_URL = new URL('../config/registry.v1.json', import.meta.url);
const DB_PATH = '/home/oa/.openclaw/state/openclaw.sqlite';
const PLUGIN_ID = 'benson-jessica-tool';
const NAMESPACE = 'jessica-operations-v1';

function scopeFor(registry, capability, now, requireActive, expectedRoom = 'guest_bathroom') {
  const scope = registry.underTest;
  assert(['pause', 'dock'].includes(capability), 'FC1 control capability is invalid');
  const expectedRooms = Array.isArray(expectedRoom) ? expectedRoom : [expectedRoom];
  const scopeRooms = scope?.rooms ?? (scope?.room ? [scope.room] : []);
  assert(scope?.capability === capability && scopeRooms.length === expectedRooms.length &&
    expectedRooms.every((room) => scopeRooms.includes(room)) &&
    scope.subject === 'oren' && scope.maxDispatches === 1,
  `FC1 Oren ${capability} scope is unavailable`);
  if (requireActive) assert(Date.parse(scope.expiresAt) > now.getTime(), `FC1 ${capability} scope expired`);
  return scope;
}

function scopeSegments(registry, scope) {
  return (scope.rooms ?? [scope.room]).map((slug) => {
    const room = registry.rooms.find((item) => item.slug === slug && item.enabled);
    assert(room, 'Canary room binding is unavailable');
    return { slug, segmentId: room.segmentId };
  });
}

function sameSet(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((value) => actual.includes(value));
}

function recent(signal, now, ageMs) {
  return Number.isFinite(Date.parse(signal?.sourceUpdatedAt)) &&
    Number.isFinite(Date.parse(signal?.observedAt)) &&
    Date.parse(signal.sourceUpdatedAt) <= Date.parse(signal.observedAt) &&
    now.getTime() >= Date.parse(signal.sourceUpdatedAt) &&
    now.getTime() - Date.parse(signal.sourceUpdatedAt) <= ageMs;
}

export function checkIdle({ registry, claim, device, evidence, capability = 'pause', expectedRoom = 'guest_bathroom', now = new Date() }) {
  const scope = scopeFor(registry, capability, now, true, expectedRoom);
  const rooms = scopeSegments(registry, scope);
  assert.equal(claim, null, `One-shot ${capability} dispatch was already claimed`);
  assert.equal(device?.active ?? null, null, 'Another Jessica operation is unresolved');
  assertFreshMap(registry, evidence.map, now);
  assert.equal(evidence.error, null, 'Robot error is present');
  assert.equal(evidence.status.state, 'docked', 'Robot is not safely docked');
  assert(evidence.status.activeSegments === null ||
    Array.isArray(evidence.status.activeSegments) && evidence.status.activeSegments.length === 0,
  'Robot still has active segments');
  assert.equal(evidence.taskStatus?.state, 'completed', 'Previous task has not ended');
  return { checkedAt: now.toISOString(), scopeId: scope.id,
    rooms: rooms.map((room) => room.slug), segments: rooms.map((room) => room.segmentId),
    state: 'docked' };
}

export function checkPreflight({ registry, claim, device, evidence, capability = 'pause', expectedRoom = 'guest_bathroom', now = new Date() }) {
  const scope = scopeFor(registry, capability, now, true, expectedRoom);
  const rooms = scopeSegments(registry, scope);
  const segments = rooms.map((room) => room.segmentId);
  assert.equal(claim, null, `One-shot ${capability} dispatch was already claimed`);
  assert.equal(device?.active ?? null, null, 'Another Jessica operation is unresolved');
  assertFreshMap(registry, evidence.map, now);
  assert.equal(evidence.error, null, 'Robot error is present');
  assert.equal(evidence.status.state, 'cleaning', 'Robot is not cleaning');
  assert(sameSet(evidence.status.activeSegments, segments), 'Active rooms differ from scope');
  assert.equal(evidence.taskStatus?.state, 'room_cleaning', 'Room-cleaning task is not active');
  assert(recent(evidence.taskStatus, now, 600_000), 'Task-status signal is stale');
  const progress = [['area', evidence.currentArea], ['time', evidence.currentTime]].find(([, signal]) =>
    recent(signal, now, 30_000) && signal.value > 0 &&
    Date.parse(signal.sourceUpdatedAt) > Date.parse(evidence.taskStatus.sourceUpdatedAt));
  assert(progress, 'Positive current-task progress is not fresh');
  if (capability === 'dock') {
    assert(recent(evidence.chargingStatus, now, 600_000) &&
      evidence.chargingStatus.value === 'not_charging',
    'Robot is not independently proved away from the charger');
  }
  return { checkedAt: now.toISOString(), scopeId: scope.id,
    rooms: rooms.map((room) => room.slug), segments,
    ...(rooms.length === 1 ? { room: rooms[0].slug, segmentId: rooms[0].segmentId } : {}),
    progressSignal: progress[0], progressValue: progress[1].value,
    progressUpdatedAt: progress[1].sourceUpdatedAt,
    taskStatusUpdatedAt: evidence.taskStatus.sourceUpdatedAt,
    ...(capability === 'dock' ? {
      chargingStatus: evidence.chargingStatus.value,
      chargingUpdatedAt: evidence.chargingStatus.sourceUpdatedAt,
    } : {}) };
}

export function checkOutcome({ registry, claim, device, history, evidence,
  capability = 'pause', expectedRoom = 'guest_bathroom', now = new Date() }) {
  const scope = scopeFor(registry, capability, now, false, expectedRoom);
  const rooms = scopeSegments(registry, scope);
  const segments = rooms.map((room) => room.segmentId);
  assert(claim?.version === '1' && typeof claim.requestKey === 'string' &&
    typeof claim.operationId === 'string' && Number.isFinite(Date.parse(claim.claimedAt)),
  'One-shot dispatch claim is missing');
  assert.equal(device?.active ?? null, null, 'Jessica operation remains unresolved');
  const result = history?.result;
  assert(result, 'Durable native result is missing');
  assert.equal(result.status, 'success', `${capability} was not verified: ${result.error?.code ?? result.status}`);
  const observedAt = result.data?.observation?.observedAt;
  assert(Number.isFinite(Date.parse(observedAt)), `${capability} observation is missing`);
  assert(sameSet(result.data.rooms, rooms.map((room) => room.slug)), 'Result room set differs from scope');
  const resultRooms = result.data.rooms.map((slug) => rooms.find((room) => room.slug === slug));
  validateResult(result, { operation: capability, rooms: resultRooms, settings: null },
    new Date(observedAt));
  assert.equal(result.data.operationId, claim.operationId, 'Result differs from claimed operation');
  assert.equal(result.data.dispatch, 'accepted');
  assert.equal(evidence.error, null, 'Robot error is present');
  if (capability === 'pause') {
    assert.equal(result.data.outcome, 'paused');
    assert(sameSet(result.data.observation.activeSegments, segments), 'Result paused target changed');
    assert(Date.parse(result.data.observation.taskStatus.sourceUpdatedAt) >= Date.parse(claim.claimedAt),
      'Pause signal predates dispatch claim');
    assert.equal(evidence.status.state, 'paused', 'Robot is no longer paused');
    assert(sameSet(evidence.status.activeSegments, segments), 'Paused target changed');
    assert.equal(evidence.taskStatus?.state, 'room_cleaning_paused', 'Device task pause is absent');
    return { checkedAt: now.toISOString(), scopeId: scope.id, operationId: claim.operationId,
      rooms: rooms.map((room) => room.slug), segments,
      outcome: 'paused', observedAt, taskStatusUpdatedAt: evidence.taskStatus.sourceUpdatedAt };
  }
  const resultCharging = result.data.observation.chargingStatus;
  assert.equal(result.data.outcome, 'docked');
  assert(['charging', 'charging_completed'].includes(resultCharging?.value) &&
    Date.parse(resultCharging.sourceUpdatedAt) >= Date.parse(claim.claimedAt),
  'Dock charging signal predates dispatch claim');
  assert.equal(evidence.status.state, 'docked', 'Robot is not docked');
  assert.equal(evidence.status.activeSegments, null, 'Docked robot still has active segments');
  assert(['charging', 'charging_completed'].includes(evidence.chargingStatus?.value) &&
    recent(evidence.chargingStatus, now, 600_000) &&
    Date.parse(evidence.chargingStatus.sourceUpdatedAt) >= Date.parse(resultCharging.sourceUpdatedAt),
  'Live charging evidence is absent or older than the verified result');
  return { checkedAt: now.toISOString(), scopeId: scope.id, operationId: claim.operationId,
    outcome: 'docked', observedAt, chargingStatus: evidence.chargingStatus.value,
    chargingUpdatedAt: evidence.chargingStatus.sourceUpdatedAt };
}

export async function runControlCanary(capability, mode, scriptName,
  { expectedRoom = 'guest_bathroom', label = 'fc1' } = {}) {
  assert(['pause', 'dock'].includes(capability), 'FC1 control capability is invalid');
  assert(['idle', 'preflight', 'after'].includes(mode), `Usage: ${scriptName} idle|preflight|after`);
  const registry = loadRegistry(JSON.parse(readFileSync(REGISTRY_URL, 'utf8')));
  const scope = scopeFor(registry, capability, new Date(), mode !== 'after', expectedRoom);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const get = db.prepare('SELECT value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? AND entry_key = ?');
    const lookup = (key) => {
      const row = get.get(PLUGIN_ID, NAMESPACE, key);
      return row ? JSON.parse(row.value_json) : null;
    };
    const claim = lookup(`under-test:${scope.id}`);
    const device = lookup('device:jessica-vacuum');
    const segments = scopeSegments(registry, scope).map((room) => room.segmentId);
    const evidence = await createHaCanaryDriver({ expectedSegments: segments,
      controlOperation: capability, controlCanarySegments: segments.length > 1 ? segments : null }).read();
    const result = mode === 'idle' ?
      checkIdle({ registry, claim, device, evidence, capability, expectedRoom }) :
      mode === 'preflight' ? checkPreflight({ registry, claim, device, evidence, capability, expectedRoom }) :
        checkOutcome({ registry, claim, device,
          history: claim ? lookup(`request:${claim.requestKey}`) : null, evidence, capability, expectedRoom });
    return { check: `${label}-${capability}-${mode}`, status: 'PASS', ...result };
  } finally {
    db.close();
  }
}

export async function runControlCanaryCli(capability, mode, scriptName, options = {}) {
  try {
    console.log(JSON.stringify(await runControlCanary(capability, mode, scriptName, options)));
  } catch (error) {
    console.error(JSON.stringify({ check: `${options.label ?? 'fc1'}-${capability}-canary`, status: 'FAIL',
      reason: error instanceof Error ? error.message : 'Unknown error' }));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runControlCanaryCli('pause', process.argv[2], 'check-fc1-pause-canary.mjs');
}

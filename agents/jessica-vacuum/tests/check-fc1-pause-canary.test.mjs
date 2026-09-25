import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRegistry } from '../lib/registry.mjs';
import { checkIdle, checkPreflight, checkOutcome } from './check-fc1-pause-canary.mjs';

const registryConfig = JSON.parse(readFileSync(new URL('../config/registry.v1.json', import.meta.url)));
for (const capability of registryConfig.capabilities) delete capability.verifiedRoomSets;
function scopedRegistry(capability) {
  const copy = structuredClone(registryConfig);
  delete copy.underTest;
  const entry = copy.capabilities.find((item) => item.name === capability);
  entry.support = 'reported';
  entry.observedAt = null;
  entry.provenance = 'Deterministic checker fixture';
  delete entry.verifiedRooms;
  copy.underTest = { id: `fc1-${capability}-fixture`, capability, room: 'guest_bathroom',
    subject: 'oren', expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  return loadRegistry(copy);
}
const pauseRegistry = scopedRegistry('pause');
const dockRegistry = scopedRegistry('dock');
const mapFixture = JSON.parse(readFileSync(new URL('./fixtures/map-stage2-live.json', import.meta.url)));

test('FC1 pause checker accepts only a fresh active reviewed room with positive progress', () => {
  const now = new Date('2026-09-22T17:00:00.000Z');
  const taskAt = '2026-09-22T16:59:40.000Z';
  const evidence = {
    map: { ...mapFixture, observedAt: now.toISOString() }, error: null,
    status: { state: 'cleaning', activeSegments: [10] },
    taskStatus: { state: 'room_cleaning', sourceUpdatedAt: taskAt, observedAt: now.toISOString() },
    currentArea: { value: 1, sourceUpdatedAt: '2026-09-22T16:59:55.000Z', observedAt: now.toISOString() },
    currentTime: { value: 0, sourceUpdatedAt: '2026-09-22T16:59:55.000Z', observedAt: now.toISOString() },
  };
  const device = { active: null };
  const ready = checkPreflight({ registry: pauseRegistry, claim: null, device, evidence, now });
  assert.equal(ready.segmentId, 10);
  assert.equal(ready.checkedAt, now.toISOString());
  assert.equal(ready.progressSignal, 'area');
  assert.equal(ready.progressUpdatedAt, evidence.currentArea.sourceUpdatedAt);
  assert.throws(() => checkPreflight({ registry: pauseRegistry, claim: {}, device, evidence, now }), /already claimed/);
  assert.throws(() => checkPreflight({ registry: pauseRegistry, claim: null, device, evidence: {
    ...evidence, status: { ...evidence.status, activeSegments: [8] },
  }, now }), /Active rooms differ/);
  assert.throws(() => checkPreflight({ registry: pauseRegistry, claim: null, device, evidence: {
    ...evidence, currentArea: { ...evidence.currentArea, sourceUpdatedAt: taskAt },
  }, now }), /Positive current-task progress/);
  const timeProgress = checkPreflight({ registry: pauseRegistry, claim: null, device, evidence: {
    ...evidence, currentArea: { ...evidence.currentArea, value: 0 },
    currentTime: { value: 1, sourceUpdatedAt: '2026-09-22T16:59:58.000Z', observedAt: now.toISOString() },
  }, now });
  assert.equal(timeProgress.progressSignal, 'time');
  assert.equal(timeProgress.progressValue, 1);
});

test('FC1 pause checker binds native claim, result and live paused state', () => {
  const now = new Date('2026-09-22T17:00:00.000Z');
  const at = '2026-09-22T16:59:59.000Z';
  const claim = { version: '1', requestKey: 'key', operationId: 'j4-pause',
    claimedAt: '2026-09-22T16:59:50.000Z' };
  const result = { schemaVersion: '1', status: 'success', domain: 'jessica-vacuum',
    operation: 'pause', verified: true, warnings: [], error: null, pendingContext: null,
    data: { operationId: 'j4-pause', rooms: ['guest_bathroom'], outcome: 'paused',
      dispatch: 'accepted', appliedSettings: {}, observation: {
        observedAt: at, sourceUpdatedAt: at, state: 'paused', activeSegments: [10], currentSegment: 10,
        taskStatus: { state: 'room_cleaning_paused', sourceUpdatedAt: at },
      } } };
  const evidence = { error: null, status: { state: 'paused', activeSegments: [10] },
    taskStatus: { state: 'room_cleaning_paused', sourceUpdatedAt: at } };
  const device = { active: null };
  assert.equal(checkOutcome({ registry: pauseRegistry, claim, device, history: { result }, evidence, now }).operationId,
    'j4-pause');
  assert.throws(() => checkOutcome({ registry: pauseRegistry, claim: { ...claim, operationId: 'other' }, device,
    history: { result }, evidence, now }), /differs from claimed/);
  assert.throws(() => checkOutcome({ registry: pauseRegistry, claim, device, history: { result }, evidence: {
    ...evidence, status: { ...evidence.status, state: 'cleaning' },
  }, now }), /no longer paused/);
});

test('FC1 dock checker requires fresh away-from-charger evidence before dispatch', () => {
  const now = new Date('2026-09-22T17:00:00.000Z');
  const evidence = {
    map: { ...mapFixture, observedAt: now.toISOString() }, error: null,
    status: { state: 'cleaning', activeSegments: [10] },
    taskStatus: { state: 'room_cleaning', sourceUpdatedAt: '2026-09-22T16:59:40.000Z',
      observedAt: now.toISOString() },
    currentArea: { value: 1, sourceUpdatedAt: '2026-09-22T16:59:55.000Z',
      observedAt: now.toISOString() },
    currentTime: { value: 0, sourceUpdatedAt: '2026-09-22T16:59:55.000Z',
      observedAt: now.toISOString() },
    chargingStatus: { value: 'not_charging', sourceUpdatedAt: '2026-09-22T16:59:45.000Z',
      observedAt: now.toISOString() },
  };
  const ready = checkPreflight({ registry: dockRegistry, claim: null, device: { active: null },
    evidence, capability: 'dock', now });
  assert.equal(ready.chargingStatus, 'not_charging');
  assert.equal(ready.chargingUpdatedAt, evidence.chargingStatus.sourceUpdatedAt);
  assert.throws(() => checkPreflight({ registry: dockRegistry, claim: null, device: { active: null },
    evidence: { ...evidence, chargingStatus: { ...evidence.chargingStatus, value: 'charging' } },
    capability: 'dock', now }), /away from the charger/);
});

test('FC1 dock checker binds claim, result and fresh live charging state', () => {
  const now = new Date('2026-09-22T17:00:00.000Z');
  const at = '2026-09-22T16:59:59.000Z';
  const claim = { version: '1', requestKey: 'key', operationId: 'j4-dock',
    claimedAt: '2026-09-22T16:59:50.000Z' };
  const result = { schemaVersion: '1', status: 'success', domain: 'jessica-vacuum',
    operation: 'dock', verified: true, warnings: [], error: null, pendingContext: null,
    data: { operationId: 'j4-dock', rooms: ['guest_bathroom'], outcome: 'docked',
      dispatch: 'accepted', appliedSettings: {}, observation: {
        observedAt: at, sourceUpdatedAt: at, state: 'docked', activeSegments: null, currentSegment: null,
        chargingStatus: { value: 'charging', sourceUpdatedAt: at },
      } } };
  const evidence = { error: null, status: { state: 'docked', activeSegments: null },
    chargingStatus: { value: 'charging', sourceUpdatedAt: at, observedAt: now.toISOString() } };
  const checked = checkOutcome({ registry: dockRegistry, claim, device: { active: null },
    history: { result }, evidence, capability: 'dock', now });
  assert.equal(checked.operationId, 'j4-dock');
  assert.equal(checked.chargingStatus, 'charging');
  assert.throws(() => checkOutcome({ registry: dockRegistry, claim, device: { active: null },
    history: { result }, evidence: { ...evidence, status: { state: 'returning', activeSegments: null } },
    capability: 'dock', now }), /not docked/);
  assert.throws(() => checkOutcome({ registry: dockRegistry, claim, device: { active: null },
    history: { result }, evidence: { ...evidence,
      chargingStatus: { ...evidence.chargingStatus, value: 'not_charging' } },
    capability: 'dock', now }), /charging evidence/);
});

test('FC2 hallway checker uses the reviewed room while FC1 guest checker stays fixed', () => {
  const copy = structuredClone(registryConfig);
  copy.capabilities.find((item) => item.name === 'clean_single_room').verifiedRooms = copy.capabilities
    .find((item) => item.name === 'clean_single_room').verifiedRooms
    .filter((item) => ['guest_bathroom', 'hallway', 'living_room'].includes(item.room));
  copy.capabilities.find((item) => item.name === 'pause').verifiedRooms = copy.capabilities
    .find((item) => item.name === 'pause').verifiedRooms.filter((item) => item.room === 'guest_bathroom');
  copy.underTest = { id: 'fc2-pause-hallway-fixture', capability: 'pause', room: 'hallway',
    subject: 'oren', expiresAt: '2026-09-29T20:00:00+03:00', maxDispatches: 1 };
  const reviewed = loadRegistry(copy);
  const now = new Date('2026-09-24T07:00:00.000Z');
  const evidence = { map: { ...mapFixture, observedAt: now.toISOString() }, error: null,
    status: { state: 'cleaning', activeSegments: [7] },
    taskStatus: { state: 'room_cleaning', sourceUpdatedAt: '2026-09-24T06:59:40.000Z', observedAt: now.toISOString() },
    currentArea: { value: 1, sourceUpdatedAt: '2026-09-24T06:59:55.000Z', observedAt: now.toISOString() },
    currentTime: { value: 0, sourceUpdatedAt: '2026-09-24T06:59:55.000Z', observedAt: now.toISOString() } };
  assert.equal(checkPreflight({ registry: reviewed, claim: null, device: { active: null },
    evidence, now, expectedRoom: 'hallway' }).segmentId, 7);
  assert.throws(() => checkPreflight({ registry: reviewed, claim: null, device: { active: null },
    evidence, now }), /scope is unavailable/);
});

test('FC2 multi-room pause historical checker requires exact fresh pair and binds durable paused result', () => {
  const scoped = structuredClone(registryConfig);
  scoped.underTest = { id: 'fc2-pause-multi-fixture', capability: 'pause',
    rooms: ['living_room', 'hallway'], subject: 'oren',
    expiresAt: '2026-09-30T20:00:00+03:00', maxDispatches: 1 };
  const registry = loadRegistry(scoped);
  const now = new Date('2026-09-24T07:00:00.000Z');
  const at = '2026-09-24T06:59:59.000Z';
  const expectedRoom = ['living_room', 'hallway'];
  const evidence = { map: { ...mapFixture, observedAt: now.toISOString() }, error: null,
    status: { state: 'cleaning', activeSegments: [7, 8] },
    taskStatus: { state: 'room_cleaning', sourceUpdatedAt: '2026-09-24T06:59:40.000Z', observedAt: now.toISOString() },
    currentArea: { value: 3, sourceUpdatedAt: '2026-09-24T06:59:55.000Z', observedAt: now.toISOString() },
    currentTime: { value: 0, sourceUpdatedAt: '2026-09-24T06:59:55.000Z', observedAt: now.toISOString() } };
  const ready = checkPreflight({ registry, claim: null, device: { active: null }, evidence, now, expectedRoom });
  assert.deepEqual(ready.segments, [8, 7]);
  assert.throws(() => checkPreflight({ registry, claim: null, device: { active: null },
    evidence: { ...evidence, status: { ...evidence.status, activeSegments: [8, 11] } }, now, expectedRoom }),
  /Active rooms differ/);
  assert.throws(() => checkPreflight({ registry, claim: null, device: { active: null },
    evidence: { ...evidence, currentArea: { ...evidence.currentArea, value: 0 } }, now, expectedRoom }),
  /Positive current-task progress/);
  const claim = { version: '1', requestKey: 'multi-key', operationId: 'j4-multi-pause',
    claimedAt: '2026-09-24T06:59:50.000Z' };
  const result = { schemaVersion: '1', status: 'success', domain: 'jessica-vacuum',
    operation: 'pause', verified: true, warnings: [], error: null, pendingContext: null,
    data: { operationId: claim.operationId, rooms: ['hallway', 'living_room'], outcome: 'paused',
      dispatch: 'accepted', appliedSettings: {}, observation: {
        observedAt: at, sourceUpdatedAt: at, state: 'paused', activeSegments: [7, 8], currentSegment: 7,
        taskStatus: { state: 'room_cleaning_paused', sourceUpdatedAt: at },
      } } };
  const paused = { ...evidence, status: { state: 'paused', activeSegments: [7, 8] },
    taskStatus: { state: 'room_cleaning_paused', sourceUpdatedAt: at } };
  assert.equal(checkOutcome({ registry, claim, device: { active: null }, history: { result },
    evidence: paused, now, expectedRoom }).outcome, 'paused');
  assert.throws(() => checkOutcome({ registry, claim, device: { active: null }, history: { result },
    evidence: { ...paused, status: { ...paused.status, activeSegments: [8, 11] } }, now, expectedRoom }),
  /Paused target changed/);
  assert.throws(() => checkOutcome({ registry, claim, device: { active: null }, history: { result: {
    ...result, data: { ...result.data, observation: { ...result.data.observation, activeSegments: [8, 11] } },
  } }, evidence: paused, now, expectedRoom }), /Result paused target changed/);
});

test('FC2 multi-room pause historical idle gate proves docked selected map and no unresolved operation', () => {
  const scoped = structuredClone(registryConfig);
  scoped.underTest = { id: 'fc2-pause-multi-fixture', capability: 'pause',
    rooms: ['living_room', 'hallway'], subject: 'oren',
    expiresAt: '2026-09-30T20:00:00+03:00', maxDispatches: 1 };
  const registry = loadRegistry(scoped);
  const now = new Date('2026-09-24T07:00:00.000Z');
  const evidence = { map: { ...mapFixture, observedAt: now.toISOString() }, error: null,
    status: { state: 'docked', activeSegments: null }, taskStatus: { state: 'completed' } };
  assert.equal(checkIdle({ registry, claim: null, device: { active: null }, evidence,
    now, expectedRoom: ['living_room', 'hallway'] }).state, 'docked');
  assert.throws(() => checkIdle({ registry, claim: null, device: { active: {} }, evidence,
    now, expectedRoom: ['living_room', 'hallway'] }), /unresolved/);
  assert.throws(() => checkIdle({ registry, claim: null, device: { active: null },
    evidence: { ...evidence, status: { state: 'cleaning', activeSegments: [8, 7] } },
    now, expectedRoom: ['living_room', 'hallway'] }), /safely docked/);
});

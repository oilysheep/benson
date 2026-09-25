import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRegistry } from '../lib/registry.mjs';
import { checkHomeCleanup, checkHomeLive, checkHomeOutcome, checkHomePreflight,
  checkLiveOutcome, checkOutcome, checkPreflight } from './check-stage6-canary.mjs';

const registry = loadRegistry(JSON.parse(readFileSync(new URL('../config/registry.v1.json', import.meta.url), 'utf8')));
const canaryConfig = structuredClone(JSON.parse(readFileSync(new URL('../config/registry.v1.json', import.meta.url), 'utf8')));
for (const capability of canaryConfig.capabilities) delete capability.verifiedRoomSets;
delete canaryConfig.capabilities.find((item) => item.name === 'clean_single_room').verifiedRooms;
for (const name of ['pause', 'dock']) {
  const control = canaryConfig.capabilities.find((item) => item.name === name);
  control.support = 'reported';
  delete control.verifiedRooms;
}
delete canaryConfig.capabilities.find((item) => item.name === 'clean_settings').verifiedSettings;
canaryConfig.underTest = { id: 'stage6-guest-bathroom-20260920', capability: 'clean_single_room',
  room: 'guest_bathroom', subject: 'family:oren', expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
const canaryRegistry = loadRegistry(canaryConfig);
const map = JSON.parse(readFileSync(new URL('./fixtures/map-stage2-live.json', import.meta.url), 'utf8'));
const at = map.observedAt;
const claim = { version: '1', requestKey: 'request-one', operationId: 'j4-test',
  claimedAt: new Date(Date.parse(at) - 1_000).toISOString() };
const result = {
  schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: 'clean', verified: true,
  data: { operationId: 'j4-test', rooms: ['guest_bathroom'], outcome: 'started', dispatch: 'accepted',
    observation: { observedAt: at, sourceUpdatedAt: at, state: 'cleaning', activeSegments: [10], currentSegment: 10,
      taskStatus: { state: 'room_cleaning', sourceUpdatedAt: at } }, appliedSettings: {} },
  warnings: [], error: null, pendingContext: null,
};

test('Stage 6 checker accepts fresh idle preflight and bound durable success', () => {
  const evidence = { map, status: { state: 'docked', activeSegments: null },
    taskStatus: { state: 'completed' }, error: null };
  assert.equal(checkPreflight({ registry: canaryRegistry, claim: null, device: null, evidence, now: new Date(at) }).room,
    'guest_bathroom');
  assert.equal(checkOutcome({ registry, claim, device: null,
    history: { version: '1', result } }).segmentId, 10);
});

test('Stage 6 checker rejects used scope, unknown task and mismatched target', () => {
  const evidence = { map, status: { state: 'docked', activeSegments: null },
    taskStatus: { state: 'completed' }, error: null };
  assert.throws(() => checkPreflight({ registry: canaryRegistry, claim, device: null, evidence, now: new Date(at) }));
  assert.throws(() => checkPreflight({ registry: canaryRegistry, claim: null, device: null,
    evidence: { ...evidence, taskStatus: { state: 'unknown' } }, now: new Date(at) }));
  const altered = structuredClone(result);
  altered.data.observation.activeSegments = [8];
  assert.throws(() => checkOutcome({ registry, claim, device: null,
    history: { version: '1', result: altered } }));
  assert.throws(() => checkOutcome({ registry, claim, device: { active: { phase: 'uncertain' } }, history: null }));
});

test('Room canary live checker requires fresh exact current target evidence', () => {
  const hallway = registry.rooms.find((item) => item.slug === 'hallway');
  const hallwayCanary = { id: 'fc2-single-hallway-20260923', room: 'hallway', subject: 'oren' };
  const live = { map, status: { state: 'cleaning', activeSegments: [hallway.segmentId] },
    taskStatus: { state: 'room_cleaning', sourceUpdatedAt: at }, error: null };
  assert.equal(checkLiveOutcome({ registry, claim, evidence: live, now: new Date(at) }, hallwayCanary).liveSegmentId,
    hallway.segmentId);
  assert.throws(() => checkLiveOutcome({ registry, claim, evidence: {
    ...live, status: { state: 'cleaning', activeSegments: [10] },
  }, now: new Date(at) }, hallwayCanary));
  assert.throws(() => checkLiveOutcome({ registry, claim, evidence: {
    ...live, taskStatus: { state: 'room_cleaning', sourceUpdatedAt: new Date(Date.parse(claim.claimedAt) - 1).toISOString() },
  }, now: new Date(at) }, hallwayCanary));
});


test('FC2 multi-room checker requires the claimed exact segment set and fresh task transition', () => {
  const config = structuredClone(JSON.parse(readFileSync(new URL('../config/registry.v1.json', import.meta.url), 'utf8')));
  for (const capability of config.capabilities) delete capability.verifiedRoomSets;
  config.capabilities.find((item) => item.name === 'clean_multi_room').support = 'reported';
  config.underTest = { id: 'fc2-multi-fixture', capability: 'clean_multi_room',
    rooms: ['living_room', 'hallway'], subject: 'oren',
    expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  const scoped = loadRegistry(config);
  const canary = { id: config.underTest.id, rooms: config.underTest.rooms, subject: 'oren' };
  const evidence = { map, status: { state: 'docked', activeSegments: null },
    taskStatus: { state: 'completed' }, error: null };
  assert.deepEqual(checkPreflight({ registry: scoped, claim: null, device: null,
    evidence, now: new Date(at) }, canary).segmentIds, [8, 7]);
  const verified = structuredClone(result);
  verified.data.rooms = ['living_room', 'hallway'];
  verified.data.observation.activeSegments = [7, 8];
  verified.data.observation.currentSegment = 8;
  assert.deepEqual(checkOutcome({ registry: scoped, claim, device: null,
    history: { version: '1', result: verified } }, canary).segmentIds, [8, 7]);
  const live = { map, status: { state: 'cleaning', activeSegments: [7, 8] },
    taskStatus: { state: 'room_cleaning', sourceUpdatedAt: at }, error: null };
  assert.deepEqual(checkLiveOutcome({ registry: scoped, claim, evidence: live,
    now: new Date(at) }, canary).liveSegmentIds, [8, 7]);
  assert.throws(() => checkLiveOutcome({ registry: scoped, claim, evidence: {
    ...live, status: { state: 'cleaning', activeSegments: [8] },
  }, now: new Date(at) }, canary));
  const wrong = structuredClone(verified);
  wrong.data.observation.activeSegments = [8];
  assert.throws(() => checkOutcome({ registry: scoped, claim, device: null,
    history: { version: '1', result: wrong } }, canary));
  assert.throws(() => checkPreflight({ registry: scoped, claim: null, device: null,
    evidence, now: new Date(at) }, { ...canary, rooms: ['living_room', 'guest_bathroom'] }));
});


test('FC2 home checker requires reviewed exclusions, durable task proof and safe cleanup', () => {
  const config = structuredClone(JSON.parse(readFileSync(new URL('../config/registry.v1.json', import.meta.url), 'utf8')));
  config.underTest = { id: 'fc2-home-20260925', capability: 'clean_home', subject: 'oren',
    reviewedGeometrySha256: 'de38293681d645b1b6ef43435140650b0857745e22beab905b2dbd4f2e69aa7c',
    expiresAt: '2026-09-30T20:00:00+03:00', maxDispatches: 1 };
  const scoped = loadRegistry(config);
  const geometry = { sha256: config.underTest.reviewedGeometrySha256, mapId: 1,
    deviceMapListReadAt: at, savedMapLoadedAt: at,
    visibleSegmentIds: map.rooms.map((room) => room.id), hiddenSegmentIds: [3, 9, 15, 17],
    noGoCount: 1, noMopCount: 0, virtualWallCount: 5 };
  const idle = { map, status: { state: 'docked', activeSegments: null },
    taskStatus: { state: 'completed' }, taskDevice: { value: 0, sourceReadAt: at },
    homeGeometry: geometry, error: null };
  const preflight = checkHomePreflight({ registry: scoped, claim: null, device: null,
    evidence: idle, now: new Date(at) });
  assert.deepEqual(preflight.hiddenSegmentIds, [3, 9, 15, 17]);
  assert.throws(() => checkHomePreflight({ registry: scoped, claim, device: null,
    evidence: idle, now: new Date(at) }));
  for (const [key, value] of [
    ['hiddenSegmentIds', [3, 9, 15]], ['noGoCount', 0], ['virtualWallCount', 4],
    ['sha256', 'f'.repeat(64)],
  ]) {
    assert.throws(() => checkHomePreflight({ registry: scoped, claim: null, device: null,
      evidence: { ...idle, homeGeometry: { ...geometry, [key]: value } }, now: new Date(at) }));
  }
  const homeClaim = { ...claim, operationId: 'j4-home-test' };
  const homeResult = {
    schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: 'clean', verified: true,
    data: { operationId: 'j4-home-test', rooms: [], outcome: 'started', dispatch: 'accepted',
      observation: { observedAt: at, sourceUpdatedAt: at, state: 'cleaning',
        activeSegments: null, currentSegment: null,
        homeTask: { value: 1, sourceReadAt: at, mapListReadAt: at,
          geometrySha256: geometry.sha256 } }, appliedSettings: {} },
    warnings: [], error: null, pendingContext: null,
  };
  assert.equal(checkHomeOutcome({ registry: scoped, claim: homeClaim, device: null,
    history: { version: '1', result: homeResult } }).outcome, 'started');
  const cleaning = { ...idle, status: { state: 'cleaning', activeSegments: null },
    taskDevice: { value: 1, sourceReadAt: at } };
  assert.equal(checkHomeLive({ registry: scoped, claim: homeClaim,
    evidence: cleaning, now: new Date(at) }).deviceTaskValue, 1);
  assert.equal(checkHomeCleanup({ registry: scoped, claim: homeClaim,
    evidence: idle, now: new Date(at) }).deviceTaskValue, 0);
  assert.throws(() => checkHomeLive({ registry: scoped, claim: homeClaim,
    evidence: { ...cleaning, taskDevice: { value: 2, sourceReadAt: at } },
    now: new Date(at) }));
  const wrongResult = structuredClone(homeResult);
  wrongResult.data.observation.homeTask.geometrySha256 = 'f'.repeat(64);
  assert.throws(() => checkHomeOutcome({ registry: scoped, claim: homeClaim, device: null,
    history: { version: '1', result: wrongResult } }));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseReadRequest, parseExecuteRequest } from '../lib/schemas.mjs';
import { createDomainCore } from '../lib/domain-core.mjs';
import { assertFreshMap, fingerprintMap, loadRegistry, resolveRoom, resolveRooms } from '../lib/registry.mjs';
import { authorize, loadPolicy } from '../lib/policy.mjs';
import { validateResult } from '../lib/results.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const liveRegistryConfig = json('config/registry.v1.json');
const registryConfig = structuredClone(liveRegistryConfig);
for (const capability of registryConfig.capabilities) delete capability.verifiedRoomSets;
const promotedRegistryConfig = structuredClone(registryConfig);
delete registryConfig.underTest;
delete promotedRegistryConfig.underTest;
delete registryConfig.capabilities.find((item) => item.name === 'clean_settings').verifiedSettings;
const policyConfig = json('config/policy.v1.json');
const map = json('tests/fixtures/map-stage2-live.json');
const now = new Date(Date.parse(map.observedAt) + 1_000);
const identity = { source: 'trusted_runtime', senderId: 'family:oren', channelKind: 'direct', perSenderVerified: true };
const approvedPolicy = { version: '1', defaultDecision: 'deny', rules: [
  { subject: 'family:oren', actionClass: 'read', deviceScope: 'jessica-vacuum', decision: 'allow' },
  { subject: 'family:oren', actionClass: 'control', deviceScope: 'jessica-vacuum', decision: 'allow' },
] };
const code = (expected) => (error) => error.code === expected;
const previouslyVerifiedRoomSlugs = ['guest_bathroom', 'hallway', 'living_room'];
const allVerifiedRooms = registryConfig.rooms.filter((room) => room.enabled)
  .map((room) => [room.slug, room.segmentId]);
const restrictCleanRooms = (copy) => {
  copy.capabilities.find((item) => item.name === 'clean_single_room').verifiedRooms = copy.capabilities
    .find((item) => item.name === 'clean_single_room').verifiedRooms
    .filter((item) => previouslyVerifiedRoomSlugs.includes(item.room))
    .sort((left, right) => previouslyVerifiedRoomSlugs.indexOf(left.room) - previouslyVerifiedRoomSlugs.indexOf(right.room));
  copy.capabilities.find((item) => item.name === 'pause').verifiedRooms = copy.capabilities
    .find((item) => item.name === 'pause').verifiedRooms
    .filter((item) => previouslyVerifiedRoomSlugs.includes(item.room))
    .sort((left, right) => previouslyVerifiedRoomSlugs.indexOf(left.room) - previouslyVerifiedRoomSlugs.indexOf(right.room));
  return copy;
};
const historicalSingleRoomRegistry = () => restrictCleanRooms(structuredClone(promotedRegistryConfig));
const historicalHallwayPauseRegistry = () => {
  const copy = historicalSingleRoomRegistry();
  copy.capabilities.find((item) => item.name === 'pause').verifiedRooms = copy.capabilities
    .find((item) => item.name === 'pause').verifiedRooms.filter((item) => item.room === 'guest_bathroom');
  return copy;
};
const verifiedRegistry = () => {
  const copy = restrictCleanRooms(structuredClone(registryConfig));
  copy.capabilities.find((item) => item.name === 'clean_settings').support = 'verified';
  return copy;
};
const underTestRegistry = () => {
  const copy = structuredClone(registryConfig);
  delete copy.capabilities.find((item) => item.name === 'clean_single_room').verifiedRooms;
  for (const name of ['pause', 'dock']) {
    const control = copy.capabilities.find((item) => item.name === name);
    control.support = 'reported';
    delete control.verifiedRooms;
  }
  copy.underTest = { id: 'stage6-fixture', capability: 'clean_single_room', room: 'guest_bathroom',
    subject: 'oren', expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  return copy;
};

test('closed request schemas reject extra authority and malformed values', () => {
  assert.deepEqual(parseReadRequest({ operation: 'status' }), { operation: 'status' });
  assert.throws(() => parseReadRequest({ operation: 'status', requesterId: 'family:oren' }), code('INVALID_REQUEST'));
  assert.throws(() => parseReadRequest({ operation: 'room_settings', room: '' }), code('INVALID_REQUEST'));
  assert.equal(parseReadRequest({ operation: 'operation_status', operationId: 'j4-known' }).operationId, 'j4-known');
  assert.throws(() => parseReadRequest({ operation: 'operation_status', operationId: 'x'.repeat(129) }), code('INVALID_REQUEST'));
  assert.throws(() => parseExecuteRequest({ operation: 'clean', target: { kind: 'rooms', rooms: [] } }), code('INVALID_REQUEST'));
  assert.throws(() => parseExecuteRequest({ operation: 'clean', target: { kind: 'rooms', rooms: ['salon', 'salon'] } }), code('INVALID_REQUEST'));
  assert.throws(() => parseExecuteRequest({ operation: 'clean', target: { kind: 'rooms', rooms: ['salon'] }, settings: { wetness: 2.5 } }), code('INVALID_REQUEST'));
  for (const wetness of [0, 33]) {
    assert.throws(() => parseExecuteRequest({ operation: 'clean', target: { kind: 'rooms', rooms: ['salon'] }, settings: { wetness } }), code('INVALID_REQUEST'));
  }
  assert.equal(parseExecuteRequest({ operation: 'clean', target: { kind: 'rooms', rooms: ['salon'] }, settings: { wetness: 32 } }).settings.wetness, 32);
  assert.throws(() => parseExecuteRequest({ operation: 'clean', target: { kind: 'home', entity_id: 'vacuum.any' } }), code('INVALID_REQUEST'));
  assert.throws(() => parseExecuteRequest({ operation: 'dock', confirmed: true }), code('INVALID_REQUEST'));
});

test('home under-test registry and result are bound to Oren and a reviewed geometry digest', () => {
  const scoped = structuredClone(registryConfig);
  scoped.underTest = { id: 'fc2-home-fixture', capability: 'clean_home', subject: 'oren',
    reviewedGeometrySha256: 'de38293681d645b1b6ef43435140650b0857745e22beab905b2dbd4f2e69aa7c',
    expiresAt: '2026-09-30T20:00:00+03:00', maxDispatches: 1 };
  assert.doesNotThrow(() => loadRegistry(scoped));
  for (const bad of [
    { reviewedGeometrySha256: 'missing' }, { subject: 'ilana' },
    { maxDispatches: 2 }, { room: 'living_room' },
  ]) {
    const copy = structuredClone(scoped);
    Object.assign(copy.underTest, bad);
    assert.throws(() => loadRegistry(copy), code('INVALID_REGISTRY'));
  }
  const homeIdentity = { ...identity, senderId: 'oren' };
  const homeCore = createDomainCore(scoped, policyConfig);
  const request = { operation: 'clean', target: { kind: 'home' } };
  const plan = homeCore.prepareExecute(request, homeIdentity, { map }, now);
  assert.equal(plan.underTestId, 'fc2-home-fixture');
  assert.equal(plan.homeGeometrySha256, scoped.underTest.reviewedGeometrySha256);
  assert.throws(() => homeCore.prepareExecute(request, { ...homeIdentity, senderId: 'ilana' },
    { map }, now), code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => homeCore.prepareExecute({ ...request, settings: { suction: 'strong' } },
    homeIdentity, { map }, now), code('CAPABILITY_UNSUPPORTED'));
  const result = {
    schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: 'clean', verified: true,
    data: { operationId: 'home-op', rooms: [], outcome: 'started', dispatch: 'accepted',
      observation: { observedAt: map.observedAt, sourceUpdatedAt: map.observedAt,
        state: 'cleaning', activeSegments: null, currentSegment: null,
        homeTask: { value: 1, sourceReadAt: map.observedAt, mapListReadAt: map.observedAt,
          geometrySha256: plan.homeGeometrySha256 } }, appliedSettings: {} },
    warnings: [], error: null, pendingContext: null,
  };
  assert.equal(validateResult(result, plan, now).status, 'success');
  const wrong = structuredClone(result);
  wrong.data.observation.homeTask.geometrySha256 = 'f'.repeat(64);
  assert.throws(() => validateResult(wrong, plan, now), code('FALSE_SUCCESS'));
  const missing = structuredClone(result);
  delete missing.data.observation.homeTask;
  assert.throws(() => validateResult(missing, plan, now), code('FALSE_SUCCESS'));
});

test('registry has a stable live map fingerprint and rejects stale or changed maps', () => {
  const registry = loadRegistry(registryConfig);
  assert.equal(fingerprintMap(map), registry.mapFingerprint);
  assert.equal(fingerprintMap({ ...map, rooms: [...map.rooms].reverse() }), registry.mapFingerprint);
  assert.equal(assertFreshMap(registry, map, now), registry.mapBinding.generation);
  assert.throws(() => assertFreshMap(registry, map, new Date(Date.parse(map.observedAt) + 61_000)), code('MAP_STALE'));
  const changedRoom = structuredClone(map);
  changedRoom.rooms.find((room) => room.id === 8).name = 'Renamed';
  assert.throws(() => assertFreshMap(registry, changedRoom, now), code('MAP_CHANGED'));
  const changedWorkflow = structuredClone(map);
  changedWorkflow.shortcuts[0].tasks[0][0].suction_level += 1;
  assert.throws(() => assertFreshMap(registry, changedWorkflow, now), code('MAP_CHANGED'));
  assert.throws(() => assertFreshMap(registry, { ...map, mapId: 2 }, now), code('MAP_CHANGED'));
  const missingBinding = structuredClone(registryConfig);
  missingBinding.rooms.find((room) => room.slug === 'hallway').binding = null;
  assert.throws(() => loadRegistry(missingBinding), code('INVALID_REGISTRY'));
});

test('aliases resolve exactly; ambiguity, duplicate aliases and disabled rooms fail closed', () => {
  const registry = loadRegistry(registryConfig);
  assert.equal(resolveRoom(registry, 'סלון').slug, 'living_room');
  assert.equal(resolveRoom(registry, 'living-room').slug, 'living_room');
  assert.equal(resolveRoom(registry, 'הסלון').slug, 'living_room');
  assert.equal(resolveRoom(registry, 'המסדרון').slug, 'hallway');
  assert.equal(resolveRoom(registry, 'החדר של טל').slug, 'tal_room');
  assert.equal(resolveRoom(registry, 'האזור המרכזי בבית').slug, 'home_center');
  assert.equal(resolveRoom(registry, 'מטבח פינת ישיבה').slug, 'kitchen_sitting_area');
  assert.throws(() => resolveRoom(registry, 'חדר'), code('AMBIGUOUS_ROOM'));
  assert.throws(() => resolveRoom(registry, 'west_balcony'), code('ROOM_DISABLED'));
  for (const unknown of ['שירותים', 'חדר הילדים', 'Room 17', 'custom']) {
    assert.throws(() => resolveRoom(registry, unknown), code('UNKNOWN_ROOM'));
  }
  assert.throws(() => resolveRoom(registry, 'nonexistent'), code('UNKNOWN_ROOM'));
  assert.throws(() => resolveRooms(registry, ['salon', 'living_room']), code('DUPLICATE_ROOM'));
  assert.throws(() => resolveRooms(registry, Array(14).fill('salon')), code('INVALID_ROOM_SET'));
  const collision = structuredClone(registryConfig);
  collision.rooms.find((room) => room.slug === 'parents_room').aliases.push('salon');
  assert.throws(() => loadRegistry(collision), code('DUPLICATE_ALIAS'));
});

test('policy rejects unknown identity and group without trusted per-sender identity', () => {
  const policy = loadPolicy({ ...policyConfig, rules: [] });
  assert.throws(() => authorize(policy, identity, 'control'), code('NOT_AUTHORIZED'));
  const approved = loadPolicy(approvedPolicy);
  assert.equal(authorize(approved, identity, 'control').subject, 'family:oren');
  assert.throws(() => authorize(approved, { ...identity, senderId: 'unknown' }, 'control'), code('NOT_AUTHORIZED'));
  assert.throws(() => authorize(approved, { ...identity, source: 'model_argument' }, 'control'), code('IDENTITY_UNTRUSTED'));
  assert.throws(() => authorize(approved, { ...identity, channelKind: 'group', perSenderVerified: false }, 'control'), code('IDENTITY_UNTRUSTED'));
  assert.equal(authorize(approved, { ...identity, channelKind: 'group' }, 'control').subject, 'family:oren');
  const production = loadPolicy(policyConfig);
  const oren = { ...identity, senderId: 'oren' };
  for (const senderId of ['oren', 'ilana', 'amit', 'tal', 'harel']) {
    for (const channelKind of ['direct', 'group']) {
      assert.equal(authorize(production, { ...oren, senderId, channelKind }, 'control').subject, senderId);
    }
    assert.equal(authorize(production, { ...oren, senderId }, 'read').subject, senderId);
  }
  assert.throws(() => authorize(production, { ...oren, senderId: 'unknown' }, 'control'), code('NOT_AUTHORIZED'));
  assert.throws(() => authorize(production, { ...oren, channelKind: 'group', perSenderVerified: false }, 'control'), code('IDENTITY_UNTRUSTED'));
  const channelRestricted = structuredClone(policyConfig);
  channelRestricted.rules.find((rule) => rule.subject === 'oren' && rule.actionClass === 'control').channelKind = 'direct';
  assert.throws(() => loadPolicy(channelRestricted), code('INVALID_POLICY'));
});

test('domain core requires schema, policy, registry, live map and verified write capability', () => {
  const core = createDomainCore(verifiedRegistry(), approvedPolicy);
  assert.equal(core.prepareRead({ operation: 'rooms' }, identity, { map }, now).mapFingerprint, registryConfig.mapFingerprint);
  assert.throws(() => core.prepareExecute({ operation: 'clean', target: { kind: 'rooms', rooms: ['kitchen'] } }, identity, { map }, now), code('CAPABILITY_UNSUPPORTED'));
  const ready = createDomainCore(verifiedRegistry(), approvedPolicy);
  const plan = ready.prepareExecute({ operation: 'clean', target: { kind: 'rooms', rooms: ['salon'] } }, identity, { map }, now);
  assert.deepEqual(plan.rooms, [{ slug: 'living_room', segmentId: 8 }]);
  assert.throws(() => { plan.rooms[0].segmentId = 7; }, TypeError);
  assert.throws(() => ready.prepareExecute({ operation: 'clean', target: { kind: 'rooms', rooms: ['salon', 'hallway'] } }, identity, { map }, now), code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => ready.prepareExecute({ operation: 'clean', target: { kind: 'rooms', rooms: ['kitchen'] } }, identity, { map }, now), code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => ready.prepareExecute({ operation: 'clean', target: { kind: 'rooms', rooms: ['salon'] } }, identity, { map: { ...map, observedAt: '2000-01-01T00:00:00Z' } }, now), code('MAP_STALE'));
  assert.throws(() => ready.prepareExecute({ operation: 'clean', target: { kind: 'rooms', rooms: ['salon'], requesterId: 'family:oren' } }, identity, { map }, now), code('INVALID_REQUEST'));
  assert.throws(() => ready.prepareExecute({ operation: 'clean', target: { kind: 'rooms', rooms: ['salon'] } }, { ...identity, senderId: 'unknown' }, { map }, now), code('NOT_AUTHORIZED'));
});

test('ordinary kitchen stays a room target and never selects the saved workflow', () => {
  const ready = verifiedRegistry();
  ready.capabilities.find((item) => item.name === 'clean_single_room').verifiedRooms.push({
    room: 'kitchen', observedAt: map.observedAt, provenance: 'Deterministic FC2 fixture',
  });
  const plan = createDomainCore(ready, approvedPolicy).prepareExecute({ operation: 'clean',
    target: { kind: 'rooms', rooms: ['המטבח'] } }, identity, { map }, now);
  assert.deepEqual(plan.rooms, [{ slug: 'kitchen', segmentId: 12 }]);
  assert.equal(plan.workflowId, null);
  assert.equal(plan.mapGeneration, ready.mapBinding.generation);
});

test('multi-room preparation is all-or-nothing, preserves semantic order, and accepts ordinary kitchen', () => {
  const ready = verifiedRegistry();
  ready.capabilities.find((item) => item.name === 'clean_single_room').verifiedRooms.push({
    room: 'kitchen', observedAt: map.observedAt, provenance: 'Room fixture',
  });
  ready.capabilities.find((item) => item.name === 'clean_multi_room').verifiedRoomSets = [{
    rooms: ['living_room', 'kitchen'], observedAt: map.observedAt, provenance: 'Exact set fixture',
  }];
  const core = createDomainCore(ready, approvedPolicy);
  const plan = core.prepareExecute({ operation: 'clean', target: { kind: 'rooms',
    rooms: ['הסלון', 'המטבח'] } }, identity, { map }, now);
  assert.deepEqual(plan.rooms, [{ slug: 'living_room', segmentId: 8 }, { slug: 'kitchen', segmentId: 12 }]);
  assert.equal(plan.workflowId, null);
  assert.equal(plan.roomTaskSignal, true);
  assert.throws(() => core.prepareExecute({ operation: 'clean', target: { kind: 'rooms',
    rooms: ['הסלון', 'שירותים'] } }, identity, { map }, now), code('UNKNOWN_ROOM'));
});

test('one-shot multi-room scope accepts only Oren and the exact reviewed pair without settings', () => {
  const scoped = historicalSingleRoomRegistry();
  scoped.capabilities.find((item) => item.name === 'clean_multi_room').support = 'reported';
  scoped.underTest = { id: 'fc2-multi-fixture', capability: 'clean_multi_room',
    rooms: ['living_room', 'hallway'], subject: 'family:oren',
    expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  const core = createDomainCore(scoped, approvedPolicy);
  const request = (rooms, settings) => ({ operation: 'clean', target: { kind: 'rooms', rooms },
    ...(settings ? { settings } : {}) });
  const plan = core.prepareExecute(request(['הסלון', 'המסדרון']), identity, { map }, now);
  assert.deepEqual(plan.rooms.map((item) => item.segmentId), [8, 7]);
  assert.equal(plan.underTestId, scoped.underTest.id);
  assert.equal(core.prepareExecute(request(['hallway', 'living_room']), identity, { map }, now).underTestId,
    scoped.underTest.id);
  for (const rooms of [['living_room', 'guest_bathroom'], ['living_room', 'hallway', 'guest_bathroom']]) {
    assert.throws(() => core.prepareExecute(request(rooms), identity, { map }, now), code('CAPABILITY_UNSUPPORTED'));
  }
  assert.throws(() => core.prepareExecute(request(['living_room', 'hallway'], { suction: 'strong' }), identity,
    { map }, now), code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute(request(['living_room', 'hallway']),
    { ...identity, senderId: 'unknown' }, { map }, now), code('NOT_AUTHORIZED'));
  assert.throws(() => core.prepareExecute(request(['living_room', 'hallway']), identity,
    { map: { ...map, observedAt: '2000-01-01T00:00:00Z' } }, now), code('MAP_STALE'));
  for (const invalid of [
    { ...scoped.underTest, rooms: ['living_room', 'living_room'] },
    { ...scoped.underTest, rooms: ['living_room', 'kitchen'] },
    { ...scoped.underTest, rooms: ['living_room', 'hallway'], maxDispatches: 2 },
    { ...scoped.underTest, room: 'living_room' },
  ]) {
    const changed = structuredClone(scoped); changed.underTest = invalid;
    assert.throws(() => loadRegistry(changed), code('INVALID_REGISTRY'));
  }
});

test('FC2 Tal-room canary remains a bounded historical fixture', () => {
  const talConfig = historicalSingleRoomRegistry();
  talConfig.underTest = { id: 'fc2-tal-fixture', capability: 'clean_single_room', room: 'tal_room',
    subject: 'oren', expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  const scoped = loadRegistry(talConfig);
  assert.equal(scoped.underTest?.capability, 'clean_single_room');
  assert.equal(scoped.underTest.room, 'tal_room');
  assert.equal(scoped.underTest.subject, 'oren');
  const core = createDomainCore(talConfig, policyConfig);
  const oren = { ...identity, senderId: 'oren' };
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['החדר של טל'] } };
  const plan = core.prepareExecute(request, oren, { map }, now);
  assert.deepEqual(plan.rooms, [{ slug: 'tal_room', segmentId: 14 }]);
  assert.equal(plan.underTestId, scoped.underTest.id);
  assert.throws(() => core.prepareExecute(request, { ...oren, senderId: 'ilana' }, { map }, now),
    code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute({ ...request, settings: { suction: 'strong' } }, oren,
    { map }, now), code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute({ operation: 'clean', target: { kind: 'rooms',
    rooms: ['living_room', 'hallway'] } }, oren, { map }, now), code('CAPABILITY_UNSUPPORTED'));
});

test('FC2 dining-area canary remains a bounded historical fixture', () => {
  const diningConfig = historicalSingleRoomRegistry();
  diningConfig.underTest = { id: 'fc2-dining-fixture', capability: 'clean_single_room', room: 'dining_area',
    subject: 'oren', expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  const scoped = loadRegistry(diningConfig);
  assert.equal(scoped.underTest?.capability, 'clean_single_room');
  assert.equal(scoped.underTest.room, 'dining_area');
  assert.equal(scoped.underTest.subject, 'oren');
  const core = createDomainCore(diningConfig, policyConfig);
  const oren = { ...identity, senderId: 'oren' };
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['פינת אוכל'] } };
  const plan = core.prepareExecute(request, oren, { map }, now);
  assert.deepEqual(plan.rooms, [{ slug: 'dining_area', segmentId: 11 }]);
  assert.equal(plan.underTestId, scoped.underTest.id);
  assert.throws(() => core.prepareExecute(request, { ...oren, senderId: 'ilana' }, { map }, now),
    code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute({ ...request, settings: { suction: 'strong' } }, oren,
    { map }, now), code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute({ operation: 'clean', target: { kind: 'rooms',
    rooms: ['tal_room'] } }, oren, { map }, now), code('CAPABILITY_UNSUPPORTED'));
});

test('FC2 home-center canary remains a bounded historical fixture', () => {
  const homeConfig = historicalSingleRoomRegistry();
  homeConfig.underTest = { id: 'fc2-home-center-fixture', capability: 'clean_single_room', room: 'home_center',
    subject: 'oren', expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  const scoped = loadRegistry(homeConfig);
  assert.equal(scoped.underTest?.capability, 'clean_single_room');
  assert.equal(scoped.underTest.room, 'home_center');
  assert.equal(scoped.underTest.subject, 'oren');
  const core = createDomainCore(homeConfig, policyConfig);
  const oren = { ...identity, senderId: 'oren' };
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['מרכז הבית'] } };
  const plan = core.prepareExecute(request, oren, { map }, now);
  assert.deepEqual(plan.rooms, [{ slug: 'home_center', segmentId: 13 }]);
  assert.equal(plan.underTestId, scoped.underTest.id);
  assert.throws(() => core.prepareExecute(request, { ...oren, senderId: 'ilana' }, { map }, now),
    code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute({ ...request, settings: { suction: 'strong' } }, oren,
    { map }, now), code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute({ operation: 'clean', target: { kind: 'rooms',
    rooms: ['dining_area'] } }, oren, { map }, now), code('CAPABILITY_UNSUPPORTED'));
});

test('FC2 kitchen canary remains a bounded historical fixture', () => {
  const kitchenConfig = historicalSingleRoomRegistry();
  kitchenConfig.underTest = { id: 'fc2-kitchen-fixture', capability: 'clean_single_room', room: 'kitchen',
    subject: 'oren', expiresAt: '2026-09-28T20:00:00+03:00', maxDispatches: 1 };
  const scoped = loadRegistry(kitchenConfig);
  assert.equal(scoped.underTest?.capability, 'clean_single_room');
  assert.equal(scoped.underTest.room, 'kitchen');
  assert.equal(scoped.underTest.subject, 'oren');
  const core = createDomainCore(kitchenConfig, policyConfig);
  const oren = { ...identity, senderId: 'oren' };
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['המטבח'] } };
  const plan = core.prepareExecute(request, oren, { map }, now);
  assert.deepEqual(plan.rooms, [{ slug: 'kitchen', segmentId: 12 }]);
  assert.equal(plan.underTestId, scoped.underTest.id);
  assert.throws(() => core.prepareExecute(request, { ...oren, senderId: 'ilana' }, { map }, now),
    code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute({ ...request, settings: { suction: 'strong' } }, oren,
    { map }, now), code('CAPABILITY_UNSUPPORTED'));
  for (const other of ['home_center', 'dining_area', 'kitchen_sitting_area']) {
    assert.throws(() => core.prepareExecute({ operation: 'clean', target: { kind: 'rooms',
      rooms: [other] } }, oren, { map }, now), code('CAPABILITY_UNSUPPORTED'));
  }
});

test('FC2 kitchen-sitting canary remains a bounded historical fixture', () => {
  const sittingConfig = historicalSingleRoomRegistry();
  sittingConfig.underTest = { id: 'fc2-kitchen-sitting-fixture', capability: 'clean_single_room',
    room: 'kitchen_sitting_area', subject: 'oren',
    expiresAt: '2026-09-29T20:00:00+03:00', maxDispatches: 1 };
  const scoped = loadRegistry(sittingConfig);
  assert.equal(scoped.underTest?.capability, 'clean_single_room');
  assert.equal(scoped.underTest.room, 'kitchen_sitting_area');
  assert.equal(scoped.underTest.subject, 'oren');
  const core = createDomainCore(sittingConfig, policyConfig);
  const oren = { ...identity, senderId: 'oren' };
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['פינת הישיבה במטבח'] } };
  const plan = core.prepareExecute(request, oren, { map }, now);
  assert.deepEqual(plan.rooms, [{ slug: 'kitchen_sitting_area', segmentId: 16 }]);
  assert.equal(plan.underTestId, scoped.underTest.id);
  assert.throws(() => core.prepareExecute(request, { ...oren, senderId: 'ilana' }, { map }, now),
    code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute({ ...request, settings: { suction: 'strong' } }, oren,
    { map }, now), code('CAPABILITY_UNSUPPORTED'));
  for (const other of ['kitchen', 'dining_area', 'home_center']) {
    assert.throws(() => core.prepareExecute({ operation: 'clean', target: { kind: 'rooms',
      rooms: [other] } }, oren, { map }, now), code('CAPABILITY_UNSUPPORTED'));
  }
});

test('FC2 production single-room scope remains available without a canary', () => {
  assert.equal(loadRegistry(liveRegistryConfig).underTest ?? null, null);
  const core = createDomainCore(promotedRegistryConfig, policyConfig);
  const oren = { ...identity, senderId: 'oren' };
  for (const [room, segmentId] of allVerifiedRooms) {
    const plan = core.prepareExecute({ operation: 'clean', target: { kind: 'rooms', rooms: [room] } },
      oren, { map }, now);
    assert.equal(plan.underTestId, null);
    assert.deepEqual(plan.rooms, [{ slug: room, segmentId }]);
  }
});

test('reviewed room renumbering requires a new coherent generation before resolution can continue', () => {
  const changedMap = structuredClone(map);
  changedMap.rooms.find((room) => room.id === 7).id = 17;
  const changed = structuredClone(registryConfig);
  changed.mapFingerprint = fingerprintMap(changedMap);
  changed.mapBinding.generation = `map-1-${changed.mapFingerprint}`;
  changed.mapBinding.observedAt = changedMap.observedAt;
  changed.rooms.find((room) => room.slug === 'hallway').segmentId = 17;
  for (const room of changed.rooms) if (room.binding) room.binding.generation = changed.mapBinding.generation;
  const reviewed = loadRegistry(changed);
  assert.equal(assertFreshMap(reviewed, changedMap, now), changed.mapBinding.generation);
  assert.equal(resolveRoom(reviewed, 'המסדרון').segmentId, 17);
  assert.throws(() => assertFreshMap(loadRegistry(registryConfig), changedMap, now), code('MAP_CHANGED'));
});

test('all reviewed single rooms are allowed only under policy while broader scopes stay blocked', () => {
  const core = createDomainCore(registryConfig, policyConfig);
  const oren = { source: 'trusted_runtime', senderId: 'oren', channelKind: 'direct', perSenderVerified: true };
  const clean = (room) => ({ operation: 'clean', target: { kind: 'rooms', rooms: [room] } });
  for (const senderId of ['oren', 'ilana', 'amit', 'tal', 'harel']) {
    const requester = { ...oren, senderId };
    for (const [room, segmentId] of allVerifiedRooms) {
      const allowed = core.prepareExecute(clean(room), requester, { map }, now);
      assert.equal(allowed.underTestId, null);
      assert.equal(allowed.roomTaskSignal, true);
      assert.deepEqual(allowed.rooms, [{ slug: room, segmentId }]);
    }
    for (const room of registryConfig.rooms.filter((item) => !item.enabled)) {
      assert.throws(() => core.prepareExecute(clean(room.slug), requester, { map }, now), code('ROOM_DISABLED'));
    }
  }
  assert.equal(core.prepareExecute(clean('guest_bathroom'), { ...oren, channelKind: 'group' }, { map }, now).rooms[0].slug,
    'guest_bathroom');
  assert.throws(() => core.prepareExecute(clean('guest_bathroom'), { ...oren, channelKind: 'group', perSenderVerified: false }, { map }, now), code('IDENTITY_UNTRUSTED'));
  assert.throws(() => core.prepareExecute({ ...clean('guest_bathroom'), settings: {} }, oren, { map }, now), code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute(clean('guest_bathroom'), { ...oren, senderId: 'unknown' }, { map }, now), code('NOT_AUTHORIZED'));
  const global = structuredClone(registryConfig);
  const capability = global.capabilities.find((item) => item.name === 'clean_single_room');
  delete capability.verifiedRooms;
  capability.support = 'verified';
  assert.throws(() => loadRegistry(global), code('INVALID_REGISTRY'));
  assert.equal(registryConfig.capabilities.find((item) => item.name === 'clean_single_room').support, 'reported');
  assert.equal(registryConfig.underTest, undefined);
  const deferredRequests = [
    { operation: 'clean', target: { kind: 'home' } },
    { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom', 'hallway'] } },
    ...['resume', 'stop'].map((operation) => ({ operation })),
  ];
  for (const request of deferredRequests) {
    assert.throws(() => core.prepareExecute(request, oren, { map }, now), code('CAPABILITY_UNSUPPORTED'));
  }
});

test('pause covers all reviewed single rooms while dock remains guest-bathroom-only', () => {
  const core = createDomainCore(registryConfig, policyConfig);
  const identityFor = (senderId) => ({ source: 'trusted_runtime', senderId,
    channelKind: 'direct', perSenderVerified: true });
  for (const [room, segmentId] of allVerifiedRooms) {
    const evidence = { map, status: { state: 'cleaning', activeSegments: [segmentId] } };
    for (const senderId of ['oren', 'ilana', 'amit', 'tal', 'harel']) {
      const plan = core.prepareExecute({ operation: 'pause' }, identityFor(senderId), evidence, now);
      assert.equal(plan.underTestId, null);
      assert.deepEqual(plan.rooms, [{ slug: room, segmentId }]);
    }
  }
  const guestEvidence = { map, status: { state: 'cleaning', activeSegments: [10] } };
  for (const senderId of ['oren', 'ilana', 'amit', 'tal', 'harel']) {
    const plan = core.prepareExecute({ operation: 'dock' }, identityFor(senderId), guestEvidence, now);
    assert.equal(plan.underTestId, null);
    assert.deepEqual(plan.rooms, [{ slug: 'guest_bathroom', segmentId: 10 }]);
  }
  for (const operation of ['pause', 'dock']) {
    assert.throws(() => core.prepareExecute({ operation }, identityFor('unknown'), guestEvidence, now),
      code('NOT_AUTHORIZED'));
    assert.throws(() => core.prepareExecute({ operation }, identityFor('oren'),
      { map, status: { state: 'docked', activeSegments: null } }, now), code('NO_ACTIVE_TASK'));
  }
  assert.throws(() => core.prepareExecute({ operation: 'dock' }, identityFor('oren'),
    { map, status: { state: 'cleaning', activeSegments: [7] } }, now), code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute({ operation: 'pause' }, identityFor('oren'),
    { map, status: { state: 'cleaning', activeSegments: [8, 7] } }, now), code('CAPABILITY_UNSUPPORTED'));
});

test('FC2 hallway pause canary keeps verified guest control and binds only Oren to hallway', () => {
  const scoped = historicalHallwayPauseRegistry();
  scoped.underTest = { id: 'fc2-pause-hallway-fixture', capability: 'pause', room: 'hallway',
    subject: 'oren', expiresAt: '2026-09-29T20:00:00+03:00', maxDispatches: 1 };
  const core = createDomainCore(scoped, policyConfig);
  const direct = (senderId) => ({ ...identity, senderId });
  const active = (segmentId) => ({ map, status: { state: 'cleaning', activeSegments: [segmentId] } });
  assert.equal(core.prepareExecute({ operation: 'pause' }, direct('oren'), active(7), now).underTestId,
    scoped.underTest.id);
  assert.throws(() => core.prepareExecute({ operation: 'pause' }, direct('ilana'), active(7), now),
    code('CAPABILITY_UNSUPPORTED'));
  assert.equal(core.prepareExecute({ operation: 'pause' }, direct('ilana'), active(10), now).underTestId,
    null);
  assert.throws(() => core.prepareExecute({ operation: 'pause' }, direct('oren'), active(8), now),
    code('CAPABILITY_UNSUPPORTED'));
  for (const room of ['guest_bathroom', 'tal_room']) {
    const invalid = structuredClone(scoped); invalid.underTest.room = room;
    assert.throws(() => loadRegistry(invalid), code('INVALID_REGISTRY'));
  }
});

test('under-test dispatch remains one-room and policy-governed', () => {
  const canary = underTestRegistry();
  const core = createDomainCore(canary, policyConfig);
  const oren = { source: 'trusted_runtime', senderId: 'oren', channelKind: 'direct', perSenderVerified: true };
  const clean = (room) => ({ operation: 'clean', target: { kind: 'rooms', rooms: [room] } });
  assert.equal(core.prepareExecute(clean('guest_bathroom'), oren, { map }, now).underTestId, canary.underTest.id);
  assert.throws(() => core.prepareExecute(clean('hallway'), oren, { map }, now), code('CAPABILITY_UNSUPPORTED'));
  assert.equal(core.prepareExecute(clean('guest_bathroom'), { ...oren, channelKind: 'group' }, { map }, now).underTestId,
    canary.underTest.id);
  assert.throws(() => core.prepareExecute(clean('guest_bathroom'), { ...oren, senderId: 'family:other' },
    { map }, now), code('NOT_AUTHORIZED'));
  const expiredMap = { ...map, observedAt: '2026-09-27T17:00:00Z' };
  assert.throws(() => core.prepareExecute(clean('guest_bathroom'), oren, { map: expiredMap }, new Date('2026-09-27T17:00:00Z')), code('CAPABILITY_UNSUPPORTED'));
  const invalid = structuredClone(canary);
  invalid.underTest.room = 'west_balcony';
  assert.throws(() => loadRegistry(invalid), code('INVALID_REGISTRY'));
});

test('promoted hallway cleaning is family-wide and rejects the guest-bathroom setting before dispatch', () => {
  const core = createDomainCore(promotedRegistryConfig, policyConfig);
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['hallway'] } };
  for (const senderId of ['oren', 'ilana', 'amit', 'tal', 'harel']) {
    const identity = { source: 'trusted_runtime', senderId, channelKind: 'direct', perSenderVerified: true };
    const plan = core.prepareExecute(request, identity, { map }, now);
    assert.equal(plan.underTestId, null);
    assert.deepEqual(plan.rooms, [{ slug: 'hallway', segmentId: 7 }]);
  }
  const oren = { source: 'trusted_runtime', senderId: 'oren', channelKind: 'direct', perSenderVerified: true };
  assert.throws(() => core.prepareExecute({ ...request, settings: { suction: 'strong' } }, oren,
    { map, options: { observedAt: map.observedAt, suction: ['strong'] } }, now), code('CAPABILITY_UNSUPPORTED'));
});

test('promoted living-room cleaning is family-wide and has no settings authority', () => {
  const core = createDomainCore(promotedRegistryConfig, policyConfig);
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['living_room'] } };
  for (const senderId of ['oren', 'ilana', 'amit', 'tal', 'harel']) {
    const identity = { source: 'trusted_runtime', senderId, channelKind: 'direct', perSenderVerified: true };
    const plan = core.prepareExecute(request, identity, { map }, now);
    assert.equal(plan.underTestId, null);
    assert.deepEqual(plan.rooms, [{ slug: 'living_room', segmentId: 8 }]);
  }
  const oren = { source: 'trusted_runtime', senderId: 'oren', channelKind: 'direct', perSenderVerified: true };
  assert.throws(() => core.prepareExecute({ ...request, settings: { suction: 'strong' } }, oren,
    { map, options: { observedAt: map.observedAt, suction: ['strong'] } }, now), code('CAPABILITY_UNSUPPORTED'));
});

test('Stage 7 suction scope is exact, temporary and available equally to approved family', () => {
  const scoped = structuredClone(registryConfig);
  scoped.underTest = { id: 'stage7-suction-fixture', capability: 'clean_settings', room: 'guest_bathroom',
    settings: { suction: 'strong' }, expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 2 };
  const core = createDomainCore(scoped, policyConfig);
  const options = { observedAt: map.observedAt, suction: ['quiet', 'standard', 'strong', 'turbo'] };
  const identityFor = (senderId) => ({ source: 'trusted_runtime', senderId, channelKind: 'direct', perSenderVerified: true });
  const clean = (room, settings) => ({ operation: 'clean', target: { kind: 'rooms', rooms: [room] }, settings });
  for (const senderId of ['oren', 'ilana', 'amit', 'tal', 'harel']) {
    const plan = core.prepareExecute(clean('guest_bathroom', { suction: 'strong' }), identityFor(senderId),
      { map, options }, now);
    assert.equal(plan.underTestId, scoped.underTest.id);
    assert.deepEqual(plan.settings, { suction: 'strong' });
  }
  const oren = identityFor('oren');
  for (const request of [clean('guest_bathroom', { suction: 'quiet' }),
    clean('guest_bathroom', { mode: 'sweeping' }), clean('hallway', { suction: 'strong' }),
    { operation: 'clean', target: { kind: 'home' }, settings: { suction: 'strong' } }]) {
    assert.throws(() => core.prepareExecute(request, oren, { map, options }, now), code('CAPABILITY_UNSUPPORTED'));
  }
  assert.throws(() => core.prepareExecute(clean('guest_bathroom', { suction: 'strong' }), identityFor('unknown'),
    { map, options }, now), code('NOT_AUTHORIZED'));
  assert.throws(() => core.prepareExecute(clean('guest_bathroom', { suction: 'strong' }),
    { ...oren, channelKind: 'group', perSenderVerified: false }, { map, options }, now), code('IDENTITY_UNTRUSTED'));
  const bad = structuredClone(scoped);
  bad.underTest.settings = { suction: 'strong', mode: 'sweeping' };
  assert.throws(() => loadRegistry(bad), code('INVALID_REGISTRY'));
  bad.underTest.settings = { suction: 'strong' };
  bad.underTest.room = 'kitchen';
  assert.throws(() => loadRegistry(bad), code('INVALID_REGISTRY'));
});

test('promoted suction is verified only for guest bathroom and available to the approved family', () => {
  const registry = loadRegistry(promotedRegistryConfig);
  const capability = registry.capabilities.find((item) => item.name === 'clean_settings');
  assert.equal(capability.support, 'reported');
  assert.deepEqual(capability.verifiedSettings.map((item) => ({ room: item.room, settings: item.settings })),
    [{ room: 'guest_bathroom', settings: { suction: 'strong' } }]);
  const core = createDomainCore(promotedRegistryConfig, policyConfig);
  const readPlan = core.prepareRead({ operation: 'capabilities' },
    { source: 'trusted_runtime', senderId: 'oren', channelKind: 'direct', perSenderVerified: true }, {}, now);
  assert.equal(validateResult({ schemaVersion: '1', status: 'success', domain: 'jessica-vacuum',
    operation: 'capabilities', verified: true, data: { kind: 'capabilities', observedAt: now.toISOString(),
      sourceUpdatedAt: null, freshness: 'fresh', capabilities: readPlan.capabilityInventory },
    warnings: [], error: null, pendingContext: null }, null, now).status, 'success');
  const options = { observedAt: map.observedAt, suction: ['quiet', 'standard', 'strong', 'turbo'] };
  const clean = (room, suction) => ({ operation: 'clean', target: { kind: 'rooms', rooms: [room] },
    settings: { suction } });
  const identityFor = (senderId) => ({ source: 'trusted_runtime', senderId,
    channelKind: 'direct', perSenderVerified: true });
  for (const senderId of ['oren', 'ilana', 'amit', 'tal', 'harel']) {
    const identity = identityFor(senderId);
    const plan = core.prepareExecute(clean('guest_bathroom', 'strong'), identity, { map, options }, now);
    assert.equal(plan.underTestId, null);
    assert.deepEqual(plan.settings, { suction: 'strong' });
    for (const room of promotedRegistryConfig.rooms.filter((item) => item.slug !== 'guest_bathroom')) {
      assert.throws(() => core.prepareExecute(clean(room.slug, 'strong'), identity, { map, options }, now),
        code(room.enabled ? 'CAPABILITY_UNSUPPORTED' : 'ROOM_DISABLED'));
    }
    for (const suction of ['quiet', 'standard', 'turbo']) {
      assert.throws(() => core.prepareExecute(clean('guest_bathroom', suction), identity,
        { map, options }, now), code('CAPABILITY_UNSUPPORTED'));
    }
  }
  assert.throws(() => core.prepareExecute(clean('guest_bathroom', 'strong'), identityFor('unknown'),
    { map, options }, now), code('NOT_AUTHORIZED'));
  assert.throws(() => core.prepareExecute(clean('guest_bathroom', 'strong'),
    { ...identityFor('oren'), channelKind: 'group', perSenderVerified: false },
    { map, options }, now), code('IDENTITY_UNTRUSTED'));
  const global = structuredClone(promotedRegistryConfig);
  global.capabilities.find((item) => item.name === 'clean_settings').support = 'verified';
  assert.throws(() => loadRegistry(global), code('INVALID_REGISTRY'));
  const wrongRoomEvidence = structuredClone(promotedRegistryConfig);
  wrongRoomEvidence.capabilities.find((item) => item.name === 'clean_settings').verifiedSettings[0].room = 'west_balcony';
  assert.throws(() => loadRegistry(wrongRoomEvidence), code('INVALID_REGISTRY'));
});

test('settings range comes from fresh entity evidence, never a baked-in 1–32 assumption', () => {
  const core = createDomainCore(verifiedRegistry(), approvedPolicy);
  const options = { observedAt: map.observedAt, suction: ['quiet', 'standard'], mode: ['sweeping'], wetness: { min: 2, max: 8, step: 2 } };
  const request = (wetness) => ({ operation: 'clean', target: { kind: 'rooms', rooms: ['salon'] }, settings: { wetness } });
  assert.throws(() => core.prepareExecute(request(3), identity, { map, options }, now), code('SETTING_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute(request(4), identity, { map, options: { ...options, observedAt: '2000-01-01T00:00:00Z' } }, now), code('OPTIONS_UNVERIFIED'));
  assert.equal(core.prepareExecute(request(4), identity, { map, options }, now).settings.wetness, 4);
});

test('result contract rejects false physical success and accepts bound evidence', () => {
  const core = createDomainCore(verifiedRegistry(), approvedPolicy);
  const plan = core.prepareExecute({ operation: 'clean', target: { kind: 'rooms', rooms: ['salon'] } }, identity, { map }, now);
  const result = {
    schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: 'clean', verified: true,
    data: { operationId: 'op-1', rooms: ['living_room'], outcome: 'started', dispatch: 'accepted',
      observation: { observedAt: map.observedAt, sourceUpdatedAt: map.observedAt, state: 'cleaning', activeSegments: [8], currentSegment: 8,
        taskStatus: { state: 'room_cleaning', sourceUpdatedAt: map.observedAt } },
      appliedSettings: {} },
    warnings: [], error: null, pendingContext: null,
  };
  assert.equal(validateResult(result, plan, now).status, 'success');
  assert.throws(() => validateResult(result, null, now), code('FALSE_SUCCESS'));
  assert.throws(() => validateResult({ ...result, data: { ...result.data, outcome: 'accepted' } }, plan, now), code('FALSE_SUCCESS'));
  assert.throws(() => validateResult({ ...result, data: { ...result.data, observation: null } }, plan, now), code('FALSE_SUCCESS'));
  assert.throws(() => validateResult({ ...result, data: { ...result.data, observation: { ...result.data.observation, activeSegments: [7] } } }, plan, now), code('FALSE_SUCCESS'));
  const withoutTaskStatus = structuredClone(result);
  delete withoutTaskStatus.data.observation.taskStatus;
  assert.throws(() => validateResult(withoutTaskStatus, plan, now), code('FALSE_SUCCESS'));
  assert.throws(() => validateResult({ ...result, data: { ...result.data, outcome: 'completed', observation: { ...result.data.observation, state: 'docked' } } }, plan, now), code('FALSE_SUCCESS'));
  assert.throws(() => validateResult({ ...result, error: { code: 'X' } }, plan, now), code('INVALID_RESULT'));
  const options = { observedAt: map.observedAt, wetness: { min: 2, max: 8, step: 2 } };
  const settingsPlan = core.prepareExecute({ operation: 'clean', target: { kind: 'rooms', rooms: ['salon'] },
    settings: { wetness: 4 } }, identity, { map, options }, now);
  assert.throws(() => validateResult(result, settingsPlan, now), code('FALSE_SUCCESS'));
  const homeRegistry = verifiedRegistry();
  homeRegistry.capabilities.find((item) => item.name === 'clean_home').support = 'verified';
  assert.throws(() => createDomainCore(homeRegistry, approvedPolicy).prepareExecute({ operation: 'clean',
    target: { kind: 'home' } }, identity, { map }, now), code('CAPABILITY_UNSUPPORTED'));
});

test('failure, clarification and fresh read envelopes preserve their own invariants', () => {
  const failure = { schemaVersion: '1', status: 'failure', domain: 'jessica-vacuum', operation: null,
    verified: false, data: null, warnings: [], error: { code: 'INVALID_REQUEST', stage: 'input', retryable: false,
      retryMode: 'none', sideEffects: 'none', message: 'Invalid request' }, pendingContext: null };
  assert.equal(validateResult(failure).status, 'failure');
  const clarification = { schemaVersion: '1', status: 'clarification_required', domain: 'jessica-vacuum',
    operation: 'clean', verified: false, data: { question: 'Which room?', candidates: [
      { room: 'harel_room', label: 'חדר הראל' }, { room: 'parents_room', label: 'חדר הורים' },
    ] }, warnings: [], error: null, pendingContext: { version: '1', clarificationId: 'clar-1', expiresAt: new Date(now.getTime() + 60_000).toISOString() } };
  assert.equal(validateResult(clarification, null, now).status, 'clarification_required');
  assert.throws(() => validateResult({ ...clarification, pendingContext: null }, null, now), code('INVALID_RESULT'));
  assert.throws(() => validateResult({ ...clarification, pendingContext: { ...clarification.pendingContext, expiresAt: map.observedAt } }, null, now), code('INVALID_RESULT'));
  const read = { schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: 'status',
    verified: true, data: { kind: 'status', observedAt: map.observedAt, sourceUpdatedAt: map.observedAt,
      freshness: 'fresh', state: 'docked', batteryLevel: 100, activeSegments: null, currentSegment: null },
    warnings: [], error: null, pendingContext: null };
  assert.equal(validateResult(read, null, now).status, 'success');
  assert.throws(() => validateResult({ ...read, data: { ...read.data, freshness: 'stale' } }, null, now), code('FALSE_SUCCESS'));
});

test('FC2 multi-room pause historical fixture binds exact unordered pair to Oren and leaves family singles intact', () => {
  const scoped = structuredClone(registryConfig);
  scoped.underTest = { id: 'fc2-pause-multi-fixture', capability: 'pause',
    rooms: ['living_room', 'hallway'], subject: 'oren',
    expiresAt: '2026-09-30T20:00:00+03:00', maxDispatches: 1 };
  const core = createDomainCore(scoped, policyConfig);
  const direct = (senderId) => ({ ...identity, senderId });
  const active = (segments) => ({ map, status: { state: 'cleaning', activeSegments: segments } });
  for (const segments of [[8, 7], [7, 8]]) {
    const plan = core.prepareExecute({ operation: 'pause' }, direct('oren'), active(segments), now);
    assert.equal(plan.underTestId, scoped.underTest.id);
    assert.deepEqual(plan.rooms.map((room) => room.segmentId), segments);
    assert.throws(() => core.prepareExecute({ operation: 'pause' }, direct('ilana'), active(segments), now),
      code('CAPABILITY_UNSUPPORTED'));
  }
  for (const segments of [[8, 11], [8, 7, 11], [8, 8]]) {
    assert.throws(() => core.prepareExecute({ operation: 'pause' }, direct('oren'), active(segments), now));
  }
  assert.equal(core.prepareExecute({ operation: 'pause' }, direct('ilana'), active([8]), now).underTestId, null);
  assert.throws(() => core.prepareExecute({ operation: 'dock' }, direct('oren'), active([8, 7]), now),
    code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute({ operation: 'clean', target: { kind: 'rooms',
    rooms: ['living_room', 'hallway'] } }, direct('oren'), { map }, now), code('CAPABILITY_UNSUPPORTED'));
  for (const invalid of [
    { rooms: ['living_room', 'living_room'] },
    { rooms: ['living_room', 'unknown'] },
    { rooms: ['living_room', 'hallway', 'dining_area'] },
    { capability: 'dock' },
  ]) {
    const copy = structuredClone(scoped);
    Object.assign(copy.underTest, invalid);
    assert.throws(() => loadRegistry(copy), code('INVALID_REGISTRY'));
  }
});

test('production exact-pair scope is family-wide and all other multi-room sets fail closed', () => {
  const core = createDomainCore(liveRegistryConfig, policyConfig);
  const request = (rooms, settings) => ({ operation: 'clean', target: { kind: 'rooms', rooms },
    ...(settings ? { settings } : {}) });
  for (const senderId of ['oren', 'ilana', 'amit', 'tal', 'harel']) {
    const trusted = { ...identity, senderId };
    for (const pair of [['living_room', 'hallway'], ['hallway', 'living_room']]) {
      const cleanPlan = core.prepareExecute(request(pair), trusted, { map }, now);
      assert.equal(cleanPlan.underTestId, null);
      assert.deepEqual(cleanPlan.rooms.map((room) => room.slug), pair);
      const pausePlan = core.prepareExecute({ operation: 'pause' }, trusted,
        { map, status: { state: 'cleaning', activeSegments: pair.map((slug) => slug === 'living_room' ? 8 : 7) } }, now);
      assert.equal(pausePlan.underTestId, null);
      assert.deepEqual(pausePlan.rooms.map((room) => room.slug), pair);
    }
    for (const pair of [['living_room', 'guest_bathroom'], ['living_room', 'hallway', 'kitchen']]) {
      assert.throws(() => core.prepareExecute(request(pair), trusted, { map }, now), code('CAPABILITY_UNSUPPORTED'));
      assert.throws(() => core.prepareExecute({ operation: 'pause' }, trusted,
        { map, status: { state: 'cleaning', activeSegments: pair.map((slug) =>
          liveRegistryConfig.rooms.find((room) => room.slug === slug).segmentId) } }, now), code('CAPABILITY_UNSUPPORTED'));
    }
  }
  const oren = { ...identity, senderId: 'oren' };
  assert.throws(() => core.prepareExecute(request(['living_room', 'hallway'], { suction: 'strong' }),
    oren, { map }, now), code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute({ operation: 'dock' }, oren,
    { map, status: { state: 'cleaning', activeSegments: [8, 7] } }, now), code('CAPABILITY_UNSUPPORTED'));
  assert.throws(() => core.prepareExecute(request(['living_room', 'hallway']), oren,
    { map: { ...map, observedAt: '2000-01-01T00:00:00Z' } }, now), code('MAP_STALE'));
});

test('registry rejects widened or inconsistent verified room sets', () => {
  const invalid = (mutate) => { const copy = structuredClone(liveRegistryConfig); mutate(copy);
    assert.throws(() => loadRegistry(copy), code('INVALID_REGISTRY')); };
  invalid((copy) => { copy.capabilities.find((cap) => cap.name === 'clean_multi_room').support = 'verified'; });
  invalid((copy) => { copy.capabilities.find((cap) => cap.name === 'clean_multi_room').verifiedRoomSets.push({
    ...copy.capabilities.find((cap) => cap.name === 'clean_multi_room').verifiedRoomSets[0],
    rooms: ['hallway', 'living_room'],
  }); });
  invalid((copy) => { copy.capabilities.find((cap) => cap.name === 'pause').verifiedRoomSets[0].rooms =
    ['living_room', 'guest_bathroom']; });
  invalid((copy) => { copy.capabilities.find((cap) => cap.name === 'clean_multi_room').verifiedRoomSets[0].rooms =
    ['living_room', 'living_room']; });
  invalid((copy) => { copy.capabilities.find((cap) => cap.name === 'clean_multi_room').verifiedRoomSets[0].rooms =
    ['living_room', 'west_balcony']; });
});
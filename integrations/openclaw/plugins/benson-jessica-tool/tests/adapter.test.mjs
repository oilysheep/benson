import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createJessicaReadToolFactory } from '../dist/tool.js';
import { createJessicaExecuteToolFactory } from '../dist/execute-tool.js';
import { createOperationState } from '../dist/operation-state.js';
import { assertRosterPolicyAgreement, loadTrustedRoutes, resolveTrustedIdentity } from '../dist/identity.js';
import { projectMap, projectStatus, projectSensorCollection } from '../../../../../agents/jessica-vacuum/lib/ha-read.mjs';
import { fingerprintMap } from '../../../../../agents/jessica-vacuum/lib/registry.mjs';
import { authorize, loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.mjs';
import { checkAfter } from '../../../../../agents/jessica-vacuum/tests/check-fc0-read-canary.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const currentRegistry = json('agents/jessica-vacuum/config/registry.v1.json');
const allRoomSlugs = currentRegistry.capabilities.find((item) => item.name === 'clean_single_room')
  .verifiedRooms.map((item) => item.room);
const previouslyVerifiedRoomSlugs = ['guest_bathroom', 'hallway', 'living_room'];
const historicalSingleRoomRegistry = () => {
  const copy = structuredClone(currentRegistry);
  for (const capability of copy.capabilities) delete capability.verifiedRoomSets;
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
const historicalHallwayPauseRegistry = () => {
  const copy = historicalSingleRoomRegistry();
  copy.capabilities.find((item) => item.name === 'pause').verifiedRooms = copy.capabilities
    .find((item) => item.name === 'pause').verifiedRooms.filter((item) => item.room === 'guest_bathroom');
  return copy;
};
const productionRegistry = structuredClone(currentRegistry);
delete productionRegistry.underTest;
const registry = structuredClone(productionRegistry);
for (const capability of registry.capabilities) delete capability.verifiedRoomSets;
for (const name of ['pause', 'dock']) {
  const reported = registry.capabilities.find((item) => item.name === name);
  reported.support = 'reported';
  reported.observedAt = null;
  reported.provenance = 'Deterministic test fixture';
  delete reported.verifiedRooms;
  delete reported.verifiedRoomSets;
}
const pausePromotedRegistry = structuredClone(registry);
Object.assign(pausePromotedRegistry.capabilities.find((item) => item.name === 'pause'),
  productionRegistry.capabilities.find((item) => item.name === 'pause'));
delete pausePromotedRegistry.capabilities.find((item) => item.name === 'pause').verifiedRoomSets;
const controlsPromotedRegistry = structuredClone(productionRegistry);
for (const capability of controlsPromotedRegistry.capabilities) delete capability.verifiedRoomSets;
const promotedRegistry = structuredClone(registry);
delete registry.capabilities.find((item) => item.name === 'clean_settings').verifiedSettings;
const policy = json('agents/jessica-vacuum/config/policy.v1.json');
const mapFixture = json('agents/jessica-vacuum/tests/fixtures/map-stage2-live.json');
const clock = () => new Date(Date.parse(mapFixture.observedAt) + 1_000);
const roster = { accountId: 'benson', approvedIds: ['oren'], byRoute: new Map([['direct-oren', 'oren']]) };
const testPolicy = { version: '1', defaultDecision: 'deny', rules: [
  { subject: 'oren', actionClass: 'read', deviceScope: 'jessica-vacuum', decision: 'allow' },
  { subject: 'oren', actionClass: 'control', deviceScope: 'jessica-vacuum', decision: 'allow' },
] };
const state = {
  entity_id: 'vacuum.jesica_jesica', state: 'docked', last_updated: mapFixture.observedAt,
  attributes: {
    battery: 100, active_segments: null, current_segment: 8,
    selected_map_id: mapFixture.mapId, selected_map: mapFixture.mapName,
    rooms: { [mapFixture.mapName]: mapFixture.rooms },
    shortcuts: Object.fromEntries(mapFixture.shortcuts.map((item) => [String(item.id), {
      id: item.id, map_id: item.mapId, tasks: item.tasks,
    }])),
  },
};
const sensors = new Map([
  ['sensor.jesica_charging_status', { state: 'charging_completed', last_updated: mapFixture.observedAt }],
  ['sensor.jesica_error', { state: 'no_error', last_updated: mapFixture.observedAt }],
  ['sensor.jesica_low_water_warning', { state: 'no_warning', last_updated: mapFixture.observedAt }],
  ['sensor.jesica_task_status', { state: 'completed', last_updated: mapFixture.observedAt }],
  ['sensor.jesica_filter_left', { state: '16', last_updated: mapFixture.observedAt }],
  ['sensor.jesica_filter_time_left', { state: '24', last_updated: mapFixture.observedAt }],
  ['sensor.jesica_total_cleaning_time', { state: '7422', last_updated: mapFixture.observedAt }],
]);
const directContext = { agentId: 'jessica-vacuum', deliveryContext: { channel: 'whatsapp', accountId: 'benson', to: 'direct-oren' } };
const createFactory = (overrides = {}) => createJessicaReadToolFactory({
  jsonResult: (value) => value, registryConfig: registry, policyConfig: testPolicy, roster,
  clock, readState: async () => ({ state, observedAt: mapFixture.observedAt }),
  readSensors: async () => sensors, ...overrides,
});

test('native route identity is separate from tool arguments and fails closed', () => {
  assert.equal(resolveTrustedIdentity(directContext, roster).senderId, 'oren');
  assert.throws(() => resolveTrustedIdentity({ ...directContext, requesterSenderId: 'other' }, roster),
    (error) => error.code === 'IDENTITY_UNTRUSTED');
  assert.throws(() => resolveTrustedIdentity({ ...directContext, deliveryContext: { ...directContext.deliveryContext, to: 'unknown' } }, roster),
    (error) => error.code === 'IDENTITY_UNTRUSTED');
  const group = { ...directContext, deliveryContext: { ...directContext.deliveryContext, to: 'group@g.us' } };
  assert.throws(() => resolveTrustedIdentity(group, roster), (error) => error.code === 'IDENTITY_UNTRUSTED');
  assert.equal(resolveTrustedIdentity({ ...group, requesterSenderId: 'direct-oren' }, roster).channelKind, 'group');
});

test('canonical family roster grants identical control and requires trusted group senders', () => {
  const liveRoster = loadTrustedRoutes();
  assert.equal(liveRoster.approvedIds.length, 5);
  assert.doesNotThrow(() => assertRosterPolicyAgreement(liveRoster, policy));
  assert.throws(() => assertRosterPolicyAgreement(roster, policy));
  const missingControl = structuredClone(policy);
  missingControl.rules = missingControl.rules.filter((rule) => !(rule.subject === 'ilana' && rule.actionClass === 'control'));
  assert.throws(() => assertRosterPolicyAgreement(liveRoster, loadPolicy(missingControl)));
  const loaded = loadPolicy(policy);
  for (const [route, subject] of liveRoster.byRoute) {
    const direct = resolveTrustedIdentity({ ...directContext,
      deliveryContext: { channel: 'whatsapp', accountId: liveRoster.accountId, to: route } }, liveRoster);
    const group = resolveTrustedIdentity({ ...directContext,
      deliveryContext: { channel: 'whatsapp', accountId: liveRoster.accountId, to: 'family@g.us' },
      requesterSenderId: route }, liveRoster);
    assert.equal(authorize(loaded, direct, 'control').subject, subject);
    assert.equal(authorize(loaded, group, 'control').subject, subject);
  }
  assert.throws(() => resolveTrustedIdentity({ ...directContext,
    deliveryContext: { channel: 'whatsapp', accountId: liveRoster.accountId, to: 'family@g.us' } }, liveRoster),
  (error) => error.code === 'IDENTITY_UNTRUSTED');
});

test('HA projection uses only selected map and typed status fields', () => {
  assert.equal(fingerprintMap(projectMap(state, mapFixture.observedAt)), registry.mapFingerprint);
  assert.equal(projectStatus(state, mapFixture.observedAt).batteryLevel, 100);
  assert.equal(projectStatus(state, mapFixture.observedAt).currentSegment, 8);
});

test('sensor projection keeps old HA timestamps, missing values and future evidence fail closed', () => {
  const observedAt = new Date(Date.parse(mapFixture.observedAt) + 60_000).toISOString();
  const items = projectSensorCollection(sensors, 'maintenance', observedAt);
  assert.equal(items.find((item) => item.name === 'filterPercent').sourceKind, 'ha_cached_entity');
  assert.equal(items.find((item) => item.name === 'dustBag').value, null);
  assert.equal(items.find((item) => item.name === 'dustBag').availability, 'unavailable');
  const future = new Map(sensors);
  future.set('sensor.jesica_filter_left', { state: '16', last_updated: new Date(Date.parse(observedAt) + 1).toISOString() });
  assert.throws(() => projectSensorCollection(future, 'maintenance', observedAt), (error) => error.code === 'READ_INVALID');
  const invalid = new Map(sensors);
  invalid.set('sensor.jesica_filter_left', { state: '101', last_updated: mapFixture.observedAt });
  assert.throws(() => projectSensorCollection(invalid, 'maintenance', observedAt), (error) => error.code === 'READ_INVALID');
});

test('FC0 production checker rejects write records and non-read child tasks', () => {
  const before = { operations: 2, latestTaskCreatedAt: 100 };
  const row = (n) => ({ task_id: `task-${n}`, run_id: `run-${n}`, status: 'succeeded', delivery_status: 'delivered',
    tool_use_count: 1, last_tool_name: 'jessica_read', created_at: 100 + n });
  const after = { operations: 2, active: null, tasks: [row(1), row(2), row(3)] };
  const completed = new Map(['status', 'capabilities', 'maintenance'].map((operation, index) =>
    [`run-${index + 1}`, { validated: true, visibleReply: true, operation }]));
  assert.deepEqual(checkAfter(before, after, completed), ['task-1', 'task-2', 'task-3']);
  assert.throws(() => checkAfter(before, { ...after, operations: 3 }, completed));
  assert.throws(() => checkAfter(before, { ...after, tasks: [row(1), { ...row(2), last_tool_name: 'jessica_execute' }, row(3)] }, completed));
  const missingValidation = new Map(completed);
  missingValidation.set('run-1', { validated: false, visibleReply: false });
  assert.throws(() => checkAfter(before, after, missingValidation), /parent completion validation/);
  const missingReply = new Map(completed);
  missingReply.set('run-1', { validated: true, visibleReply: false, operation: 'status' });
  assert.throws(() => checkAfter(before, after, missingReply), /visible parent reply/);
  const wrongOperation = new Map(completed);
  wrongOperation.set('run-3', { validated: true, visibleReply: true, operation: 'status' });
  assert.throws(() => checkAfter(before, after, wrongOperation), /operations differ/);
});

test('tool is exposed only to Jessica and returns validated read envelopes', async () => {
  const factory = createFactory();
  assert.equal(factory({ ...directContext, agentId: 'main' }), null);
  assert.equal(factory({ ...directContext, agentId: 'reminder-service' }), null);
  const tool = factory(directContext);
  assert.equal(tool.name, 'jessica_read');
  assert.deepEqual(tool.parameters.properties.operation.enum,
    ['status', 'rooms', 'capabilities', 'maintenance', 'statistics']);
  assert.equal(tool.parameters.additionalProperties, false);
  const status = await tool.execute('test-call', { operation: 'status' });
  assert.equal(status.status, 'success');
  assert.equal(status.data.state, 'docked');
  assert.equal(status.data.batteryLevel, 100);
  assert.equal(status.data.sourceKind, 'ha_cached_entity');
  assert.equal(status.data.locationMeaning, 'map_localization');
  assert.equal(status.data.health.find((item) => item.name === 'taskStatus').value, 'completed');
  const rooms = await tool.execute('test-call', { operation: 'rooms' });
  assert.equal(rooms.status, 'success');
  assert.equal(rooms.data.mapFingerprint, registry.mapFingerprint);
  assert.equal(rooms.data.rooms.length, 13);
  assert.equal(rooms.data.rooms.find((room) => room.segmentId === 13).enabled, true);
  const capabilities = await tool.execute('test-call', { operation: 'capabilities' });
  assert.equal(capabilities.status, 'success');
  assert.equal(capabilities.data.capabilities.every((item) => item.support !== 'verified'), true);
  assert.deepEqual(capabilities.data.capabilities.find((item) => item.name === 'clean_single_room')
    .verifiedRooms.map((item) => item.room), allRoomSlugs);
  assert.equal(capabilities.data.inventoryScope, 'accepted_registry_only');
  const maintenance = await tool.execute('test-call', { operation: 'maintenance' });
  assert.equal(maintenance.status, 'success');
  assert.equal(maintenance.data.items.find((item) => item.name === 'filterPercent').value, 16);
  assert.equal(maintenance.data.items.find((item) => item.name === 'dustBag').availability, 'unavailable');
  const statistics = await tool.execute('test-call', { operation: 'statistics' });
  assert.equal(statistics.status, 'success');
  assert.equal(statistics.data.metrics.find((item) => item.name === 'totalCleaningMinutes').value, 7422);
});

test('operation-status reads only the exact native reference and never claims physical completion', async () => {
  const readRegistry = structuredClone(registry);
  readRegistry.capabilities.find((cap) => cap.name === 'read_operation_status').support = 'reported';
  const id = 'j4-known-operation';
  const result = { schemaVersion: '1', domain: 'jessica-vacuum', operation: 'clean',
    status: 'success', verified: true, data: { operationId: id, outcome: 'started',
      dispatch: 'accepted', observation: { observedAt: mapFixture.observedAt,
        sourceUpdatedAt: mapFixture.observedAt, state: 'cleaning', activeSegments: [10], currentSegment: 10 } } };
  const entries = new Map([[`operation:${id}`, { version: '1', operationId: id, result }]]);
  const store = { lookup: (key) => entries.get(key), update() {}, registerIfAbsent() {} };
  const tool = createFactory({ createStore: () => store, registryConfig: readRegistry })(directContext);
  assert.deepEqual(tool.parameters.oneOf.at(-1).required, ['operation', 'operationId']);
  const found = await tool.execute('read-op', { operation: 'operation_status', operationId: id });
  assert.equal(found.status, 'success');
  assert.equal(found.data.outcome, 'started');
  assert.equal(found.data.dispatch, 'accepted');
  assert.equal(found.data.observation.state, 'cleaning');
  assert.equal((await tool.execute('read-op', { operation: 'operation_status', operationId: 'other' })).error.code,
    'OPERATION_NOT_FOUND');
  entries.set(`operation:${id}`, { version: '1', operationId: id, result: { ...result,
    data: { ...result.data, operationId: 'mismatch' } } });
  assert.equal((await tool.execute('read-op', { operation: 'operation_status', operationId: id })).error.code,
    'READ_UNAVAILABLE');
});

test('operation index storage failure leaves a terminal claim for read-only recovery', () => {
  const entries = new Map();
  let full = true;
  const store = { lookup: (key) => entries.get(key),
    registerIfAbsent: (key, value) => {
      if (key.startsWith('operation:') && full) return false;
      if (entries.has(key)) return false;
      entries.set(key, value);
      return true;
    },
    update: (key, change) => { const next = change(entries.get(key)); if (next !== undefined) entries.set(key, next); },
  };
  const stateStore = createOperationState(store);
  const intent = { requestKey: 'one', requestHash: 'request', planHash: 'plan',
    operationId: 'j4-test', phase: 'prepared', stepIndex: 0,
    requestEpoch: 'native-test-run', requesterId: 'oren' };
  assert.equal(stateStore.reserve(intent).kind, 'reserved');
  const result = { schemaVersion: '1', domain: 'jessica-vacuum',
    data: { operationId: intent.operationId, outcome: 'started' } };
  assert.throws(() => stateStore.finish(stateStore.active(), result), /index conflicts/);
  assert.equal(stateStore.active().phase, 'terminal');
  assert.equal(stateStore.history('one'), undefined);
  assert.equal(stateStore.operation('j4-test').kind, 'terminal');
  full = false;
  assert.equal(stateStore.finish(stateStore.active(), result), result);
  assert.equal(stateStore.active(), null);
  assert.equal(stateStore.operation('j4-test').value, result);
});

test('spoofing, unknown routes, groups without sender and disabled operations make no HA call', async () => {
  let reads = 0;
  const factory = createFactory({ readState: async () => { reads++; return { state, observedAt: mapFixture.observedAt }; } });
  const tool = factory(directContext);
  assert.equal((await tool.execute('test-call', { operation: 'status', requesterId: 'oren' })).error.code, 'INVALID_REQUEST');
  assert.equal((await tool.execute('test-call', { operation: 'room_settings', room: 'guest_bathroom' })).error.code, 'CAPABILITY_UNSUPPORTED');
  const unknown = factory({ ...directContext, deliveryContext: { ...directContext.deliveryContext, to: 'unknown' } });
  assert.equal((await unknown.execute('test-call', { operation: 'status' })).error.code, 'IDENTITY_UNTRUSTED');
  const group = factory({ ...directContext, deliveryContext: { ...directContext.deliveryContext, to: 'group@g.us' } });
  assert.equal((await group.execute('test-call', { operation: 'status' })).error.code, 'IDENTITY_UNTRUSTED');
  assert.equal(reads, 0);
});

test('native execute adapter applies policy and an exact verified room target', async () => {
  const entries = new Map();
  const store = {
    lookup: (key) => entries.get(key),
    registerIfAbsent: (key, value) => entries.has(key) ? false : (entries.set(key, value), true),
    update: (key, change) => {
      const next = change(entries.get(key));
      if (next !== undefined) entries.set(key, next);
    },
  };
  let posts = 0;
  let updatedAt = Date.now() - 2_000;
  let taskUpdatedAt = updatedAt;
  let deviceState = 'docked';
  let segments = null;
  let taskState = 'completed';
  const liveDriver = () => ({
    read: async () => { const observedAt = new Date().toISOString(); return {
      map: { ...mapFixture, observedAt },
      status: { observedAt, sourceUpdatedAt: new Date(updatedAt).toISOString(),
        state: deviceState, activeSegments: segments, currentSegment: null },
      taskStatus: { state: taskState, sourceUpdatedAt: new Date(taskUpdatedAt).toISOString() },
      taskId: null, taskScope: null, options: null, settings: {}, error: null,
    }; },
    dispatch: async (step) => {
      posts++;
      assert.deepEqual(step.segments, [10]);
      updatedAt = Date.now(); taskUpdatedAt = updatedAt;
      deviceState = 'cleaning'; segments = [10]; taskState = 'room_cleaning';
      return { accepted: true };
    },
  });
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => store, registryConfig: registry, policyConfig: testPolicy, roster,
    driverFactory: liveDriver });
  assert.equal(factory({ ...directContext, agentId: 'main' }), null);
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:canary-1' });
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] } };
  assert.deepEqual(tool.parameters.oneOf.find((variant) => variant.properties.operation?.const === 'clean')
    .properties.target.properties.rooms.items.enum, allRoomSlugs);
  assert.equal((await tool.execute('call', request)).status, 'success');
  assert.equal(posts, 1);
  const group = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:group',
    deliveryContext: { ...directContext.deliveryContext, to: 'group@g.us' } });
  assert.equal((await group.execute('call', request)).error.code, 'IDENTITY_UNTRUSTED');
  assert.equal(posts, 1);
  assert.equal((await tool.execute('call', request)).status, 'success');
  assert.equal(posts, 1);
  const wrongRoom = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:canary-2' });
  assert.equal((await wrongRoom.execute('call', { operation: 'clean', target: { kind: 'rooms', rooms: ['west_balcony'] } })).error.code,
    'RESOURCE_BUSY');
  assert.equal(posts, 1);
  const noSession = factory(directContext);
  assert.equal((await noSession.execute('call', request)).error.code, 'EPOCH_UNTRUSTED');
  assert.equal(posts, 1);
});

test('execute tool exposes only the exact temporary suction setting when scoped', () => {
  const scoped = structuredClone(registry);
  scoped.underTest = { id: 'stage7-suction-tool-test', capability: 'clean_settings',
    room: 'guest_bathroom', settings: { suction: 'strong' },
    expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 2 };
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: scoped, policyConfig: testPolicy, roster });
  assert.equal(factory({ ...directContext, agentId: 'main' }), null);
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:scoped-suction' });
  const cleanVariant = tool.parameters.oneOf.find((variant) => variant.properties.operation?.const === 'clean');
  assert.deepEqual(cleanVariant.properties.settings.properties, { suction: { const: 'strong' } });
  assert.deepEqual(cleanVariant.properties.target.properties.rooms.items,
    { enum: allRoomSlugs });
  const unscoped = structuredClone(registry);
  delete unscoped.underTest;
  const verifiedOnly = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: unscoped, policyConfig: testPolicy, roster });
  assert.equal(verifiedOnly(directContext).parameters.oneOf.find((variant) =>
    variant.properties.operation?.const === 'clean').properties.settings, undefined);
});

test('execute tool exposes promoted rooms while strong setting remains domain-scoped to guest bathroom', () => {
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: promotedRegistry, policyConfig: testPolicy, roster });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:verified-suction' });
  const cleanVariant = tool.parameters.oneOf.find((variant) => variant.properties.operation?.const === 'clean');
  assert.deepEqual(cleanVariant.properties.settings.properties, { suction: { const: 'strong' } });
  assert.deepEqual(cleanVariant.properties.target.properties.rooms.items,
    { enum: allRoomSlugs });
});

test('promoted FC2 family scope covers all reviewed rooms without widening settings or dock', () => {
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: productionRegistry, policyConfig: testPolicy, roster });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:fc2-hallway' });
  const cleanVariants = tool.parameters.oneOf.filter((variant) => variant.properties.operation?.const === 'clean');
  assert.equal(cleanVariants.length, 1);
  assert.deepEqual(cleanVariants[0].properties.target.properties.rooms.items.enum,
    allRoomSlugs);
  assert.deepEqual(cleanVariants[0].properties.settings.properties, { suction: { const: 'strong' } });
  assert.deepEqual(tool.parameters.oneOf.map((variant) => variant.properties.operation.const),
    ['clean', 'pause', 'dock']);
  assert.doesNotMatch(tool.description, /canary/u);
  assert.deepEqual(tool.parameters.oneOf.filter((variant) => ['pause', 'dock'].includes(
    variant.properties.operation?.const)).map((variant) => variant.properties.operation.const), ['pause', 'dock']);
  assert.deepEqual(currentRegistry.capabilities.find((item) => item.name === 'pause').verifiedRooms
    .map((item) => item.room), allRoomSlugs);
  assert.deepEqual(currentRegistry.capabilities.find((item) => item.name === 'dock').verifiedRooms
    .map((item) => item.room), ['guest_bathroom']);
});

test('FC2 Tal-room canary remains a bounded historical adapter fixture', () => {
  let captured;
  const talRegistry = historicalSingleRoomRegistry();
  talRegistry.underTest = { id: 'fc2-tal-fixture', capability: 'clean_single_room', room: 'tal_room',
    subject: 'oren', expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: talRegistry, policyConfig: testPolicy, roster,
    driverFactory: (options) => { captured = options; return {}; }, clock });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:tal' });
  const clean = tool.parameters.oneOf.filter((variant) => variant.properties.operation?.const === 'clean');
  assert.equal(clean.length, 1);
  assert.deepEqual(clean[0].properties.target.properties.rooms.items.enum,
    ['guest_bathroom', 'hallway', 'living_room', 'tal_room']);
  assert.equal(clean[0].properties.target.properties.rooms.maxItems, 1);
  assert.match(tool.description, /חדר טל.*Oren-only canary/u);
  return tool.execute('tal', { operation: 'clean', target: { kind: 'rooms',
    rooms: ['tal_room'] } }).then(() => assert.deepEqual(captured.expectedSegments, [14]));
});

test('FC2 dining-area canary remains a bounded historical adapter fixture', () => {
  let captured;
  const diningRegistry = historicalSingleRoomRegistry();
  diningRegistry.underTest = { id: 'fc2-dining-fixture', capability: 'clean_single_room', room: 'dining_area',
    subject: 'oren', expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: diningRegistry, policyConfig: testPolicy, roster,
    driverFactory: (options) => { captured = options; return {}; }, clock });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:dining' });
  const clean = tool.parameters.oneOf.filter((variant) => variant.properties.operation?.const === 'clean');
  assert.equal(clean.length, 1);
  assert.deepEqual(clean[0].properties.target.properties.rooms.items.enum,
    ['guest_bathroom', 'hallway', 'living_room', 'dining_area']);
  assert.equal(clean[0].properties.target.properties.rooms.maxItems, 1);
  assert.match(tool.description, /פינת אוכל.*Oren-only canary/u);
  return tool.execute('dining', { operation: 'clean', target: { kind: 'rooms',
    rooms: ['dining_area'] } }).then(() => assert.deepEqual(captured.expectedSegments, [11]));
});

test('FC2 home-center canary remains a bounded historical adapter fixture', () => {
  let captured;
  const homeRegistry = historicalSingleRoomRegistry();
  homeRegistry.underTest = { id: 'fc2-home-center-fixture', capability: 'clean_single_room', room: 'home_center',
    subject: 'oren', expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: homeRegistry, policyConfig: testPolicy, roster,
    driverFactory: (options) => { captured = options; return {}; }, clock });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:home-center' });
  const clean = tool.parameters.oneOf.filter((variant) => variant.properties.operation?.const === 'clean');
  assert.equal(clean.length, 1);
  assert.deepEqual(clean[0].properties.target.properties.rooms.items.enum,
    ['guest_bathroom', 'hallway', 'living_room', 'home_center']);
  assert.equal(clean[0].properties.target.properties.rooms.maxItems, 1);
  assert.match(tool.description, /מרכז הבית.*Oren-only canary/u);
  return tool.execute('home-center', { operation: 'clean', target: { kind: 'rooms',
    rooms: ['home_center'] } }).then(() => assert.deepEqual(captured.expectedSegments, [13]));
});

test('FC2 kitchen canary remains a bounded historical adapter fixture', () => {
  let captured;
  const kitchenRegistry = historicalSingleRoomRegistry();
  kitchenRegistry.underTest = { id: 'fc2-kitchen-fixture', capability: 'clean_single_room', room: 'kitchen',
    subject: 'oren', expiresAt: '2026-09-28T20:00:00+03:00', maxDispatches: 1 };
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: kitchenRegistry, policyConfig: testPolicy, roster,
    driverFactory: (options) => { captured = options; return {}; }, clock });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:kitchen' });
  const clean = tool.parameters.oneOf.filter((variant) => variant.properties.operation?.const === 'clean');
  assert.equal(clean.length, 1);
  assert.deepEqual(clean[0].properties.target.properties.rooms.items.enum,
    ['guest_bathroom', 'hallway', 'living_room', 'kitchen']);
  assert.equal(clean[0].properties.target.properties.rooms.maxItems, 1);
  assert.match(tool.description, /מטבח.*Oren-only canary/u);
  return tool.execute('kitchen', { operation: 'clean', target: { kind: 'rooms',
    rooms: ['kitchen'] } }).then(() => assert.deepEqual(captured.expectedSegments, [12]));
});

test('FC2 kitchen-sitting canary fixture exposes only segment 16', () => {
  let captured;
  const sittingRegistry = historicalSingleRoomRegistry();
  sittingRegistry.underTest = { id: 'fc2-kitchen-sitting-fixture', capability: 'clean_single_room',
    room: 'kitchen_sitting_area', subject: 'oren',
    expiresAt: '2026-09-29T20:00:00+03:00', maxDispatches: 1 };
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: sittingRegistry, policyConfig: testPolicy, roster,
    driverFactory: (options) => { captured = options; return {}; }, clock });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:kitchen-sitting' });
  const clean = tool.parameters.oneOf.filter((variant) => variant.properties.operation?.const === 'clean');
  assert.equal(clean.length, 1);
  assert.deepEqual(clean[0].properties.target.properties.rooms.items.enum,
    ['guest_bathroom', 'hallway', 'living_room', 'kitchen_sitting_area']);
  assert.equal(clean[0].properties.target.properties.rooms.maxItems, 1);
  assert.match(tool.description, /מטבח ישיבה.*Oren-only canary/u);
  return tool.execute('kitchen-sitting', { operation: 'clean', target: { kind: 'rooms',
    rooms: ['kitchen_sitting_area'] } }).then(() => assert.deepEqual(captured.expectedSegments, [16]));
});

test('FC2 live tool exposes only one verified multi-room pair with no active canary', () => {
  assert.equal(currentRegistry.underTest ?? null, null);
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: currentRegistry, policyConfig: testPolicy, roster,
    driverFactory: () => ({}), clock });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:production' });
  const clean = tool.parameters.oneOf.filter((variant) => variant.properties.operation?.const === 'clean');
  assert.equal(clean.length, 1);
  assert.deepEqual(clean[0].properties.target.properties.rooms.items.enum,
    allRoomSlugs);
  assert.equal(clean[0].properties.target.properties.rooms.maxItems, 2);
  assert.match(tool.description, /living_room \+ hallway/u);
});

test('one-shot multi-room canary keeps one clean schema branch and derives the exact segment pair', () => {
  const scoped = structuredClone(currentRegistry);
  for (const capability of scoped.capabilities) delete capability.verifiedRoomSets;
  scoped.capabilities.find((item) => item.name === 'clean_multi_room').support = 'reported';
  scoped.underTest = { id: 'fc2-multi-fixture', capability: 'clean_multi_room',
    rooms: ['living_room', 'hallway'], subject: 'oren',
    expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  let captured;
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: scoped, policyConfig: testPolicy, roster,
    driverFactory: (options) => { captured = options; return {}; }, clock });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:multi' });
  const clean = tool.parameters.oneOf.filter((variant) => variant.properties.operation?.const === 'clean');
  assert.equal(clean.length, 1);
  assert.equal(clean[0].properties.target.properties.rooms.maxItems, 2);
  assert.match(tool.description, /Oren-only.*multi-room/u);
  return tool.execute('multi', { operation: 'clean', target: { kind: 'rooms',
    rooms: ['living_room', 'hallway'] } }).then(() => {
    assert.deepEqual(captured.expectedSegments, [8, 7]);
  });
});

test('one-shot home schema is separate, no-settings and passes only home driver authority', async () => {
  const scoped = structuredClone(currentRegistry);
  scoped.underTest = { id: 'fc2-home-adapter-fixture', capability: 'clean_home', subject: 'oren',
    reviewedGeometrySha256: 'de38293681d645b1b6ef43435140650b0857745e22beab905b2dbd4f2e69aa7c',
    expiresAt: '2026-09-30T20:00:00+03:00', maxDispatches: 1 };
  let captured;
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: scoped, policyConfig: testPolicy, roster,
    driverFactory: (options) => { captured = options; return {}; }, clock });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:home' });
  const variants = tool.parameters.oneOf.filter((variant) =>
    variant.properties.operation?.const === 'clean');
  assert.equal(variants.length, 2);
  const home = variants.find((variant) => variant.properties.target.properties.kind?.const === 'home');
  assert.deepEqual(home.required, ['operation', 'target']);
  assert.equal(home.properties.settings, undefined);
  assert.equal(home.properties.target.additionalProperties, false);
  assert.match(tool.description, /Oren-only.*whole-home/u);
  await tool.execute('home', { operation: 'clean', target: { kind: 'home' } });
  assert.deepEqual(captured.expectedSegments, []);
  assert.equal(captured.homeCanary, true);
  assert.equal(captured.canarySuction, null);
  assert.equal(captured.controlOperation, null);
  const unscoped = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: productionRegistry, policyConfig: testPolicy, roster });
  assert.equal(unscoped(directContext).parameters.oneOf.some((variant) =>
    variant.properties.target?.properties.kind?.const === 'home'), false);
});

test('one-shot control scope exposes only its one Oren control variant', () => {
  const scoped = structuredClone(registry);
  scoped.underTest = { id: 'fc1-pause-test', capability: 'pause', room: 'guest_bathroom',
    subject: 'oren', expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: scoped, policyConfig: testPolicy, roster });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:pause-canary' });
  assert.equal(tool.parameters.oneOf.length, 2);
  assert.deepEqual(tool.parameters.oneOf[1].properties, { operation: { const: 'pause' } });
  assert.equal(tool.parameters.oneOf[1].additionalProperties, false);
});

test('FC2 hallway pause canary preserves guest control and allows only reviewed control segments', async () => {
  const scoped = historicalHallwayPauseRegistry();
  scoped.underTest = { id: 'fc2-pause-hallway-fixture', capability: 'pause', room: 'hallway',
    subject: 'oren', expiresAt: '2026-09-29T20:00:00+03:00', maxDispatches: 1 };
  let captured;
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: scoped, policyConfig: testPolicy, roster,
    driverFactory: (options) => { captured = options; return {}; }, clock });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:hallway-pause' });
  assert.equal(tool.parameters.oneOf.filter((variant) => variant.properties.operation?.const === 'pause').length, 1);
  await tool.execute('hallway-pause', { operation: 'pause' });
  assert.deepEqual(captured.expectedSegments, [10, 7]);
  assert.equal(captured.controlOperation, 'pause');
});

test('promoted current-task pause is exposed without the consumed canary scope', () => {
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: pausePromotedRegistry, policyConfig: testPolicy, roster });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:pause-promoted' });
  assert.deepEqual(tool.parameters.oneOf.filter((variant) => variant.properties.operation?.const === 'pause')
    .map((variant) => variant.properties), [{ operation: { const: 'pause' } }]);
  assert(!tool.parameters.oneOf.some((variant) => variant.properties.operation?.const === 'dock'));
  assert.match(tool.description, /Verified current-task pause control/u);
});

test('dock canary is added beside verified pause only for the reviewed room', () => {
  const scoped = structuredClone(pausePromotedRegistry);
  scoped.underTest = { id: 'fc1-dock-test', capability: 'dock', room: 'guest_bathroom',
    subject: 'oren', expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 1 };
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: scoped, policyConfig: testPolicy, roster });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:dock-canary' });
  assert.deepEqual(tool.parameters.oneOf.filter((variant) => ['pause', 'dock'].includes(
    variant.properties.operation?.const)).map((variant) => variant.properties.operation.const),
    ['pause', 'dock']);
  assert.match(tool.description, /One reviewed dock canary/u);
});

test('promoted current-task pause and dock are exposed without a canary scope', () => {
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: controlsPromotedRegistry, policyConfig: testPolicy, roster });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:controls-promoted' });
  assert.deepEqual(tool.parameters.oneOf.filter((variant) => ['pause', 'dock'].includes(
    variant.properties.operation?.const)).map((variant) => variant.properties.operation.const),
    ['pause', 'dock']);
  assert.match(tool.description, /Verified current-task pause and dock control/u);
  assert.doesNotMatch(tool.description, /canary/u);
});

test('FC2 multi-room pause historical fixture derives exact driver pair without duplicate control rooms', async () => {
  const scoped = structuredClone(currentRegistry);
  for (const capability of scoped.capabilities) delete capability.verifiedRoomSets;
  scoped.underTest = { id: 'fc2-pause-multi-fixture', capability: 'pause',
    rooms: ['living_room', 'hallway'], subject: 'oren',
    expiresAt: '2026-09-30T20:00:00+03:00', maxDispatches: 1 };
  let captured;
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: scoped, policyConfig: testPolicy, roster,
    driverFactory: (options) => { captured = options; return {}; }, clock });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:multi-pause' });
  const clean = tool.parameters.oneOf.find((variant) => variant.properties.operation?.const === 'clean');
  assert.equal(clean.properties.target.properties.rooms.maxItems, 1);
  await tool.execute('multi-pause', { operation: 'pause' });
  assert.equal(captured.controlOperation, 'pause');
  assert.deepEqual(captured.controlCanarySegments, [8, 7]);
  assert.equal(new Set(captured.expectedSegments).size, captured.expectedSegments.length);
  assert.equal(captured.expectedSegments.length, 13);
});

test('production exact-pair adapter derives only accepted clean and pause segments', async () => {
  const options = [];
  const factory = createJessicaExecuteToolFactory({ jsonResult: (value) => value,
    createStore: () => ({}), registryConfig: currentRegistry, policyConfig: testPolicy, roster,
    driverFactory: (value) => { options.push(value); return {}; }, clock });
  const tool = factory({ ...directContext, sessionKey: 'agent:jessica-vacuum:subagent:production-pair' });
  await tool.execute('pair-clean', { operation: 'clean', target: { kind: 'rooms',
    rooms: ['hallway', 'living_room'] } });
  assert.deepEqual(options.at(-1).expectedSegments, [7, 8]);
  await tool.execute('pair-pause', { operation: 'pause' });
  assert.equal(options.at(-1).controlOperation, 'pause');
  assert.deepEqual(options.at(-1).controlVerifiedSets, [[8, 7]]);
  assert.equal(options.at(-1).controlCanarySegments, null);
  await tool.execute('wrong-pair', { operation: 'clean', target: { kind: 'rooms',
    rooms: ['living_room', 'guest_bathroom'] } });
  assert.deepEqual(options.at(-1).expectedSegments, []);
});
test('live capabilities read validates verifiedRoomSets alongside verifiedRooms', async () => {
  const factory = createFactory({ registryConfig: currentRegistry });
  const tool = factory(directContext);
  const result = await tool.execute('live-capabilities', { operation: 'capabilities' });
  assert.equal(result.status, 'success', result.error?.code);
  assert.deepEqual(result.data.capabilities.find((cap) => cap.name === 'clean_multi_room')
    .verifiedRoomSets[0].rooms, ['living_room', 'hallway']);
  assert.deepEqual(result.data.capabilities.find((cap) => cap.name === 'pause')
    .verifiedRoomSets[0].rooms, ['living_room', 'hallway']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPluginStateSyncKeyedStore } from '/home/oa/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/plugin-state-store-runtime.js';
import { createJessicaExecutor } from '../dist/executor.js';
import { createOperationState, JESSICA_STATE_OPTIONS } from '../dist/operation-state.js';
import { createSocketDriver, startFakeHa } from './fake-ha.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..', '..');
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const mapFixture = json('agents/jessica-vacuum/tests/fixtures/map-stage2-live.json');
const policy = json('agents/jessica-vacuum/config/policy.v1.json');
const clean = { operation: 'clean', target: { kind: 'rooms', rooms: ['salon'] } };
const identity = { source: 'trusted_runtime', senderId: 'oren', channelKind: 'direct', perSenderVerified: true };
const context = (requestEpoch) => ({ identity, requestEpoch });

// Synthetic release exercises reuse mechanics, not Jessica physical proof.
function releaseFixtureResource(f) {
  const state = createOperationState(f.store, { verifyRelease: (owner, evidence) =>
    evidence?.kind === 'fixture-physical-terminal' && evidence.operationId === owner.operationId &&
    evidence.generation === owner.generation });
  const owner = state.resource().owner;
  assert.equal(state.releaseResource(owner, { kind: 'fixture-physical-terminal',
    operationId: owner.operationId, generation: owner.generation }), true);
  Object.assign(f.server.state.status, { state: 'docked', activeSegments: [], currentSegment: null });
  f.server.state.taskStatus.state = 'completed';
}

async function fixture(t, behavior = {}, capabilities = ['clean_single_room'], map = mapFixture, underTest = false,
  wrapDriver = (driver) => driver) {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const dir = mkdtempSync(join(tmpdir(), 'benson-jessica-stage4-'));
  const stateRoot = join(dir, 'state-root');
  const socketPath = join(dir, 'ha.sock');
  const server = await startFakeHa(socketPath, map, { liveTaskSignals: true, ...behavior });
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const registry = json('agents/jessica-vacuum/config/registry.v1.json');
  delete registry.underTest;
  if (underTest !== 'production-multi') {
    for (const capability of registry.capabilities) delete capability.verifiedRoomSets;
  }
  if (underTest !== 'verified-suction') {
    delete registry.capabilities.find((item) => item.name === 'clean_settings').verifiedSettings;
  }
  if (underTest === 'suction') {
    registry.underTest = { id: 'stage7-suction-test', capability: 'clean_settings', room: 'guest_bathroom',
      settings: { suction: 'strong' }, expiresAt, maxDispatches: 2 };
  } else if (underTest === true) {
    delete registry.capabilities.find((cap) => cap.name === 'clean_single_room').verifiedRooms;
    for (const name of ['pause', 'dock']) {
      const control = registry.capabilities.find((cap) => cap.name === name);
      control.support = 'reported';
      delete control.verifiedRooms;
    }
    registry.underTest = { id: 'stage6-test-canary', capability: 'clean_single_room', room: 'guest_bathroom', subject: 'oren',
      expiresAt, maxDispatches: 1 };
  } else if (underTest === 'multi') {
    registry.capabilities.find((cap) => cap.name === 'clean_multi_room').support = 'reported';
    registry.underTest = { id: 'fc2-multi-test', capability: 'clean_multi_room',
      rooms: ['living_room', 'hallway'], subject: 'oren',
      expiresAt, maxDispatches: 1 };
  } else if (underTest === 'home') {
    registry.underTest = { id: 'fc2-home-test', capability: 'clean_home', subject: 'oren',
      reviewedGeometrySha256: 'de38293681d645b1b6ef43435140650b0857745e22beab905b2dbd4f2e69aa7c',
      expiresAt, maxDispatches: 1 };
  } else if (underTest === 'multi-pause') {
    registry.underTest = { id: 'fc2-pause-multi-fixture', capability: 'pause',
      rooms: ['living_room', 'hallway'], subject: 'oren',
      expiresAt, maxDispatches: 1 };
  } else if (underTest === 'hallway-pause') {
    const cleanCapability = registry.capabilities.find((cap) => cap.name === 'clean_single_room');
    cleanCapability.verifiedRooms = cleanCapability.verifiedRooms.filter((item) =>
      ['guest_bathroom', 'hallway', 'living_room'].includes(item.room));
    const pauseCapability = registry.capabilities.find((cap) => cap.name === 'pause');
    pauseCapability.verifiedRooms = pauseCapability.verifiedRooms.filter((item) => item.room === 'guest_bathroom');
    registry.underTest = { id: 'fc2-pause-hallway-fixture', capability: 'pause', room: 'hallway',
      subject: 'oren', expiresAt, maxDispatches: 1 };
  } else if (underTest === 'pause') {
    const pause = registry.capabilities.find((cap) => cap.name === 'pause');
    pause.support = 'reported';
    pause.observedAt = null;
    pause.provenance = 'Deterministic canary fixture';
    delete pause.verifiedRooms;
    registry.underTest = { id: 'fc1-pause-canary-test', capability: 'pause', room: 'guest_bathroom',
      subject: 'oren', expiresAt, maxDispatches: 1 };
  } else if (underTest === 'dock') {
    const dock = registry.capabilities.find((cap) => cap.name === 'dock');
    dock.support = 'reported';
    dock.observedAt = null;
    dock.provenance = 'Deterministic canary fixture';
    delete dock.verifiedRooms;
    registry.underTest = { id: 'fc1-dock-canary-test', capability: 'dock', room: 'guest_bathroom',
      subject: 'oren', expiresAt, maxDispatches: 1 };
  }
  for (const name of capabilities) {
    const cap = registry.capabilities.find((item) => item.name === name);
    if (name === 'clean_single_room') {
      if (!cap.verifiedRooms.some((item) => item.room === 'living_room')) {
        cap.verifiedRooms.push({ room: 'living_room',
          observedAt: map.observedAt, provenance: 'Deterministic test fixture' });
      }
    } else if (name === 'clean_multi_room') {
      cap.verifiedRoomSets = [{ rooms: ['living_room', 'hallway'],
        observedAt: map.observedAt, provenance: 'Exact multi-room test fixture' }];
    } else if (name !== 'clean_home' || underTest !== 'home') cap.support = 'verified';
  }
  const store = createPluginStateSyncKeyedStore('benson-jessica-tool', {
    ...JESSICA_STATE_OPTIONS, env: { ...process.env, OPENCLAW_STATE_DIR: stateRoot },
  });
  const engine = createJessicaExecutor({ registryConfig: registry, policyConfig: policy, store,
    driver: wrapDriver(createSocketDriver(socketPath)), wait: () => Promise.resolve(),
    pollCounts: { clean: 3, setting: 2 } });
  return { dir, stateRoot, socketPath, server, store, engine, registry };
}

test('one-room under-test dispatch uses fresh HA task and exact segment evidence once', async (t) => {
  const f = await fixture(t, { liveTaskSignals: true, noTaskId: true, initialSegments: null }, [], mapFixture, true);
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] } };
  const first = await f.engine.execute(request, context('canary-first'));
  assert.equal(first.status, 'success', first.error?.code);
  assert.equal(f.engine.state.operation(first.data.operationId).value.data.outcome, 'started');
  assert.deepEqual(first.data.rooms, ['guest_bathroom']);
  assert.deepEqual(first.data.observation.activeSegments, [10]);
  assert.equal(f.server.state.posts.length, 1);
  assert.deepEqual(await f.engine.execute(request, context('canary-first')), first);
  f.server.state.status.state = 'docked';
  f.server.state.status.activeSegments = null;
  f.server.state.taskStatus.state = 'completed';
  const second = await f.engine.execute(request, context('canary-second'));
  assert.equal(second.error.code, 'RESOURCE_BUSY');
  assert.equal(f.server.state.posts.length, 1);
});

test('verified family room uses task signal without a task ID; blocked scopes send no POST', async (t) => {
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['kitchen'] } };
  const f = await fixture(t, { noTaskId: true, initialSegments: null }, []);
  const unauthorized = await f.engine.execute(request, { identity: { ...identity, senderId: 'unknown' },
    requestEpoch: 'scoped-unauthorized' });
  assert.equal(unauthorized.error.code, 'NOT_AUTHORIZED');
  const unverifiedGroup = await f.engine.execute(request, { identity: { ...identity, senderId: 'ilana',
    channelKind: 'group', perSenderVerified: false }, requestEpoch: 'scoped-unverified-group' });
  assert.equal(unverifiedGroup.error.code, 'IDENTITY_UNTRUSTED');
  const wrongRoom = await f.engine.execute(
    { operation: 'clean', target: { kind: 'rooms', rooms: ['west_balcony'] } }, context('scoped-wrong-room'));
  assert.equal(wrongRoom.error.code, 'ROOM_DISABLED');
  assert.equal(f.server.state.posts.length, 0);
  const result = await f.engine.execute(request, { identity: { ...identity, senderId: 'ilana',
    channelKind: 'group', perSenderVerified: true }, requestEpoch: 'scoped-allowed' });
  assert.equal(result.status, 'success', result.error?.code);
  assert.deepEqual(result.data.observation.activeSegments, [12]);
  assert.equal(result.data.observation.taskStatus.state, 'room_cleaning');
  assert.equal(f.server.state.posts.length, 1);
});

test('scoped suction read-back precedes one verified guest bathroom clean', async (t) => {
  const f = await fixture(t, { noTaskId: true, initialSegments: null }, [], mapFixture, 'suction');
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] },
    settings: { suction: 'strong' } };
  const wrong = { ...request, settings: { suction: 'quiet' } };
  assert.equal((await f.engine.execute(wrong, context('wrong-suction'))).error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(f.server.state.posts.length, 0);
  const result = await f.engine.execute(request, context('scoped-suction'));
  assert.equal(result.status, 'success', result.error?.code);
  assert.deepEqual(result.data.appliedSettings, { suction: 'strong' });
  assert.deepEqual(result.data.observation.activeSegments, [10]);
  assert.deepEqual(f.server.state.posts.map((step) => step.kind), ['setting', 'command']);
  assert.equal(f.server.state.posts[0].value, 'strong');
  assert.deepEqual(f.server.state.posts[1].segments, [10]);
  assert.deepEqual(await f.engine.execute(request, context('scoped-suction')), result);
  assert.equal(f.server.state.posts.length, 2);
  f.server.state.status.state = 'docked';
  f.server.state.status.activeSegments = null;
  f.server.state.status.currentSegment = null;
  f.server.state.taskStatus.state = 'completed';
  f.server.state.settings.suction = 'standard';
  f.server.state.deviceSuction = 'standard';
  assert.equal((await f.engine.execute(request, context('second-suction-canary'))).error.code, 'RESOURCE_BUSY');
  assert.equal(f.server.state.posts.length, 2);
});

test('promoted suction changes from another value before the verified room clean', async (t) => {
  const f = await fixture(t, { noTaskId: true, initialSegments: null }, [], mapFixture, 'verified-suction');
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] },
    settings: { suction: 'strong' } };
  assert.equal((await f.engine.execute({ ...request, settings: { suction: 'quiet' } },
    context('promoted-wrong-value'))).error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(f.server.state.posts.length, 0);
  const result = await f.engine.execute(request, context('promoted-change'));
  assert.equal(result.status, 'success', result.error?.code);
  assert.deepEqual(result.data.appliedSettings, { suction: 'strong' });
  assert.deepEqual(f.server.state.posts.map((step) => step.kind), ['setting', 'command']);
  assert.deepEqual(f.server.state.posts[1].segments, [10]);
});

test('promoted suction already set skips setting POST but verifies the room clean', async (t) => {
  const f = await fixture(t, { noTaskId: true, initialSegments: null }, [], mapFixture, 'verified-suction');
  f.server.state.settings.suction = 'strong';
  f.server.state.deviceSuction = 'strong';
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] },
    settings: { suction: 'strong' } };
  const result = await f.engine.execute(request, context('promoted-already-set'));
  assert.equal(result.status, 'success', result.error?.code);
  assert.deepEqual(result.data.appliedSettings, { suction: 'strong' });
  assert.deepEqual(f.server.state.posts.map((step) => step.kind), ['command']);
  assert.deepEqual(f.server.state.posts[0].segments, [10]);
  assert.deepEqual(await f.engine.execute(request, context('promoted-already-set')), result);
  assert.equal(f.server.state.posts.length, 1);
});

test('under-test suction already set cannot run an unprovable canary', async (t) => {
  const f = await fixture(t, { noTaskId: true, initialSegments: null }, [], mapFixture, 'suction');
  f.server.state.settings.suction = 'strong';
  f.server.state.deviceSuction = 'strong';
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] },
    settings: { suction: 'strong' } };
  assert.equal((await f.engine.execute(request, context('canary-already-set'))).error.code, 'SETTING_UNCHANGED');
  assert.equal(f.server.state.posts.length, 0);
});

test('scoped suction without a fresh selector transition never starts cleaning', async (t) => {
  const f = await fixture(t, { noTaskId: true, initialSegments: null,
    noTransitionFor: 'suction' }, [], mapFixture, 'suction');
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] },
    settings: { suction: 'strong' } };
  const result = await f.engine.execute(request, context('missing-suction-transition'));
  assert.equal(result.error.code, 'VERIFICATION_TIMEOUT');
  assert.equal(f.engine.state.active().phase, 'uncertain');
  assert.deepEqual(f.server.state.posts.map((step) => step.kind), ['setting']);
  assert.equal((await f.engine.execute(request, context('missing-suction-transition'))).error.code, 'OPERATION_PENDING');
  assert.equal(f.server.state.posts.length, 1);
  const misleading = await fixture(t, { noTaskId: true, initialSegments: null,
    noTransitionFor: 'suction', settingValueWithoutSource: true }, [], mapFixture, 'suction');
  const misleadingResult = await misleading.engine.execute(request, context('value-without-timestamp'));
  assert.equal(misleadingResult.error.code, 'VERIFICATION_TIMEOUT');
  assert.deepEqual(misleading.server.state.posts.map((step) => step.kind), ['setting']);
});

test('scoped suction cannot claim cleaning success when vacuum suction disagrees', async (t) => {
  const f = await fixture(t, { noTaskId: true, initialSegments: null,
    staleDeviceSuction: true }, [], mapFixture, 'suction');
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] },
    settings: { suction: 'strong' } };
  const result = await f.engine.execute(request, context('stale-vacuum-suction'));
  assert.equal(result.error.code, 'VERIFICATION_TIMEOUT');
  assert.equal(result.verified, false);
  assert.deepEqual(result.data.appliedSettings, { suction: 'strong' });
  assert.deepEqual(f.server.state.posts.map((step) => step.kind), ['setting', 'command']);
  assert.equal(f.engine.state.active().phase, 'uncertain');
});

test('under-test scope and missing transition fail closed', async (t) => {
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] } };
  const wrongRoom = await fixture(t, { liveTaskSignals: true, noTaskId: true, initialSegments: null }, [], mapFixture, true);
  assert.equal((await wrongRoom.engine.execute(clean, context('wrong-room'))).error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(wrongRoom.server.state.posts.length, 0);
  const missing = await fixture(t, { liveTaskSignals: true, noTaskId: true, initialSegments: null,
    noTaskStatusTransition: true }, [], mapFixture, true);
  const result = await missing.engine.execute(request, context('missing-task-transition'));
  assert.equal(result.error.code, 'VERIFICATION_TIMEOUT');
  assert.equal(missing.engine.state.active().phase, 'uncertain');
  assert.equal(missing.server.state.posts.length, 1);
  const nullTarget = await fixture(t, { liveTaskSignals: true, noTaskId: true, initialSegments: null,
    nullActiveSegmentsAfterPost: true }, [], mapFixture, true);
  assert.equal((await nullTarget.engine.execute(request, context('null-target'))).error.code, 'VERIFICATION_TIMEOUT');
  assert.equal(nullTarget.server.state.posts.length, 1);
});

function worker({ socketPath, stateRoot }, epoch, mode = 'normal', request = clean) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'executor-worker.mjs'), socketPath, stateRoot,
      epoch, mode, JSON.stringify(request)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output: output.trim(), error: error.trim() }));
  });
}

async function until(predicate) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('bounded state wait expired');
}

test('single-room success is bound to one POST and an epoch-stable result', async (t) => {
  const f = await fixture(t);
  const first = await f.engine.execute(clean, context('external-message-1'));
  assert.equal(first.status, 'success');
  assert.equal(first.data.outcome, 'started');
  assert.deepEqual(first.data.rooms, ['living_room']);
  assert.equal(f.server.state.posts.length, 1);
  const duplicate = await f.engine.execute(clean, context('external-message-1'));
  assert.deepEqual(duplicate, first);
  assert.equal(f.server.state.posts.length, 1);
  const changed = await f.engine.execute({ ...clean, target: { kind: 'rooms', rooms: ['kitchen'] } }, context('external-message-1'));
  assert.equal(changed.error.code, 'EPOCH_CONFLICT');
  assert.equal(f.server.state.posts.length, 1);
});

test('P04 started result and an uncorrelated idle observation do not release physical ownership', async (t) => {
  const f = await fixture(t);
  const first = await f.engine.execute(clean, context('p04-owner'));
  assert.equal(first.status, 'success');
  assert.equal(first.data.outcome, 'started');
  assert.equal(f.engine.state.active(), null);
  f.server.state.status.state = 'docked';
  f.server.state.status.activeSegments = null;
  f.server.state.status.currentSegment = null;
  f.server.state.taskStatus.state = 'completed';
  const second = await f.engine.execute(clean, context('p04-competing'));
  assert.equal(second.error?.code, 'RESOURCE_BUSY');
  assert.equal(f.server.state.posts.length, 1);
  assert.deepEqual(await f.engine.execute(clean, context('p04-owner')), first);
  for (const senderId of ['oren', 'ilana']) {
    const control = await f.engine.execute({ operation: 'pause' }, {
      identity: { ...identity, senderId }, requestEpoch: `p04-new-control-${senderId}`,
    });
    assert.equal(control.error.code, 'RESOURCE_BUSY');
  }
  assert.equal(f.server.state.posts.length, 1);
});

test('P04 invalid native ownership returns a structured refusal without a mutation', async (t) => {
  const f = await fixture(t);
  f.store.register('device:jessica-vacuum', { version: '1', active: null });
  const outcome = await f.engine.execute(clean, context('p04-unprovable-owner'));
  assert.equal(outcome.status, 'failure');
  assert.equal(outcome.error.code, 'RESOURCE_STATE_UNAVAILABLE');
  assert.equal(outcome.error.sideEffects, 'possible');
  const recovered = await f.engine.reconcile(clean, context('p04-unprovable-owner'));
  assert.equal(recovered.error.code, 'RESOURCE_STATE_UNAVAILABLE');
  assert.equal(recovered.error.sideEffects, 'possible');
  assert.equal(f.server.state.posts.length, 0);
  assert.deepEqual(f.store.lookup('device:jessica-vacuum'), { version: '1', active: null });
});

test('Oren-only multi-room canary rejects other sets and settings before POST, then dispatches once', async (t) => {
  const f = await fixture(t, { noTaskId: true, initialSegments: null }, [], mapFixture, 'multi');
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['living_room', 'hallway'] } };
  for (const rejected of [
    { operation: 'clean', target: { kind: 'rooms', rooms: ['living_room', 'guest_bathroom'] } },
    { ...request, settings: { suction: 'strong' } },
  ]) {
    assert.equal((await f.engine.execute(rejected, context(`rejected-${JSON.stringify(rejected)}`))).error.code,
      'CAPABILITY_UNSUPPORTED');
  }
  assert.equal((await f.engine.execute(request, {
    identity: { ...identity, senderId: 'ilana' }, requestEpoch: 'other-subject',
  })).error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(f.server.state.posts.length, 0);
  const first = await f.engine.execute(request, context('multi-canary-first'));
  assert.equal(first.status, 'success', first.error?.code);
  assert.deepEqual(first.data.observation.activeSegments, [8, 7]);
  assert.equal(f.server.state.posts.length, 1);
  assert.deepEqual(f.server.state.posts[0].segments, [8, 7]);
  assert.deepEqual(await f.engine.execute(request, context('multi-canary-first')), first);
  assert.equal(f.server.state.posts.length, 1);
  f.server.state.status.state = 'docked';
  f.server.state.status.activeSegments = null;
  f.server.state.taskStatus.state = 'completed';
  assert.equal((await f.engine.execute(request, context('multi-canary-second'))).error.code,
    'RESOURCE_BUSY');
  assert.equal(f.server.state.posts.length, 1);
});

test('multi-room start requires one exact target set and a new device task signal without task ID', async (t) => {
  const f = await fixture(t, { noTaskId: true, initialSegments: null }, ['clean_multi_room']);
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['living_room', 'hallway'] } };
  const result = await f.engine.execute(request, context('multi-room-exact'));
  assert.equal(result.status, 'success', result.error?.code);
  assert.deepEqual(result.data.rooms, ['living_room', 'hallway']);
  assert.deepEqual(result.data.observation.activeSegments, [8, 7]);
  assert.equal(result.data.observation.taskStatus.state, 'room_cleaning');
  assert.equal(f.server.state.posts.length, 1);
  assert.deepEqual(f.server.state.posts[0].segments, [8, 7]);
});

test('multi-room wrong target becomes durable uncertainty and is never resent', async (t) => {
  const f = await fixture(t, { noTaskId: true, initialSegments: null, wrongSegments: true }, ['clean_multi_room']);
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['living_room', 'hallway'] } };
  const result = await f.engine.execute(request, context('multi-room-mismatch'));
  assert.equal(result.error.code, 'TARGET_MISMATCH');
  assert.equal(f.engine.state.active().phase, 'uncertain');
  assert.equal(f.server.state.posts.length, 1);
  assert.equal((await f.engine.execute(request, context('multi-room-mismatch'))).error.code, 'OPERATION_PENDING');
  assert.equal(f.server.state.posts.length, 1);
});

test('authorization, stale map, unavailable state and null target evidence send no POST', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.engine.execute(clean, { identity: { ...identity, senderId: 'unknown' }, requestEpoch: 'a' })).error.code, 'NOT_AUTHORIZED');
  assert.equal((await f.engine.execute(clean, { identity, requestEpoch: '' })).error.code, 'EPOCH_UNTRUSTED');
  assert.equal(f.server.state.posts.length, 0);
  const changedMap = structuredClone(mapFixture); changedMap.rooms[0].name += ' changed';
  const g = await fixture(t, {}, ['clean_single_room'], changedMap);
  assert.equal((await g.engine.execute(clean, context('map-changed'))).error.code, 'MAP_CHANGED');
  assert.equal(g.server.state.posts.length, 0);
  const h = await fixture(t, { initialState: 'cleaning', nullActiveSegments: true });
  assert.equal((await h.engine.execute(clean, context('null-state'))).error.code, 'CONFLICT_ACTIVE_TASK');
  assert.equal(h.server.state.posts.length, 0);
});

test('map change before dispatch and null attributes after POST never become success', async (t) => {
  const changed = await fixture(t, { mapChangeOnRead: 2 });
  const preDispatch = await changed.engine.execute(clean, context('map-before-dispatch'));
  assert.equal(preDispatch.error.code, 'MAP_CHANGED');
  assert.equal(changed.server.state.posts.length, 0);
  assert.equal(changed.engine.state.active(), null);
  const missing = await fixture(t, { nullActiveSegmentsAfterPost: true });
  const post = await missing.engine.execute(clean, context('null-after-post'));
  assert.equal(post.status, 'failure');
  assert.equal(post.error.code, 'VERIFICATION_TIMEOUT');
  assert.equal(missing.engine.state.active().phase, 'uncertain');
  assert.equal(missing.server.state.posts.length, 1);
});

function activeRoom(f, area = 1) {
  const started = new Date(Date.now() - 4_000).toISOString();
  f.server.state.taskStatus = { state: 'room_cleaning', sourceUpdatedAt: started };
  f.server.state.currentArea = { value: area, sourceUpdatedAt: new Date(Date.now() - 1_000).toISOString() };
  f.server.state.currentTime = { value: 0, sourceUpdatedAt: new Date(Date.now() - 1_000).toISOString() };
  f.server.state.chargingStatus = { value: 'not_charging', sourceUpdatedAt: started };
}

test('current-room pause needs positive fresh progress and an independent task-status transition', async (t) => {
  const f = await fixture(t, { initialState: 'cleaning', initialSegments: [10], noTaskId: true,
    liveTaskSignals: true }, ['pause']);
  activeRoom(f);
  const first = await f.engine.execute({ operation: 'pause' }, context('pause-current'));
  assert.equal(first.status, 'success', first.error?.code);
  assert.equal(first.data.outcome, 'paused');
  assert.equal(first.data.observation.taskStatus.state, 'room_cleaning_paused');
  assert.equal(f.server.state.posts.length, 1);
  assert.deepEqual(await f.engine.execute({ operation: 'pause' }, context('pause-current')), first);
  assert.equal(f.server.state.posts.length, 1);
  const noProgress = await fixture(t, { initialState: 'cleaning', initialSegments: [10], noTaskId: true,
    liveTaskSignals: true, currentArea: { value: 0, sourceUpdatedAt: new Date().toISOString() } }, ['pause']);
  activeRoom(noProgress, 0);
  assert.equal((await noProgress.engine.execute({ operation: 'pause' }, context('pause-no-progress'))).error.code,
    'STATE_UNVERIFIED');
  assert.equal(noProgress.server.state.posts.length, 0);
});

test('FC2 hallway pause uses the one-shot claim and fresh current-room evidence', async (t) => {
  const f = await fixture(t, { initialState: 'cleaning', initialSegments: [7], noTaskId: true,
    liveTaskSignals: true }, [], mapFixture, 'hallway-pause');
  activeRoom(f);
  const result = await f.engine.execute({ operation: 'pause' }, context('oren-hallway-pause'));
  assert.equal(result.status, 'success', result.error?.code);
  assert.equal(result.data.outcome, 'paused');
  assert.deepEqual(result.data.rooms, ['hallway']);
  assert.equal(f.server.state.posts.length, 1);
  assert.deepEqual(f.server.state.posts[0].segments, [7]);
  f.server.state.status.state = 'cleaning';
  f.server.state.taskStatus = { state: 'room_cleaning', sourceUpdatedAt: new Date(Date.now() - 4_000).toISOString() };
  const second = await f.engine.execute({ operation: 'pause' }, context('oren-hallway-pause-again'));
  assert.equal(second.error.code, 'RESOURCE_BUSY');
  assert.equal(f.server.state.posts.length, 1);
});

test('current-room pause accepts fresh positive cleaning time when area has not advanced', async (t) => {
  const f = await fixture(t, { initialState: 'cleaning', initialSegments: [10], noTaskId: true,
    liveTaskSignals: true }, ['pause']);
  activeRoom(f, 0);
  f.server.state.currentTime = { value: 1, sourceUpdatedAt: new Date(Date.now() - 500).toISOString() };
  const result = await f.engine.execute({ operation: 'pause' }, context('pause-time-progress'));
  assert.equal(result.status, 'success', result.error?.code);
  assert.equal(result.data.outcome, 'paused');
  assert.equal(f.server.state.posts.length, 1);
});

test('optimistic paused state without task-status transition remains uncertain and sends once', async (t) => {
  const f = await fixture(t, { initialState: 'cleaning', initialSegments: [10], noTaskId: true,
    liveTaskSignals: true, noTaskStatusTransition: true }, ['pause']);
  activeRoom(f);
  const first = await f.engine.execute({ operation: 'pause' }, context('pause-optimistic'));
  assert.equal(first.error.code, 'VERIFICATION_TIMEOUT');
  assert.equal(f.engine.state.active().phase, 'uncertain');
  assert.equal(f.server.state.posts.length, 1);
  assert.equal((await f.engine.execute({ operation: 'pause' }, context('pause-optimistic'))).error.code,
    'OPERATION_PENDING');
  assert.equal(f.server.state.posts.length, 1);
});

test('one-shot pause canary binds Oren and cannot be reused', async (t) => {
  const f = await fixture(t, { initialState: 'cleaning', initialSegments: [10], noTaskId: true,
    liveTaskSignals: true }, [], mapFixture, 'pause');
  activeRoom(f);
  const denied = await f.engine.execute({ operation: 'pause' }, {
    identity: { ...identity, senderId: 'ilana' }, requestEpoch: 'wrong-subject',
  });
  assert.equal(denied.error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(f.server.state.posts.length, 0);
  const first = await f.engine.execute({ operation: 'pause' }, context('oren-first'));
  assert.equal(first.status, 'success', first.error?.code);
  assert.equal(f.server.state.posts.length, 1);
  f.server.state.status.state = 'cleaning';
  activeRoom(f);
  const second = await f.engine.execute({ operation: 'pause' }, context('oren-second'));
  assert.equal(second.error.code, 'RESOURCE_BUSY');
  assert.equal(f.server.state.posts.length, 1);
});

test('dock verifies new charging evidence; returning alone cannot succeed', async (t) => {
  const base = { initialState: 'cleaning', initialSegments: [10], noTaskId: true,
    liveTaskSignals: true, dockArrives: true };
  const f = await fixture(t, base, ['dock']);
  activeRoom(f);
  const result = await f.engine.execute({ operation: 'dock' }, context('dock-current'));
  assert.equal(result.status, 'success', result.error?.code);
  assert.equal(result.data.outcome, 'docked');
  assert.equal(result.data.observation.chargingStatus.value, 'charging');
  const optimistic = await fixture(t, { ...base, dockArrives: false }, ['dock']);
  activeRoom(optimistic);
  assert.equal((await optimistic.engine.execute({ operation: 'dock' }, context('dock-returning'))).error.code,
    'VERIFICATION_TIMEOUT');
  assert.equal(optimistic.server.state.posts.length, 1);
});

test('one-shot dock canary binds Oren and cannot be reused', async (t) => {
  const f = await fixture(t, { initialState: 'cleaning', initialSegments: [10], noTaskId: true,
    liveTaskSignals: true, dockArrives: true }, [], mapFixture, 'dock');
  activeRoom(f);
  const denied = await f.engine.execute({ operation: 'dock' }, {
    identity: { ...identity, senderId: 'ilana' }, requestEpoch: 'dock-wrong-subject',
  });
  assert.equal(denied.error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(f.server.state.posts.length, 0);
  const first = await f.engine.execute({ operation: 'dock' }, context('dock-oren-first'));
  assert.equal(first.status, 'success', first.error?.code);
  assert.equal(first.data.outcome, 'docked');
  assert.equal(f.server.state.posts.length, 1);
  f.server.state.status.state = 'cleaning';
  f.server.state.status.activeSegments = [10];
  activeRoom(f);
  const second = await f.engine.execute({ operation: 'dock' }, context('dock-oren-second'));
  assert.equal(second.error.code, 'RESOURCE_BUSY');
  assert.equal(f.server.state.posts.length, 1);
});

test('stop and same-task resume remain blocked even if a fixture marks them verified', async (t) => {
  for (const operation of ['stop', 'resume']) {
    const f = await fixture(t, { initialState: operation === 'stop' ? 'cleaning' : 'paused',
      initialSegments: [10], initialTaskId: 'synthetic-id', liveTaskSignals: true }, [operation]);
    activeRoom(f);
    const result = await f.engine.execute({ operation }, context(`blocked-${operation}`));
    assert.equal(result.error.code, 'VERIFICATION_UNAVAILABLE');
    assert.equal(f.server.state.posts.length, 0);
  }
});

test('one-shot home canary binds Oren, reviewed geometry and new device AUTO_CLEANING evidence', async (t) => {
  const f = await fixture(t, { homeEvidence: true, initialSegments: null, noTaskId: true },
    ['clean_home'], mapFixture, 'home');
  const request = { operation: 'clean', target: { kind: 'home' } };
  const family = await f.engine.execute(request, { identity: { ...identity, senderId: 'ilana' },
    requestEpoch: 'home-family' });
  assert.equal(family.error.code, 'CAPABILITY_UNSUPPORTED');
  const settings = await f.engine.execute({ ...request, settings: { suction: 'strong' } },
    context('home-settings'));
  assert.equal(settings.error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(f.server.state.posts.length, 0);
  const first = await f.engine.execute(request, context('home-first'));
  assert.equal(first.status, 'success', first.error?.code);
  assert.deepEqual(first.data.rooms, []);
  assert.equal(first.data.outcome, 'started');
  assert.equal(first.data.observation.homeTask.value, 1);
  assert.equal(first.data.observation.homeTask.geometrySha256,
    'de38293681d645b1b6ef43435140650b0857745e22beab905b2dbd4f2e69aa7c');
  assert.equal(f.server.state.posts.length, 1);
  assert.equal(f.server.state.posts[0].targetKind, 'home');
  assert.deepEqual(f.server.state.posts[0].segments, []);
  assert.deepEqual(await f.engine.execute(request, context('home-first')), first);
  f.server.state.status.state = 'docked';
  f.server.state.status.activeSegments = null;
  f.server.state.taskStatus.state = 'completed';
  f.server.state.taskDevice.value = 0;
  const second = await f.engine.execute(request, context('home-second'));
  assert.equal(second.error.code, 'RESOURCE_BUSY');
  assert.equal(f.server.state.posts.length, 1);
});

test('home canary preflight fails closed for missing or contradicted exclusions and idle evidence', async (t) => {
  const cases = [
    ['digest', (state) => { state.homeGeometry.sha256 = 'f'.repeat(64); }],
    ['hidden', (state) => { state.homeGeometry.hiddenSegmentIds = [3, 9, 15]; }],
    ['no-go', (state) => { state.homeGeometry.noGoCount = 0; }],
    ['walls', (state) => { state.homeGeometry.virtualWallCount = 4; }],
    ['device-code', (state) => { state.taskDevice.value = 1; }],
    ['stale-device-read', (state) => { state.taskDevice.sourceReadAt = '2026-01-01T00:00:00Z'; }],
    ['stale-map-read', (state) => { state.homeGeometry.deviceMapListReadAt = '2026-01-01T00:00:00Z'; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest, { homeEvidence: true, initialSegments: null, noTaskId: true },
        ['clean_home'], mapFixture, 'home');
      mutate(f.server.state);
      const result = await f.engine.execute({ operation: 'clean', target: { kind: 'home' } },
        context(`home-reject-${name}`));
      assert.equal(result.status, 'failure');
      assert.equal(f.server.state.posts.length, 0);
      assert.equal(f.engine.state.active(), null);
    });
  }
});

test('home dispatch remains uncertain without post-POST device and map proof, never resends', async (t) => {
  for (const [name, behavior] of [
    ['device-stays-idle', { noHomeTaskTransition: true }],
    ['wrong-device-code', { wrongHomeTask: 2 }],
    ['map-read-not-refreshed', { noHomeMapRead: true }],
    ['digest-changed', { changedHomeDigest: true }],
    ['room-target-echo', { wrongSegments: true }],
  ]) {
    await t.test(name, async (subtest) => {
      const f = await fixture(subtest, { homeEvidence: true, initialSegments: null,
        noTaskId: true, ...behavior }, ['clean_home'], mapFixture, 'home');
      const request = { operation: 'clean', target: { kind: 'home' } };
      const first = await f.engine.execute(request, context(`home-uncertain-${name}`));
      assert.equal(first.status, 'failure');
      assert.equal(first.verified, false);
      assert.equal(f.server.state.posts.length, 1);
      const again = await f.engine.execute(request, context(`home-uncertain-${name}`));
      assert.equal(again.status, 'failure');
      assert.equal(f.server.state.posts.length, 1);
    });
  }
});

test('full-home claim remains blocked without Stage 2 verified task-scope result contract', async (t) => {
  const f = await fixture(t, {}, ['clean_home']);
  const result = await f.engine.execute({ operation: 'clean', target: { kind: 'home' } }, context('home-unverified'));
  assert.equal(result.status, 'failure');
  assert.equal(result.error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(f.engine.state.active(), null);
  assert.equal(f.server.state.posts.length, 0);
});

test('crash before dispatch marker can resume the same intent once', async (t) => {
  const f = await fixture(t);
  const crash = await worker(f, 'crash-before-epoch', 'crash-before');
  assert.equal(crash.code, 71, crash.error);
  assert.equal(f.server.state.posts.length, 0);
  assert.equal(f.engine.state.active().phase, 'prepared');
  const resumed = await worker(f, 'crash-before-epoch');
  assert.equal(resumed.code, 0, resumed.error);
  assert.equal(JSON.parse(resumed.output).status, 'success');
  assert.equal(f.server.state.posts.length, 1);
});

test('crash after marker preserves uncertainty and blocks all resend', async (t) => {
  const f = await fixture(t);
  const crash = await worker(f, 'crash-marker-epoch', 'crash-after-marker');
  assert.equal(crash.code, 71, crash.error);
  assert.equal(f.server.state.posts.length, 0);
  assert.equal(f.engine.state.active().phase, 'dispatching');
  assert.equal((await f.engine.execute(clean, context('crash-marker-epoch'))).error.code, 'OPERATION_PENDING');
  assert.equal((await f.engine.execute(clean, context('another-message'))).error.code, 'CONFLICT_UNRESOLVED');
  assert.equal((await f.engine.reconcile(clean, context('crash-marker-epoch'))).error.code, 'RECONCILIATION_UNRESOLVED');
  assert.equal(f.engine.state.active().phase, 'dispatching');
  assert.notEqual(f.engine.state.resource().inFlight, null);
  assert.equal(f.server.state.posts.length, 0);
});

test('crash after POST never resends even when readback matches', async (t) => {
  const f = await fixture(t);
  const crash = await worker(f, 'crash-post-epoch', 'crash-after-post');
  assert.equal(crash.code, 71, crash.error);
  assert.equal(f.server.state.posts.length, 1);
  assert.equal((await f.engine.execute(clean, context('crash-post-epoch'))).error.code, 'OPERATION_PENDING');
  assert.equal((await f.engine.reconcile(clean, context('crash-post-epoch'))).error.code, 'DISPATCH_UNCERTAIN');
  assert.equal(f.server.state.posts.length, 1);
});

test('crash after accepted dispatch reconciles without a second POST', async (t) => {
  const f = await fixture(t);
  const crash = await worker(f, 'crash-ack-epoch', 'crash-after-ack');
  assert.equal(crash.code, 71, crash.error);
  assert.equal(f.server.state.posts.length, 1);
  assert.equal(f.engine.state.active().phase, 'verifying');
  assert.equal(f.engine.state.active().dispatch, 'accepted');
  const result = await f.engine.reconcile(clean, context('crash-ack-epoch'));
  assert.equal(result.status, 'success');
  assert.equal(result.data.outcome, 'started');
  assert.equal(f.engine.state.active(), null);
  assert.equal(f.server.state.posts.length, 1);
  assert.deepEqual(await f.engine.execute(clean, context('crash-ack-epoch')), result);
  assert.equal(f.server.state.posts.length, 1);
});

test('timeout and wrong target remain durable uncertainty, with no resend', async (t) => {
  const timeout = await fixture(t, { noTransition: true });
  assert.equal((await timeout.engine.execute(clean, context('timeout'))).error.code, 'VERIFICATION_TIMEOUT');
  assert.equal(timeout.engine.state.active().phase, 'uncertain');
  assert.equal((await timeout.engine.execute(clean, context('timeout'))).error.code, 'OPERATION_PENDING');
  assert.equal(timeout.server.state.posts.length, 1);
  const mismatch = await fixture(t, { wrongSegments: true });
  assert.equal((await mismatch.engine.execute(clean, context('wrong-target'))).error.code, 'TARGET_MISMATCH');
  assert.equal(mismatch.engine.state.active().phase, 'uncertain');
  assert.equal(mismatch.server.state.posts.length, 1);
});

test('partial setting change is reported and cleaning is not dispatched', async (t) => {
  const f = await fixture(t, { noTransitionFor: 'mode' }, ['clean_single_room', 'clean_settings']);
  const request = { ...clean, settings: { suction: 'quiet', mode: 'mopping' } };
  const result = await f.engine.execute(request, context('partial-setting'));
  assert.equal(result.status, 'failure');
  assert.equal(result.error.sideEffects, 'observed');
  assert.deepEqual(result.data.appliedSettings, { suction: 'quiet' });
  assert.deepEqual(f.server.state.posts.map((step) => step.kind), ['setting', 'setting']);
  assert.equal(f.engine.state.active().phase, 'uncertain');
});

test('P04 delayed setting reconciliation cannot overwrite a newer accepted command or its final result', { timeout: 10_000 }, async (t) => {
  for (const afterFinal of [false, true]) await t.test(afterFinal ? 'after finalization' : 'after command acceptance', async (t) => {
    const barrier = () => {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      return { promise, release };
    };
    const settingPoll = barrier(), resumeSetting = barrier();
    const capturedReconcile = barrier(), resumeReconcile = barrier();
    const commandPoll = barrier(), resumeCommand = barrier();
    let reads = 0;
    const f = await fixture(t, {}, [], mapFixture, 'verified-suction', (driver) => ({
      ...driver,
      async read() {
        const call = ++reads;
        const evidence = await driver.read();
        if (call === 3) { settingPoll.release(); await resumeSetting.promise; }
        if (call === 4) { capturedReconcile.release(); await resumeReconcile.promise; }
        if (call === 6) { commandPoll.release(); await resumeCommand.promise; }
        return evidence;
      },
    }));
    t.after(() => { resumeSetting.release(); resumeReconcile.release(); resumeCommand.release(); });
    const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] },
      settings: { suction: 'strong' } };
    const ctx = context(`p04-delayed-reconcile-${afterFinal}`);
    const executing = f.engine.execute(request, ctx);
    await settingPoll.promise;
    const reconciling = f.engine.reconcile(request, ctx);
    await capturedReconcile.promise;
    resumeSetting.release();
    await commandPoll.promise;
    assert.equal(f.engine.state.active().stepIndex, 1);
    assert.equal(f.engine.state.active().dispatch, 'accepted');
    let result;
    if (afterFinal) { resumeCommand.release(); result = await executing; }
    resumeReconcile.release();
    const reconciled = await reconciling;
    if (afterFinal) assert.deepEqual(reconciled, result);
    else {
      assert.equal(reconciled.error.code, 'OPERATION_PENDING');
      assert.equal(reconciled.error.sideEffects, 'observed');
      assert.equal(f.engine.state.active().stepIndex, 1);
      assert.equal(f.engine.state.active().dispatch, 'accepted');
      resumeCommand.release();
      result = await executing;
    }
    assert.equal(result.status, 'success', result.error?.code);
    assert.equal(result.data.outcome, 'started');
    assert.deepEqual(result.data.appliedSettings, { suction: 'strong' });
    assert.equal(f.server.state.posts.length, 2);
    assert.deepEqual(await f.engine.reconcile(request, ctx), result);
    assert.deepEqual(await f.engine.execute(request, ctx), result);
    assert.equal(f.server.state.posts.length, 2);
    assert.equal(f.engine.state.active(), null);
    assert.equal(f.engine.state.resource().owner.operationId, result.data.operationId);
  });
});

test('P04 a delayed same-epoch duplicate preserves accepted execution and its canonical final', { timeout: 10_000 }, async (t) => {
  for (const afterFinal of [false, true]) await t.test(afterFinal ? 'after finalization' : 'after acceptance', async (t) => {
    const barrier = () => {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      return { promise, release };
    };
    const capturedDuplicate = barrier(), resumeDuplicate = barrier();
    const verifying = barrier(), resumeVerification = barrier();
    let reads = 0;
    const f = await fixture(t, {}, ['clean_single_room'], mapFixture, false, (driver) => ({
      ...driver,
      async read() {
        const call = ++reads;
        const evidence = await driver.read();
        if (call === 1) { capturedDuplicate.release(); await resumeDuplicate.promise; }
        if (call === 4) { verifying.release(); await resumeVerification.promise; }
        return evidence;
      },
    }));
    t.after(() => { resumeDuplicate.release(); resumeVerification.release(); });
    const ctx = context(`p04-delayed-duplicate-${afterFinal}`);
    const duplicate = f.engine.execute(clean, ctx);
    await capturedDuplicate.promise;
    const executing = f.engine.execute(clean, ctx);
    await verifying.promise;
    let result;
    if (afterFinal) { resumeVerification.release(); result = await executing; }
    resumeDuplicate.release();
    const repeated = await duplicate;
    if (afterFinal) assert.deepEqual(repeated, result);
    else {
      assert.equal(repeated.error.code, 'OPERATION_PENDING');
      assert.equal(f.engine.state.active().phase, 'verifying');
      assert.equal(f.engine.state.active().dispatch, 'accepted');
      resumeVerification.release();
      result = await executing;
    }
    assert.equal(result.status, 'success', result.error?.code);
    assert.equal(result.data.outcome, 'started');
    assert.deepEqual(await f.engine.execute(clean, ctx), result);
    assert.deepEqual(await f.engine.reconcile(clean, ctx), result);
    assert.equal(f.server.state.posts.length, 1);
    assert.equal(f.engine.state.active(), null);
    assert.equal(f.engine.state.resource().owner.operationId, result.data.operationId);
  });
});

test('P04 a history miss before concurrent finalization preserves execute and reconcile success', async (t) => {
  const f = await fixture(t);
  const ctx = context('p04-history-read-race');
  const result = await f.engine.execute(clean, ctx);
  assert.equal(result.status, 'success', result.error?.code);
  const before = f.store.lookup('device:jessica-vacuum');
  let stale = true;
  const racedStore = {
    lookup(key) {
      const current = f.store.lookup(key);
      // The first history read predates completion; later native reads see it.
      if (stale && key.startsWith('request:')) { stale = false; return undefined; }
      return current;
    },
    update: (...args) => f.store.update(...args),
    registerIfAbsent: (...args) => f.store.registerIfAbsent(...args),
  };
  const duplicate = createJessicaExecutor({ registryConfig: f.registry, policyConfig: policy, store: racedStore,
    driver: createSocketDriver(f.socketPath), wait: () => Promise.resolve(), pollCounts: { clean: 3 } });
  assert.deepEqual(await duplicate.execute(clean, ctx), result);
  assert.equal(stale, false);
  stale = true;
  assert.deepEqual(await duplicate.reconcile(clean, ctx), result);
  assert.equal(stale, false);
  assert.equal(f.server.state.posts.length, 1);
  assert.deepEqual(f.store.lookup('device:jessica-vacuum'), before);
});

test('P04 a delayed pre-dispatch read failure recovers newer pending or canonical final state', { timeout: 10_000 }, async (t) => {
  for (const afterFinal of [false, true]) await t.test(afterFinal ? 'after finalization' : 'after acceptance', async (t) => {
    const barrier = () => {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      return { promise, release };
    };
    const delayed = barrier(), failRead = barrier(), verifying = barrier(), resumeVerification = barrier();
    let reads = 0;
    const f = await fixture(t, {}, ['clean_single_room'], mapFixture, false, (driver) => ({
      ...driver,
      async read() {
        const call = ++reads;
        const evidence = await driver.read();
        if (call === 2) {
          delayed.release(); await failRead.promise;
          throw Error('Fixture delayed pre-dispatch read failure');
        }
        if (call === 5) { verifying.release(); await resumeVerification.promise; }
        return evidence;
      },
    }));
    t.after(() => { failRead.release(); resumeVerification.release(); });
    const ctx = context(`p04-delayed-read-failure-${afterFinal}`);
    const duplicate = f.engine.execute(clean, ctx);
    await delayed.promise;
    const executing = f.engine.execute(clean, ctx);
    await verifying.promise;
    let result;
    if (afterFinal) { resumeVerification.release(); result = await executing; }
    failRead.release();
    const recovered = await duplicate;
    if (afterFinal) assert.deepEqual(recovered, result);
    else {
      assert.equal(recovered.error.code, 'OPERATION_PENDING');
      assert.equal(recovered.error.sideEffects, 'possible');
      assert.equal(f.engine.state.active().dispatch, 'accepted');
      resumeVerification.release();
      result = await executing;
    }
    assert.equal(result.status, 'success', result.error?.code);
    assert.deepEqual(await f.engine.execute(clean, ctx), result);
    assert.deepEqual(await f.engine.reconcile(clean, ctx), result);
    assert.equal(f.server.state.posts.length, 1);
    assert.equal(f.engine.state.resource().owner.operationId, result.data.operationId);
  });
});

test('P04 pre-dispatch failures preserve a previously verified setting effect', async (t) => {
  for (const kind of ['read', 'map', 'precondition']) await t.test(kind, async (t) => {
    let reads = 0;
    const f = await fixture(t, {}, [], mapFixture, 'verified-suction', (driver) => ({
      ...driver,
      async read() {
        const evidence = await driver.read();
        if (++reads === 4) {
          if (kind === 'read') throw Error('Fixture read unavailable after setting');
          if (kind === 'map') evidence.map.mapId = 'fixture-changed-map';
          if (kind === 'precondition') evidence.status.state = 'paused';
        }
        return evidence;
      },
    }));
    const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] },
      settings: { suction: 'strong' } };
    const ctx = context(`p04-effects-${kind}`);
    const result = await f.engine.execute(request, ctx);
    const codes = { read: 'READ_UNAVAILABLE', map: 'MAP_CHANGED', precondition: 'PRECONDITION_CHANGED' };
    assert.equal(result.error.code, codes[kind]);
    assert.deepEqual(result.data.appliedSettings, { suction: 'strong' });
    assert.equal(result.error.sideEffects, 'observed');
    assert.equal(result.data.outcome, 'unknown');
    assert.equal(result.data.dispatch, 'unknown');
    assert.deepEqual(f.server.state.posts.map(step => step.kind), ['setting']);
    if (kind === 'read') assert.equal(f.engine.state.active().phase, 'prepared');
    else {
      assert.equal(f.engine.state.active(), null);
      assert.deepEqual(await f.engine.execute(request, ctx), result);
      assert.deepEqual(await f.engine.reconcile(request, ctx), result);
    }
    assert.equal(f.engine.state.resource().owner.operationId, result.data.operationId);
  });
});

test('P04 intermittent pending-state lookup failures preserve structured known effects without replay', async (t) => {
  const f = await fixture(t, {}, [], mapFixture, 'verified-suction');
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] },
    settings: { suction: 'strong' } };
  const ctx = context('p04-pending-lookup-failure');
  const interrupted = createJessicaExecutor({ registryConfig: f.registry, policyConfig: policy, store: f.store,
    driver: createSocketDriver(f.socketPath), wait: () => Promise.resolve(), pollCounts: { clean: 3, setting: 2 },
    hooks: { afterDispatchMarker(active) { if (active.stepIndex === 1) throw Error('Fixture lost command actor'); } } });
  assert.equal((await interrupted.execute(request, ctx)).error.sideEffects, 'observed');
  const before = f.store.lookup('device:jessica-vacuum');
  assert.equal(before.active.phase, 'dispatching');
  assert.deepEqual(before.active.appliedSettings, { suction: 'strong' });
  assert.notEqual(before.resource.inFlight, null);
  let reads = 0;
  const flakyStore = {
    lookup(key) {
      if (key === 'device:jessica-vacuum' && ++reads % 2 === 0) throw Error('Fixture intermittent native read failure');
      return f.store.lookup(key);
    },
    update: (...args) => f.store.update(...args),
    registerIfAbsent: (...args) => f.store.registerIfAbsent(...args),
  };
  const retry = createJessicaExecutor({ registryConfig: f.registry, policyConfig: policy, store: flakyStore,
    driver: createSocketDriver(f.socketPath), wait: () => Promise.resolve(), pollCounts: { clean: 3 } });
  for (const call of [retry.execute, retry.reconcile]) {
    const result = await call(request, ctx);
    assert.equal(result.status, 'failure');
    assert.equal(result.error.code, 'RESOURCE_STATE_UNAVAILABLE');
    assert.equal(result.error.sideEffects, 'observed');
    assert.equal(result.error.retryMode, 'reconcile');
    assert.deepEqual(result.data.appliedSettings, { suction: 'strong' });
    assert.equal(result.data.outcome, 'unknown');
    assert.equal(result.data.dispatch, 'unknown');
    assert.deepEqual(f.store.lookup('device:jessica-vacuum'), before);
    assert.deepEqual(f.server.state.posts.map(step => step.kind), ['setting']);
  }
});

test('P04 catch recovery preserves a canonical final written between native reads', async (t) => {
  const f = await fixture(t);
  const ctx = context('p04-catch-history-race');
  const canonical = await f.engine.execute(clean, ctx);
  assert.equal(canonical.status, 'success', canonical.error?.code);
  const before = f.store.lookup('device:jessica-vacuum');
  let phase = 'initial-failure';
  const racedStore = {
    lookup(key) {
      if (key.startsWith('request:') && phase === 'initial-failure') {
        phase = 'before-final';
        throw Error('Fixture initial native read failed');
      }
      if (key.startsWith('request:') && phase === 'before-final') return undefined;
      if (key === 'device:jessica-vacuum' && phase === 'before-final') phase = 'finalized';
      return f.store.lookup(key);
    },
    update: (...args) => f.store.update(...args),
    registerIfAbsent: (...args) => f.store.registerIfAbsent(...args),
  };
  const retry = createJessicaExecutor({ registryConfig: f.registry, policyConfig: policy, store: racedStore,
    driver: createSocketDriver(f.socketPath), wait: () => Promise.resolve(), pollCounts: { clean: 3 } });
  for (const call of [retry.execute, retry.reconcile]) {
    phase = 'initial-failure';
    assert.deepEqual(await call(clean, ctx), canonical);
    assert.equal(phase, 'finalized');
    assert.deepEqual(f.store.lookup('device:jessica-vacuum'), before);
    assert.equal(f.server.state.posts.length, 1);
  }
});

test('P04 a sustained native outage retains the last verified setting facts without dispatch or release', async (t) => {
  for (const [method, read] of [['execute', 3], ['execute', 4], ['reconcile', 1]]) await t.test(
    method === 'reconcile' ? 'read-only reconciliation' : read === 3 ? 'before verified facts persist' : 'after verified facts persist', async (t) => {
    const f = await fixture(t, {}, [], mapFixture, 'verified-suction');
    let outage = false, reads = 0;
    const unavailable = () => { if (outage) throw Error('Fixture sustained native outage'); };
    const failingStore = {
      lookup(key) { unavailable(); return f.store.lookup(key); },
      update(...args) { unavailable(); return f.store.update(...args); },
      registerIfAbsent(...args) { unavailable(); return f.store.registerIfAbsent(...args); },
    };
    const driver = createSocketDriver(f.socketPath);
    const engine = createJessicaExecutor({ registryConfig: f.registry, policyConfig: policy, store: failingStore,
      driver: { ...driver, async read() {
        const evidence = await driver.read();
        if (++reads === read) {
          outage = true;
          if (read === 4) throw Error('Fixture HA read failed after verified setting');
        }
        return evidence;
      } }, wait: () => Promise.resolve(), pollCounts: { clean: 3, setting: 2 } });
    const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] },
      settings: { suction: 'strong' } };
    const ctx = context(`p04-sustained-outage-${method}-${read}`);
    if (method === 'reconcile') {
      const interrupted = createJessicaExecutor({ registryConfig: f.registry, policyConfig: policy, store: f.store,
        driver, wait: () => Promise.resolve(), pollCounts: { clean: 3, setting: 2 },
        hooks: { afterAcceptedState() { throw Error('Fixture interrupted setting verification'); } } });
      assert.equal((await interrupted.execute(request, ctx)).error.retryMode, 'reconcile');
      assert.equal(f.engine.state.active().phase, 'verifying');
    }
    const result = await engine[method](request, ctx);
    assert.equal(result.status, 'failure');
    assert.equal(result.error.code, 'RESOURCE_STATE_UNAVAILABLE');
    assert.equal(result.error.sideEffects, 'observed');
    assert.equal(result.error.retryMode, 'reconcile');
    assert.deepEqual(result.data.appliedSettings, { suction: 'strong' });
    assert.equal(result.data.outcome, 'unknown');
    assert.equal(result.data.dispatch, 'unknown');
    assert.deepEqual(f.server.state.posts.map(step => step.kind), ['setting']);
    const durable = f.store.lookup('device:jessica-vacuum');
    assert.equal(durable.resource.owner.operationId, result.data.operationId);
    assert.equal(durable.active.phase, read === 4 ? 'prepared' : 'verifying');
  });
});

test('P04 delayed observations retain their own canonical result after verified release and reassignment', { timeout: 10_000 }, async (t) => {
  for (const method of ['execute', 'reconcile']) await t.test(method, async (t) => {
    const f = await fixture(t);
    const options = { registryConfig: f.registry, policyConfig: policy, store: f.store,
      wait: () => Promise.resolve(), pollCounts: { clean: 1 } };
    const interrupted = createJessicaExecutor({ ...options, driver: createSocketDriver(f.socketPath),
      hooks: { afterAcceptedState() { throw Error('Fixture interrupted verification'); } } });
    const ctx = context(`p04-reassigned-observation-${method}`);
    if (method === 'reconcile') assert.equal((await interrupted.execute(clean, ctx)).error.retryMode, 'reconcile');
    let entered, resume, reads = 0;
    const reading = new Promise(resolve => { entered = resolve; });
    const released = new Promise(resolve => { resume = resolve; });
    t.after(() => resume());
    const driver = createSocketDriver(f.socketPath);
    const delayed = createJessicaExecutor({ ...options, driver: { ...driver, async read() {
      const evidence = await driver.read();
      if (++reads === (method === 'execute' ? 3 : 1)) {
        entered(); await released;
        throw Error('Fixture late observation unavailable');
      }
      return evidence;
    } } });
    const pending = delayed[method](clean, ctx);
    await reading;
    const canonical = await f.engine.reconcile(clean, ctx);
    assert.equal(canonical.status, 'success', canonical.error?.code);
    releaseFixtureResource(f);
    const next = await interrupted.execute(clean, context(`p04-next-owner-${method}`));
    assert.equal(next.error.retryMode, 'reconcile');
    assert.notEqual(next.data.operationId, canonical.data.operationId);
    const before = f.store.lookup('device:jessica-vacuum');
    resume();
    assert.deepEqual(await pending, canonical);
    assert.deepEqual(f.store.lookup('device:jessica-vacuum'), before);
    assert.equal(f.server.state.posts.length, 2);
  });
});

test('P04 a duplicate delayed across completion and release cannot reacquire ownership', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  let entered, resume;
  const reading = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  t.after(() => resume());
  const driver = createSocketDriver(f.socketPath);
  const delayed = createJessicaExecutor({ registryConfig: f.registry, policyConfig: policy, store: f.store,
    wait: () => Promise.resolve(), pollCounts: { clean: 1 }, driver: { ...driver, async read() {
      const evidence = await driver.read();
      entered(); await released;
      return evidence;
    } } });
  const ctx = context('p04-released-duplicate');
  const duplicate = delayed.execute(clean, ctx);
  await reading;
  const canonical = await f.engine.execute(clean, ctx);
  assert.equal(canonical.status, 'success', canonical.error?.code);
  releaseFixtureResource(f);
  const before = f.store.lookup('device:jessica-vacuum');
  resume();
  assert.deepEqual(await duplicate, canonical);
  assert.deepEqual(f.store.lookup('device:jessica-vacuum'), before);
  assert.equal(f.server.state.posts.length, 1);
  const next = await f.engine.execute(clean, context('p04-released-eligible-next'));
  assert.equal(next.status, 'success', next.error?.code);
  assert.equal(f.server.state.posts.length, 2);
});

test('P04 reconciliation before a dispatch acknowledgment preserves live settlement authority', { timeout: 10_000 }, async (t) => {
  for (const kind of ['setting', 'command']) await t.test(kind, async (t) => {
    let posted, resume;
    const applied = new Promise((resolve) => { posted = resolve; });
    const acknowledgment = new Promise((resolve) => { resume = resolve; });
    const f = await fixture(t, {}, [], mapFixture, 'verified-suction', (driver) => ({
      ...driver,
      async dispatch(step) {
        const result = await driver.dispatch(step);
        if (step.kind === kind) { posted(); await acknowledgment; }
        return result;
      },
    }));
    t.after(() => resume());
    const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] },
      settings: { suction: 'strong' } };
    const ctx = context(`p04-reconcile-before-ack-${kind}`);
    const executing = f.engine.execute(request, ctx);
    await applied;
    const before = f.engine.state.active();
    const pin = f.engine.state.resource().inFlight;
    assert.equal(before.phase, 'dispatching');
    const reconciled = await f.engine.reconcile(request, ctx);
    assert.equal(reconciled.status, 'failure');
    assert.equal(reconciled.error.retryMode, 'reconcile');
    assert.deepEqual(f.engine.state.active(), before, 'observations cannot invalidate dispatch settlement');
    assert.deepEqual(f.engine.state.resource().inFlight, pin);
    assert.equal(before.dispatch, 'unknown', 'a prior step acknowledgment cannot authorize this step');
    resume();
    const result = await executing;
    assert.equal(result.status, 'success', result.error?.code);
    assert.equal(result.data.outcome, 'started');
    assert.deepEqual(result.data.appliedSettings, { suction: 'strong' });
    assert.equal(f.engine.state.active(), null);
    assert.equal(f.engine.state.resource().inFlight, null);
    assert.equal(f.engine.state.resource().owner.operationId, result.data.operationId);
    assert.deepEqual(await f.engine.reconcile(request, ctx), result);
    assert.equal(f.server.state.posts.length, 2);
  });
});

test('two processes serialize one device and the second sees conflict', async (t) => {
  const f = await fixture(t, { holdPostMs: 1_500 });
  assert.equal(f.store.registerIfAbsent('fixture:native-initialized', { ready: true }), true);
  const first = worker(f, 'process-one');
  await until(() => f.engine.state.active()?.phase === 'dispatching');
  const second = await worker(f, 'process-two');
  const completed = await first;
  assert.equal(completed.code, 0, completed.error);
  assert.equal(JSON.parse(completed.output).status, 'success');
  assert.equal(second.code, 0, second.error);
  assert.equal(JSON.parse(second.output).code, 'CONFLICT_UNRESOLVED');
  assert.equal(f.server.state.posts.length, 1);
});

test('FC2 multi-room pause claims once and verifies fresh task pause on exact pair', async (t) => {
  const f = await fixture(t, { initialState: 'cleaning', initialSegments: [7, 8], noTaskId: true,
    liveTaskSignals: true }, [], mapFixture, 'multi-pause');
  activeRoom(f);
  const request = { operation: 'pause' };
  const result = await f.engine.execute(request, context('oren-multi-pause'));
  assert.equal(result.status, 'success', result.error?.code);
  assert.equal(result.data.outcome, 'paused');
  assert.deepEqual(result.data.rooms, ['hallway', 'living_room']);
  assert.deepEqual(result.data.observation.activeSegments, [7, 8]);
  assert.equal(result.data.observation.taskStatus.state, 'room_cleaning_paused');
  assert.deepEqual(f.server.state.posts.map((step) => step.segments), [[7, 8]]);
  assert.deepEqual(await f.engine.execute(request, context('oren-multi-pause')), result);
  f.server.state.status.state = 'cleaning';
  activeRoom(f);
  assert.equal((await f.engine.execute(request, context('oren-multi-pause-second'))).error.code,
    'RESOURCE_BUSY');
  assert.equal(f.server.state.posts.length, 1);
});

test('FC2 multi-room pause rejects wrong pair and other requester with zero POST', async (t) => {
  for (const segments of [[8, 11], [8, 7, 11]]) {
    const f = await fixture(t, { initialState: 'cleaning', initialSegments: segments, noTaskId: true,
      liveTaskSignals: true }, [], mapFixture, 'multi-pause');
    activeRoom(f);
    assert.equal((await f.engine.execute({ operation: 'pause' }, context('wrong-multi-scope'))).error.code,
      'CAPABILITY_UNSUPPORTED');
    assert.equal(f.server.state.posts.length, 0);
  }
  const family = await fixture(t, { initialState: 'cleaning', initialSegments: [8, 7], noTaskId: true,
    liveTaskSignals: true }, [], mapFixture, 'multi-pause');
  activeRoom(family);
  assert.equal((await family.engine.execute({ operation: 'pause' }, {
    identity: { ...identity, senderId: 'ilana' }, requestEpoch: 'family-multi-pause',
  })).error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(family.server.state.posts.length, 0);
});

test('FC2 multi-room optimistic pause stays uncertain and is not resent', async (t) => {
  const f = await fixture(t, { initialState: 'cleaning', initialSegments: [8, 7], noTaskId: true,
    liveTaskSignals: true, noTaskStatusTransition: true }, [], mapFixture, 'multi-pause');
  activeRoom(f);
  const request = { operation: 'pause' };
  const first = await f.engine.execute(request, context('multi-pause-uncertain'));
  assert.notEqual(first.status, 'success');
  assert.equal(f.server.state.posts.length, 1);
  assert.equal((await f.engine.execute(request, context('multi-pause-uncertain'))).error.code,
    'OPERATION_PENDING');
  assert.equal(f.server.state.posts.length, 1);
});

test('production exact-pair clean and pause use normal family path without a canary claim', async (t) => {
  const start = await fixture(t, { noTaskId: true, initialSegments: null }, [], mapFixture, 'production-multi');
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['hallway', 'living_room'] } };
  const started = await start.engine.execute(request, { identity: { ...identity, senderId: 'ilana' },
    requestEpoch: 'family-production-pair-start' });
  assert.equal(started.status, 'success', started.error?.code);
  assert.deepEqual(started.data.observation.activeSegments, [7, 8]);
  assert.equal(start.server.state.posts.length, 1);

  const pause = await fixture(t, { initialState: 'cleaning', initialSegments: [8, 7], noTaskId: true,
    liveTaskSignals: true }, [], mapFixture, 'production-multi');
  activeRoom(pause);
  const paused = await pause.engine.execute({ operation: 'pause' }, {
    identity: { ...identity, senderId: 'harel' }, requestEpoch: 'family-production-pair-pause',
  });
  assert.equal(paused.status, 'success', paused.error?.code);
  assert.equal(paused.data.outcome, 'paused');
  assert.deepEqual(paused.data.observation.activeSegments, [8, 7]);
  assert.equal(pause.server.state.posts.length, 1);
});
test('production exact-pair rejects unverified set before dispatch', async (t) => {
  const f = await fixture(t, { noTaskId: true, initialSegments: null }, [], mapFixture, 'production-multi');
  const result = await f.engine.execute({ operation: 'clean', target: { kind: 'rooms',
    rooms: ['living_room', 'guest_bathroom'] } }, { identity: { ...identity, senderId: 'tal' },
    requestEpoch: 'family-wrong-pair' });
  assert.equal(result.error.code, 'CAPABILITY_UNSUPPORTED');
  assert.equal(f.server.state.posts.length, 0);
});

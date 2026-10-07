import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginStateSyncKeyedStore } from '/home/oa/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/plugin-state-store-runtime.js';
import { createOperationState, JESSICA_STATE_OPTIONS } from '../dist/operation-state.js';

const key = 'device:jessica-vacuum';
const intent = (id) => ({ version: '1', requestKey: id, operationId: `op-${id}`,
  requestEpoch: `native-run-${id}`, requesterId: 'oren', requestHash: `hash-${id}`,
  planHash: `plan-${id}`, phase: 'prepared', stepIndex: 0 });
const result = (id) => ({ schemaVersion: '1', domain: 'jessica-vacuum', status: 'success',
  data: { operationId: `op-${id}`, outcome: 'started' } });
// Synthetic domain evidence proves mechanics only, never Jessica FC1 capability.
const verifiedRelease = (owner, evidence) => evidence?.kind === 'fixture-physical-terminal' &&
  evidence.operationId === owner.operationId && evidence.generation === owner.generation;
const evidenceFor = (owner) => ({ kind: 'fixture-physical-terminal',
  operationId: owner.operationId, generation: owner.generation });

function fixture(t, verifyRelease) {
  const root = mkdtempSync(join(tmpdir(), 'benson-p04-resource-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = () => createPluginStateSyncKeyedStore('benson-jessica-tool', {
    ...JESSICA_STATE_OPTIONS, env: { ...process.env, OPENCLAW_STATE_DIR: root },
  });
  return { store, state: () => createOperationState(store(), { verifyRelease }) };
}

test('native atomic ownership is exclusive and operation settlement retains it across restart', (t) => {
  const f = fixture(t, verifiedRelease), a = f.state(), b = f.state();
  const reserved = a.reserve(intent('a'));
  assert.equal(reserved.kind, 'reserved');
  assert.equal(b.reserve(intent('b')).kind, 'conflict');
  assert.equal(b.reserve(intent('a')).kind, 'duplicate');
  for (const field of ['requestEpoch', 'requesterId', 'requestHash', 'planHash']) {
    assert.equal(a.claimMutation({ ...reserved.active, [field]: 'foreign' }, new Date()).changed, false);
  }
  assert.equal(a.claimUnderTest('fixture-canary', 'a', 'op-a', new Date()), true);
  assert.equal(a.finish(a.active(), result('a')).data.outcome, 'started');
  const recovered = f.state();
  assert.equal(recovered.active(), null);
  assert.equal(recovered.resource().owner.operationId, 'op-a');
  assert.equal(recovered.reserve(intent('b')).kind, 'busy');
  assert.equal(recovered.claimUnderTest('fixture-canary', 'b', 'op-b', new Date()), false);
  assert.equal(recovered.history('a').result.data.outcome, 'started');
  const before = f.store().lookup(key);
  recovered.active(); recovered.resource(); recovered.operation('op-a');
  assert.deepEqual(f.store().lookup(key), before, 'read-only access cannot mutate ownership');
});

test('only matching domain evidence releases; reassignment fences stale owners and dispatches', (t) => {
  const f = fixture(t, verifiedRelease), state = f.state();
  const old = state.reserve(intent('a')).active;
  state.finish(state.active(), result('a'));
  const owner = state.resource().owner;
  for (const field of ['requestKey', 'operationId', 'requestEpoch', 'requesterId', 'generation']) {
    const wrong = { ...owner, [field]: field === 'generation' ? owner.generation + 1 : 'foreign' };
    assert.equal(state.releaseResource(wrong, evidenceFor(owner)), false);
  }
  for (const evidence of [null, { verified: true }, { state: 'docked' }, { terminal: true },
    { ...evidenceFor(owner), operationId: 'different-physical-task' }]) {
    assert.equal(state.releaseResource(owner, evidence), false);
  }
  assert.equal(state.releaseResource(owner, evidenceFor(owner)), true);
  assert.equal(state.releaseResource(owner, evidenceFor(owner)), false);
  const next = state.reserve(intent('b')).active;
  assert.equal(next.resourceGeneration, old.resourceGeneration + 1);
  assert.equal(state.claimMutation(old, new Date()).changed, false);
  assert.equal(state.mutationCurrent(old), false);
  assert.equal(state.settleMutation(old, true).changed, false);
  assert.equal(state.releaseResource(owner, evidenceFor(owner)), false);
  assert.equal(state.resource().owner.operationId, 'op-b');
});

test('in-flight marker pins ownership across pauses, crashes, unknown POST outcomes and recovery', (t) => {
  const f = fixture(t, verifiedRelease), state = f.state();
  const reserved = state.reserve(intent('a')).active;
  const claimed = state.claimMutation(reserved, new Date());
  assert.equal(claimed.changed, true);
  assert.equal(state.claimMutation(reserved, new Date()).changed, false);
  assert.equal(state.mutationCurrent(claimed.active), true);
  for (const change of [(value) => ({ ...value, lastObservation: { fixture: 'read' } }),
    (value) => ({ ...value, phase: 'uncertain' })]) {
    assert.equal(state.transition(claimed.active, ['dispatching'], change).changed, false);
    assert.deepEqual(state.active(), claimed.active);
  }
  assert.equal(state.transition(state.active(), ['dispatching'], () => null).changed, false);
  assert.equal(state.transition(state.active(), ['dispatching'], (value) =>
    ({ ...value, phase: 'terminal', result: result('a') })).changed, false);
  assert.equal(state.transition(state.active(), ['dispatching'], (value) =>
    ({ ...value, phase: 'prepared', stepIndex: 1 })).changed, false);
  assert.equal(state.releaseResource(state.resource().owner, evidenceFor(state.resource().owner)), false);
  assert.throws(() => state.finish(state.active(), result('a')), /reconciled/);
  const recovered = f.state();
  assert.equal(recovered.reserve(intent('b')).kind, 'conflict');
  assert.equal(recovered.claimMutation(reserved, new Date()).changed, false);
  assert.equal(state.settleMutation(claimed.active, false).changed, true);
  assert.equal(recovered.resource().uncertain, true);
  assert.notEqual(recovered.resource().inFlight, null);
  assert.equal(recovered.mutationCurrent(claimed.active), false);
  assert.equal(recovered.settleMutation(claimed.active, true).changed, false);
});

test('completed epochs cannot reacquire a released resource or disturb its next owner', (t) => {
  const f = fixture(t, verifiedRelease), state = f.state();
  state.reserve(intent('a'));
  state.finish(state.active(), result('a'));
  const owner = state.resource().owner;
  assert.equal(state.releaseResource(owner, evidenceFor(owner)), true);
  const released = f.store().lookup(key);
  assert.equal(state.reserve(intent('a')).kind, 'completed');
  assert.deepEqual(f.store().lookup(key), released);
  const next = state.reserve(intent('b'));
  assert.equal(next.kind, 'reserved');
  const reassigned = f.store().lookup(key);
  assert.equal(state.reserve(intent('a')).kind, 'completed');
  assert.deepEqual(f.store().lookup(key), reassigned);
  assert.equal(state.resource().generation, owner.generation + 1);
});

test('every setting/command gets a distinct atomic dispatch check; old step tokens fail', (t) => {
  const f = fixture(t, verifiedRelease), state = f.state();
  const first = state.claimMutation(state.reserve(intent('a')).active, new Date()).active;
  assert.equal(state.settleMutation(first, true).changed, true);
  const prepared = state.transition(state.active(), ['verifying'], (value) =>
    ({ ...value, phase: 'prepared', stepIndex: 1 })).active;
  assert.equal(state.claimMutation(first, new Date()).changed, false);
  const next = state.claimMutation(prepared, new Date()).active;
  assert.equal(state.mutationCurrent(first), false);
  assert.equal(state.mutationCurrent(next), true);
  assert.equal(state.settleMutation(first, true).changed, false);
  assert.equal(state.settleMutation(next, true).changed, true);
  state.finish(state.active(), result('a'));
  assert.equal(state.resource().owner.operationId, 'op-a');
});

test('snapshot revisions fence stale transitions and finalization while preserving the canonical final', (t) => {
  const f = fixture(t, verifiedRelease), state = f.state();
  const prepared = state.reserve(intent('a')).active;
  const dispatched = state.claimMutation(prepared, new Date()).active;
  const stale = state.settleMutation(dispatched, true).active;
  const current = state.transition(stale, ['verifying'], (value) =>
    ({ ...value, lastObservation: { fixture: 'newer' } })).active;
  assert.equal(current.revision, stale.revision + 1);
  const before = f.store().lookup(key);
  for (const expected of [stale, { ...current, resourceGeneration: current.resourceGeneration - 1 },
    { ...current, stepIndex: current.stepIndex + 1 }, { ...current, phase: 'uncertain' }]) {
    assert.equal(state.transition(expected, ['verifying'], (value) =>
      ({ ...value, phase: 'prepared', stepIndex: 1 })).changed, false);
    assert.throws(() => state.finish(expected, result('a')), /finalized|ownership/);
    assert.deepEqual(f.store().lookup(key), before);
  }
  const final = state.finish(current, result('a'));
  assert.deepEqual(state.finish(stale, { ...result('a'), status: 'failure' }), final);
  assert.equal(state.active(), null);
  assert.equal(state.resource().owner.operationId, 'op-a');
});

test('unbound, asynchronous or failing release verifiers cannot unlock the resource', (t) => {
  for (const verifyRelease of [undefined, async () => true, () => { throw Error('verifier unavailable'); }]) {
    const f = fixture(t, verifyRelease), state = f.state();
    state.reserve(intent('a'));
    state.finish(state.active(), result('a'));
    const owner = state.resource().owner;
    try { assert.equal(state.releaseResource(owner, evidenceFor(owner)), false); }
    catch (error) { assert.match(error.cause?.message ?? error.message, /verifier unavailable/); }
    assert.deepEqual(state.resource().owner, owner);
  }
});

test('legacy, unknown and malformed resource state fails closed without implicit migration', (t) => {
  for (const value of [{ version: '1', active: null }, { version: 'future', active: null },
    { version: '2', active: null, resource: { generation: 0, owner: null } },
    { version: '2', active: null, resource: { generation: 1, owner: {}, inFlight: null, uncertain: false } }]) {
    const f = fixture(t), store = f.store();
    store.register(key, value);
    assert.throws(() => f.state().reserve(intent('a')), (error) => /invalid/.test(error.cause?.message ?? error.message));
    assert.deepEqual(store.lookup(key), value);
  }
  const f = fixture(t), state = f.state();
  assert.throws(() => state.reserve({ ...intent('a'), requesterId: '' }),
    (error) => /authority/.test(error.cause?.message ?? error.message));
  assert.equal(state.resource().owner, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/domain-state.js';
import { createOperationState, type Active, type OperationOrigin } from '../../../../../agents/jessica-vacuum/lib/operation-state.js';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.js';
async function reserved(f: ReturnType<typeof fixture>): Promise<Active> {
  const value = await f.state.reserve(f.intent); assert.equal(value.kind, 'reserved'); assert.ok(value.active); return value.active;
}
function failed(f: ReturnType<typeof fixture>) { return validateResult({ schemaVersion: '1', domain: 'jessica-vacuum', operation: 'clean', status: 'failure', verified: false,
  data: { operationId: f.intent.operationId, rooms: f.intent.plan.rooms.map(room => room.slug), outcome: 'not_sent', dispatch: 'not_attempted', observation: null, appliedSettings: {} },
  warnings: [], error: { code: 'FIXTURE_NOT_SENT', stage: 'precondition', retryable: false, retryMode: 'none', sideEffects: 'none', message: 'Fixture not sent' }, pendingContext: null }, null, f.clock()); }
test('async contenders reserve one generation; duplicate identity cannot dispatch twice', async () => {
  const f = fixture(); const results = await Promise.all([f.state.reserve(f.intent), f.state.reserve(f.intent), f.state.reserve({ ...f.intent, requestKey: 'other' })]);
  assert.equal(results.filter(value => value.kind === 'reserved').length, 1);
  const active = await f.state.active(); assert.ok(active);
  const claims = await Promise.all([f.state.claimMutation(active, f.clock()), f.state.claimMutation(active, f.clock())]);
  assert.equal(claims.filter(value => value.changed).length, 1);
  assert.equal((await f.state.resource()).generation, 1);
});
test('in-flight fence pins exact revision; unknown POST retains ownership and prohibits another mutation', async () => {
  const f = fixture(), active = await reserved(f), claim = await f.state.claimMutation(active, f.clock()); assert.ok(claim.active);
  assert.equal(await f.state.mutationCurrent(claim.active), true);
  assert.equal((await f.state.transition(claim.active, ['dispatching'], value => ({ ...value, phase: 'uncertain' }))).changed, false);
  const settled = await f.state.settleMutation(claim.active, false); assert.ok(settled.active);
  assert.equal((await f.state.resource()).uncertain, true); assert.ok((await f.state.resource()).inFlight);
  assert.equal((await f.state.claimMutation(settled.active, f.clock())).changed, false);
  await assert.rejects(f.state.finish(settled.active, failed(f)), /reconciliation/);
  const owner = (await f.state.resource()).owner; assert.ok(owner);
  assert.equal(await f.state.releaseResource(owner, {}), false);
});
test('four finalization write boundaries recover on restart without releasing physical ownership', async () => {
  for (let boundary = 1; boundary <= 4; boundary++) {
    const f = fixture(), active = await reserved(f); f.store.failWrite = f.store.writes + boundary;
    await assert.rejects(f.state.finish(active, failed(f)), /outage/);
    f.store.failWrite = 0;
    const restarted = createOperationState(f.store), current = await restarted.active();
    if (current) await restarted.finish(current, failed(f));
    assert.deepEqual((await restarted.history(active.requestKey))?.result, failed(f));
    assert.equal((await restarted.operation(active.operationId))?.kind, 'terminal');
    assert.equal(await restarted.active(), null); assert.ok((await restarted.resource()).owner);
    assert.equal((await restarted.reserve({ ...f.intent, requestKey: 'deliberate-new-request' })).kind, 'busy');
  }
});
test('history created after observation invalidates admission CAS; no mutation retry', async () => {
  const f = fixture(); let entered = false;
  f.store.beforeLookup = async key => {
    if (!entered && key.startsWith('request:')) {
      entered = true; f.store.beforeLookup = undefined;
      const other = createOperationState(f.store); const admission = await other.reserve(f.intent); assert.ok(admission.active);
      await other.finish(admission.active, failed(f));
    }
  };
  assert.equal((await f.state.reserve(f.intent)).kind, 'completed');
  assert.ok(await f.state.history(f.intent.requestKey));
});
test('unknown/corrupt durable versions and conflicting retained history fail closed without writes', async () => {
  for (const raw of [{ version: '1', active: null }, { version: '999' }, { version: '2', active: null, resource: { generation: 1, owner: null, inFlight: null, uncertain: true } }]) {
    const f = fixture(); f.store.data.set('device:jessica-vacuum', raw);
    await assert.rejects(f.state.reserve(f.intent)); assert.equal(f.store.writes, 0); assert.deepEqual(f.store.data.get('device:jessica-vacuum'), raw);
  }
  const f = fixture(), active = await reserved(f); await f.state.finish(active, failed(f));
  await assert.rejects(f.state.finish({ ...active, requestHash: 'conflicting' }, failed(f)), /conflict/);
});
test('release requires exact owner and literal domain predicate, never terminal Run or cached state', async () => {
  const f = fixture(), active = await reserved(f); await f.state.finish(active, failed(f));
  const owner = (await f.state.resource()).owner; assert.ok(owner);
  assert.equal(await f.state.releaseResource(owner, { state: 'docked', run: 'terminal' }), false);
  const fixtureRelease = createOperationState(f.store, { verifyRelease: (_, evidence) => evidence === 'fixture-physical-terminal' });
  assert.equal(await fixtureRelease.releaseResource({ ...owner, generation: owner.generation + 1 }, 'fixture-physical-terminal'), false);
  assert.equal(await fixtureRelease.releaseResource(owner, 'fixture-physical-terminal'), true);
  const next = await fixtureRelease.reserve({ ...f.intent, requestKey: 'next', operationId: 'j4-next' }); assert.equal(next.active?.resourceGeneration, 2);
  assert.equal((await fixtureRelease.claimMutation(active, f.clock())).changed, false);
});
const origin = (): OperationOrigin => ({ binding: { conversationRef: 'conversation-fixture', channel: 'whatsapp', accountId: 'account-fixture',
  kind: 'direct', peerId: 'peer-fixture', threadId: null, requesterId: 'sender-fixture' },
  cutoff: { sessionId: 'session-fixture', generation: 'native-generation-fixture', entryId: 'epoch', effectiveParentId: null } });
test('original operation correlation survives restart, dispatch finalization and authorized resource release', async () => {
  const f = fixture(), input = origin(), admission = await f.state.reserve(f.intent, input); assert.ok(admission.active);
  const binding = await f.state.correlation(f.intent.operationId); assert.ok(binding);
  assert.deepEqual(binding.origin, input); assert.deepEqual(binding.plan, f.intent.plan); assert.equal(binding.owner.generation, 1);
  input.binding.peerId = 'caller-mutation'; assert.deepEqual(await f.state.correlation(f.intent.operationId), binding);
  const restarted = createOperationState(f.store);
  await restarted.finish(admission.active, failed(f));
  assert.equal(await restarted.active(), null); assert.deepEqual(await restarted.correlation(f.intent.operationId), binding);
  assert.equal(await restarted.releaseResource(binding.owner, { state: 'docked', run: 'terminal' }), false);
  const release = createOperationState(f.store, { verifyRelease: () => true }); // Fixture only, never physical evidence.
  assert.equal(await release.releaseResource({ ...binding.owner, generation: 2 }, {}), false);
  assert.equal(await release.releaseResource(binding.owner, {}), true);
  assert.deepEqual(await createOperationState(f.store).correlation(f.intent.operationId), binding);
  await assert.rejects(release.reserve({ ...f.intent, requestKey: 'next', operationId: 'next' }), /origin required/);
  const next = await release.reserve({ ...f.intent, requestKey: 'next', operationId: 'next' }, origin());
  assert.equal(next.active?.resourceGeneration, 2); assert.deepEqual(await release.correlation(f.intent.operationId), binding);
});
test('correlation admission rejects mismatched original input, non-direct route and scope expansion before writes', async () => {
  for (const edit of [
    (value: OperationOrigin) => { assert('cutoff' in value); value.cutoff.entryId = 'foreign'; },
    (value: OperationOrigin) => { value.binding.kind = 'group'; },
    (value: OperationOrigin) => { value.binding.channel = 'other'; },
  ]) {
    const f = fixture(), value = origin(); edit(value);
    await assert.rejects(f.state.reserve(f.intent, value)); assert.equal(f.store.writes, 0);
  }
  for (const plan of [
    { ...fixture().intent.plan, settings: { suction: 'strong' as const } },
    { ...fixture().intent.plan, rooms: [] },
    { ...fixture().intent.plan, requesterSubject: 'foreign' },
    { ...fixture().intent.plan, mapGeneration: null },
  ]) {
    const f = fixture(); await assert.rejects(f.state.reserve({ ...f.intent, plan }, origin())); assert.equal(f.store.writes, 0);
  }
});
test('corrupt correlation, unknown versions and changed active plan fail closed without writes', async () => {
  const mutations = [
    (raw: Record<string, any>) => { raw.version = '999'; },
    (raw: Record<string, any>) => { raw.correlation = null; },
    (raw: Record<string, any>) => { raw.correlation.owner.generation++; },
    (raw: Record<string, any>) => { raw.correlation.origin.cutoff.entryId = 'foreign'; },
    (raw: Record<string, any>) => { raw.active.plan.rooms[0].segmentId++; },
  ];
  for (const mutate of mutations) {
    const f = fixture(), admission = await f.state.reserve(f.intent, origin()); assert.ok(admission.active);
    const raw = structuredClone(f.store.data.get('device:jessica-vacuum')) as Record<string, any>; mutate(raw);
    f.store.data.set('device:jessica-vacuum', raw); const writes = f.store.writes;
    await assert.rejects(f.state.correlation(f.intent.operationId));
    await assert.rejects(f.state.claimMutation(admission.active, f.clock()));
    assert.equal(f.store.writes, writes);
  }
});
test('correlated finalization retains original binding across every write outage; legacy history never acquires an origin', async () => {
  for (let boundary = 1; boundary <= 4; boundary++) {
    const f = fixture(), reserved = await f.state.reserve(f.intent, origin()); assert.ok(reserved.active);
    const binding = await f.state.correlation(f.intent.operationId);
    f.store.failWrite = f.store.writes + boundary; await assert.rejects(f.state.finish(reserved.active, failed(f)), /outage/);
    f.store.failWrite = 0; const restart = createOperationState(f.store), active = await restart.active(); assert.ok(active);
    assert.deepEqual(await restart.correlation(f.intent.operationId), binding);
    await restart.finish(active, failed(f)); assert.deepEqual(await restart.correlation(f.intent.operationId), binding);
  }
  const f = fixture(), active = await reserved(f); await f.state.finish(active, failed(f));
  assert.equal(await f.state.correlation(f.intent.operationId), null);
});

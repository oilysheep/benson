import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/domain-state.js';
import { createOperationState, type Active } from '../../../../../agents/jessica-vacuum/lib/operation-state.js';
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

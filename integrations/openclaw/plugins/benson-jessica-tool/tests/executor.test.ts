import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/domain-state.js';
import { createJessicaExecutor } from '../../../../../agents/jessica-vacuum/lib/executor.js';
import type { JessicaDevice, DeviceStep } from '../../../../../agents/jessica-vacuum/lib/ports.js';
function executorFixture({ ack = true, effect = true, mismatch = false, afterMarker = false, afterPost = false } = {}) {
  const f = fixture(), trace: DeviceStep[] = [];
  const driver: JessicaDevice = { async read() { const result = structuredClone(f.evidence); result.status.observedAt = f.clock().toISOString(); if (result.map) result.map.observedAt = f.clock().toISOString(); return result; },
    async dispatch(step, guard) {
      await guard.assertMutationCurrent(); guard.assertCurrent(); guard.signal.throwIfAborted();
      trace.push(step); f.tick();
      if (effect && step.kind === 'command') {
        const at = f.clock().toISOString(); f.evidence.status = { observedAt: at, sourceUpdatedAt: at, state: 'cleaning', activeSegments: [mismatch ? 999 : f.room.segmentId], currentSegment: null };
        f.evidence.taskStatus = { observedAt: at, sourceUpdatedAt: at, state: 'room_cleaning' };
      }
      return { accepted: ack };
    } };
  const deps = { registryConfig: f.registry, policyConfig: f.policy, store: f.store, driver, clock: f.clock,
    wait: async () => {}, pollCounts: { clean: 1 }, hooks: { afterDispatchMarker() { if (afterMarker) throw new Error('fixture crash'); }, afterPost() { if (afterPost) throw new Error('fixture crash'); } } };
  const executor = createJessicaExecutor(deps), context = { identity: f.identity, requestEpoch: 'native-fixture-epoch', authority: f.authority };
  return { ...f, trace, driver, executor, context, restart: () => createJessicaExecutor(deps) };
}
test('fresh correlated room start preserves identity hashes, result facts and one effect across duplicate/restart', async () => {
  const f = executorFixture(), result = await f.executor.execute(f.request, f.context);
  assert.equal(result.status, 'success'); assert.equal(result.verified, true); assert.equal(f.trace.length, 1);
  assert.ok(result.data && 'operationId' in result.data); assert.match(result.data.operationId, /^j4-[a-f0-9]{32}$/u);
  assert.deepEqual(await f.restart().execute(f.request, f.context), result); assert.equal(f.trace.length, 1);
  const resource = await f.executor.state.resource(); assert.ok(resource.owner); assert.equal(resource.inFlight, null);
  const next = await f.executor.execute(f.request, { ...f.context, requestEpoch: 'deliberate-next' });
  assert.equal(next.error?.code, 'RESOURCE_BUSY'); assert.equal(f.trace.length, 1);
});
test('same epoch with different deliberate input rejects without new effect', async () => {
  const f = executorFixture(); await f.executor.execute(f.request, f.context);
  const result = await f.executor.execute({ operation: 'pause' }, f.context);
  assert.equal(result.error?.code, 'EPOCH_CONFLICT'); assert.equal(f.trace.length, 1);
});
test('reservation races never adopt another epoch with identical request and plan; same-epoch duplicate remains idempotent', async () => {
  for (const sameEpoch of [false, true]) {
    const f = executorFixture(), callerEpoch = 'epoch-B', ownerEpoch = sameEpoch ? callerEpoch : 'epoch-A';
    const deps = { registryConfig: f.registry, policyConfig: f.policy, store: f.store, clock: f.clock, pollCounts: { clean: 1 }, wait: async () => {} };
    const competitor = createJessicaExecutor({ ...deps, driver: f.driver, hooks: { afterIntent() { throw new Error('pause competing invocation before dispatch'); } } });
    let entered = false;
    const caller = createJessicaExecutor({ ...deps, driver: { ...f.driver, async read(authority) {
      if (!entered) {
        entered = true;
        await competitor.execute(f.request, { ...f.context, requestEpoch: ownerEpoch });
        assert.equal((await competitor.state.active())?.requestEpoch, ownerEpoch); assert.equal(f.trace.length, 0);
      }
      return f.driver.read(authority);
    } } });
    const result = await caller.execute(f.request, { ...f.context, requestEpoch: callerEpoch });
    assert.equal((await caller.state.resource()).owner?.requestEpoch, ownerEpoch);
    if (sameEpoch) {
      assert.equal(result.status, 'success'); assert.equal(f.trace.length, 1);
      const replay = await caller.execute(f.request, { ...f.context, requestEpoch: callerEpoch });
      assert.deepEqual(replay, result); assert.equal(f.trace.length, 1);
    } else {
      assert.equal(result.status, 'failure'); assert.equal(result.error?.code, 'CONFLICT_UNRESOLVED'); assert.equal(f.trace.length, 0);
      assert.equal((await caller.state.active())?.requestEpoch, ownerEpoch); assert.equal((await caller.state.active())?.phase, 'prepared');
      assert.equal([...f.store.data.keys()].filter(key => key.startsWith('request:')).length, 0);
    }
  }
});
test('revocation during history/pending state reads redacts results, retains effects and never replays', async () => {
  for (const settled of [true, false]) for (const method of ['execute', 'reconcile'] as const) for (const invalidate of ['retire', 'abort'] as const) {
    const f = executorFixture({ ack: settled });
    await f.executor.execute(f.request, f.context);
    const records = structuredClone(f.store.data), count = f.trace.length;
    f.store.beforeLookup = async key => { if (key.startsWith('request:')) { if (invalidate === 'retire') f.retire(); else f.abort.abort(); } };
    const result = await f.executor[method](f.request, f.context);
    assert.equal(result.status, 'failure'); assert.equal(result.verified, false); assert.equal(result.data, null);
    assert.equal(result.error?.code, 'INVOCATION_NOT_CURRENT'); assert.equal(result.error?.sideEffects, 'possible');
    assert.equal(result.error?.retryMode, 'reconcile'); assert.deepEqual(f.store.data, records); assert.equal(f.trace.length, count);
  }
});
test('revocation during terminal writes cannot disclose success or erase durable effects', async () => {
  const f = executorFixture(), register = f.store.registerIfAbsent.bind(f.store);
  f.store.registerIfAbsent = async (key, value) => { const written = await register(key, value); if (key.startsWith('operation:')) f.retire(); return written; };
  const result = await f.executor.execute(f.request, f.context);
  assert.equal(result.status, 'failure'); assert.equal(result.data, null); assert.equal(result.error?.code, 'INVOCATION_NOT_CURRENT');
  assert.equal(result.error?.sideEffects, 'possible'); assert.equal(result.error?.retryMode, 'reconcile'); assert.equal(f.trace.length, 1);
  assert.ok([...f.store.data.keys()].some(key => key.startsWith('operation:'))); assert.equal((await f.executor.state.active())?.phase, 'terminal');
  assert.ok((await f.executor.state.resource()).owner);
  const recovered = await f.restart().reconcile(f.request, { ...f.context, authority: { signal: new AbortController().signal, assertCurrent() {} } });
  assert.equal(recovered.status, 'success'); assert.equal(f.trace.length, 1); assert.ok([...f.store.data.keys()].some(key => key.startsWith('request:')));
});
test('ACK is not success; timeout/mismatched target/unknown POST remain blocked across read-only reconciliation', async () => {
  for (const options of [{ effect: false }, { mismatch: true }, { ack: false }]) {
    const f = executorFixture(options), result = await f.executor.execute(f.request, f.context);
    assert.equal(result.status, 'failure'); assert.equal(result.verified, false); assert.equal(result.error?.sideEffects, 'possible'); assert.equal(result.error?.retryMode, 'reconcile');
    await f.restart().execute(f.request, f.context); await f.restart().reconcile(f.request, f.context); assert.equal(f.trace.length, 1);
    assert.ok((await f.executor.state.resource()).owner);
  }
});
test('crash at marker or after POST retains barrier and cannot replay an uncertain command', async () => {
  for (const options of [{ afterMarker: true }, { afterPost: true }]) {
    const f = executorFixture(options), result = await f.executor.execute(f.request, f.context);
    assert.equal(result.status, 'failure'); assert.equal(result.error?.sideEffects, 'possible');
    const count = f.trace.length; await f.restart().execute(f.request, f.context); await f.restart().reconcile(f.request, f.context);
    assert.equal(f.trace.length, count); assert.ok((await f.executor.state.resource()).inFlight);
  }
});
test('state capacity/outage prevents dispatch and preserves recovery evidence', async () => {
  const f = executorFixture(); f.store.failWrite = 1;
  const result = await f.executor.execute(f.request, f.context); assert.equal(result.status, 'failure'); assert.equal(f.trace.length, 0);
  assert.equal(f.store.data.size, 0);
});
test('retired or aborted invocation never dispatches; revocation across read await is checked', async () => {
  for (const invalidate of ['retire', 'abort'] as const) {
    const f = executorFixture(); if (invalidate === 'retire') f.retire(); else f.abort.abort();
    assert.equal((await f.executor.execute(f.request, f.context)).status, 'failure'); assert.equal(f.trace.length, 0);
  }
  const f = executorFixture(); let posts = 0;
  const executor = createJessicaExecutor({ registryConfig: f.registry, policyConfig: f.policy, store: f.store, clock: f.clock,
    driver: { async read() { f.retire(); return f.evidence; }, async dispatch() { posts++; return { accepted: true }; } } });
  assert.equal((await executor.execute(f.request, f.context)).status, 'failure'); assert.equal(posts, 0);
});
test('verified suction then room start requires separate read-back and retains applied settings', async () => {
  const f = fixture(); const at = f.clock().toISOString(), trace: DeviceStep[] = [];
  f.evidence.settings = { suction: 'standard' }; f.evidence.deviceSuction = 'standard';
  f.evidence.options = { observedAt: at, suction: ['standard', 'strong'] }; f.evidence.settingSources = { suction: { observedAt: at, sourceUpdatedAt: at } };
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: ['guest_bathroom'] }, settings: { suction: 'strong' } };
  const room = f.registry.rooms.find(item => item.slug === 'guest_bathroom'); assert.ok(room);
  const executor = createJessicaExecutor({ registryConfig: f.registry, policyConfig: f.policy, store: f.store, clock: f.clock, pollCounts: { clean: 1, setting: 1 },
    driver: { async read() { const evidence = structuredClone(f.evidence); evidence.status.observedAt = f.clock().toISOString(); return evidence; },
      async dispatch(step, guard) {
        await guard.assertMutationCurrent(); trace.push(step); f.tick(); const now = f.clock().toISOString();
        if (step.kind === 'setting' && step.name === 'suction') {
          f.evidence.settings = { suction: step.value }; f.evidence.deviceSuction = step.value;
          f.evidence.settingSources = { suction: { observedAt: now, sourceUpdatedAt: now } };
        } else if (step.kind === 'command') {
          f.evidence.status = { observedAt: now, sourceUpdatedAt: now, state: 'cleaning', activeSegments: [room.segmentId], currentSegment: room.segmentId };
          f.evidence.taskStatus = { observedAt: now, sourceUpdatedAt: now, state: 'room_cleaning' };
        }
        return { accepted: true };
      } } });
  const result = await executor.execute(request, { identity: f.identity, requestEpoch: 'suction-fixture', authority: f.authority });
  assert.equal(result.status, 'success'); assert.deepEqual(trace.map(step => step.kind), ['setting', 'command']);
  assert.ok(result.data && 'appliedSettings' in result.data); assert.equal(result.data.appliedSettings.suction, 'strong');
});

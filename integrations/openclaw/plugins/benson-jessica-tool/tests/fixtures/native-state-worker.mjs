// Disposable TS01 native fixture. Missing public factory declarations are not shimmed.
import assert from 'node:assert/strict';
import { createPluginStateKeyedStore, createPluginStateSyncKeyedStore } from 'openclaw/plugin-sdk/plugin-state-store-runtime';
import { createOperationState, JESSICA_STATE_OPTIONS } from '../../dist/operation-state.js';
import { createNativeJessicaState } from '../../../../../../output/typescript/integrations/openclaw/plugins/benson-jessica-tool/src/state.js';
import { createOperationState as createCandidateOperationState } from '../../../../../../output/typescript/agents/jessica-vacuum/lib/operation-state.js';
import { validateResult } from '../../../../../../output/typescript/agents/jessica-vacuum/lib/results.js';
import { fixture as domainFixture } from '../../../../../../output/typescript/integrations/openclaw/plugins/benson-jessica-tool/tests/fixtures/domain-state.js';

assert.ok(process.env.OPENCLAW_STATE_DIR?.startsWith('/tmp/benson-ts01-state-'));
const plugin = 'benson-jessica-tool';
const options = { ...JESSICA_STATE_OPTIONS, env: process.env };
const sync = createPluginStateSyncKeyedStore(plugin, options);
const store = createPluginStateKeyedStore(plugin, options);
let invocationActive = true, pluginActive = true;
const abort = new AbortController();
const authority = { signal: abort.signal, assertCurrent() {
  if (!invocationActive) throw new Error('fixture-invocation-revoked');
} };
const nativeState = { openKeyedStore: opts => createPluginStateKeyedStore(plugin,
  { ...opts, env: process.env }, () => { if (!pluginActive) throw new Error('fixture-plugin-stopped'); }) };
const adapter = createNativeJessicaState(nativeState, authority);
const observations = new Map();
const candidate = () => createCandidateOperationState(adapter);
const candidateIntent = domainFixture().intent;
const candidateResult = validateResult({ schemaVersion: '1', domain: 'jessica-vacuum', operation: 'clean', status: 'failure', verified: false,
  data: { operationId: candidateIntent.operationId, rooms: candidateIntent.plan.rooms.map(room => room.slug), outcome: 'not_sent',
    dispatch: 'not_attempted', observation: null, appliedSettings: {} }, warnings: [], pendingContext: null,
  error: { code: 'FIXTURE_NOT_SENT', stage: 'precondition', retryable: false, retryMode: 'none', sideEffects: 'none', message: 'Fixture not sent' } },
null, new Date('2026-10-17T12:00:00Z'));
for (const method of ['observe', 'compareAndApply', 'registerIfAbsent', 'withCurrent']) {
  assert.equal(typeof store[method], 'function', `missing public state primitive ${method}`);
}
const DEVICE = 'device:jessica-vacuum';
const intent = { version: '1', requestKey: 'fixture-request', operationId: 'fixture-operation',
  requestEpoch: 'fixture-epoch', requesterId: 'fixture-subject', requestHash: 'fixture-request-digest',
  planHash: 'fixture-plan-digest', phase: 'prepared', stepIndex: 0 };
const result = { schemaVersion: '1', domain: 'jessica-vacuum', status: 'success',
  data: { operationId: intent.operationId, outcome: 'started' } };
const state = () => createOperationState(sync, { verifyRelease: (owner, evidence) =>
  evidence?.kind === 'fixture-release' && evidence.generation === owner.generation &&
  evidence.operationId === owner.operationId });

async function execute(command) {
  switch (command.action) {
    case 'adapterLookup': return adapter.lookup(command.key);
    case 'adapterObserve': {
      const observed = await adapter.observe(command.key);
      observations.set(command.id, observed);
      return observed.value;
    }
    case 'adapterCas': {
      const observed = observations.get(command.id);
      if (!observed) throw new Error('fixture-observation-unavailable');
      return adapter.compareAndSet(command.key, observed, command.value);
    }
    case 'adapterClaim': return adapter.registerIfAbsent(command.key, command.value);
    case 'adapterTokenIsolation': {
      const observed = await adapter.observe(DEVICE);
      await assert.rejects(adapter.compareAndSet('request:foreign', observed, {}), /Foreign native state observation/);
      await assert.rejects(adapter.compareAndSet(DEVICE, { ...observed, token: {} }, {}), /Foreign native state observation/);
      const other = createNativeJessicaState(nativeState, authority);
      await assert.rejects(other.compareAndSet(DEVICE, observed, {}), /Foreign native state observation/);
      return { isolated: true };
    }
    case 'adapterRevocation': {
      const observed = await adapter.observe(DEVICE);
      for (const operation of [() => adapter.lookup(DEVICE), () => adapter.observe(DEVICE),
        () => adapter.compareAndSet(DEVICE, observed, { prohibited: true }),
        () => adapter.registerIfAbsent('under-test:revoked', { prohibited: true })]) {
        invocationActive = true;
        const pending = operation();
        invocationActive = false;
        await assert.rejects(pending);
      }
      invocationActive = true;
      assert.equal(await store.lookup(DEVICE), undefined);
      assert.equal(await store.lookup('under-test:revoked'), undefined);
      pluginActive = false;
      await assert.rejects(adapter.lookup(DEVICE));
      await assert.rejects(adapter.registerIfAbsent('under-test:stopped', {}));
      pluginActive = true;
      abort.abort();
      await assert.rejects(adapter.lookup(DEVICE));
      await assert.rejects(adapter.compareAndSet(DEVICE, observed, {}));
      assert.equal(await store.lookup('under-test:stopped'), undefined);
      return { rejected: true };
    }
    case 'adapterAmbiguousCommit': {
      let attempts = 0;
      const ambiguous = createNativeJessicaState({ openKeyedStore(opts) {
        const native = nativeState.openKeyedStore(opts);
        return { ...native, withCurrent(auth) {
          const action = native.withCurrent(auth);
          return { ...action, async compareAndApply(...args) {
            attempts++;
            await action.compareAndApply(...args);
            throw new Error('fixture-response-lost-after-commit');
          } };
        } };
      } }, authority);
      const before = await ambiguous.observe(DEVICE);
      await assert.rejects(ambiguous.compareAndSet(DEVICE, before, { committed: true }), /response-lost-after-commit/);
      assert.equal(attempts, 1);
      return { attempts, retained: await store.lookup(DEVICE) };
    }
    case 'adapterBoundaryNegatives': {
      assert.throws(() => createNativeJessicaState({ openKeyedStore: () => ({ ...store, withCurrent: undefined }) }, authority), /unavailable/);
      assert.throws(() => createNativeJessicaState({ openKeyedStore: () => ({ ...store,
        withCurrent: auth => ({ ...store.withCurrent(auth), compareAndApply: undefined }) }) }, authority), /unavailable/);
      invocationActive = false;
      assert.throws(() => createNativeJessicaState(nativeState, authority), /revoked/);
      invocationActive = true;
      let attempts = 0;
      const revokeAfter = createNativeJessicaState({ openKeyedStore(opts) {
        const native = nativeState.openKeyedStore(opts);
        return { ...native, withCurrent(auth) {
          const action = native.withCurrent(auth);
          return { ...action, async compareAndApply(...args) {
            attempts++;
            const value = await action.compareAndApply(...args);
            invocationActive = false;
            return value;
          } };
        } };
      } }, authority);
      const observed = await revokeAfter.observe(DEVICE);
      await assert.rejects(revokeAfter.compareAndSet(DEVICE, observed, { committedBeforeRevocation: true }), /revoked/);
      invocationActive = true;
      assert.equal(attempts, 1);
      return { attempts, retained: await store.lookup(DEVICE) };
    }
    case 'candidateReserve': return candidate().reserve(candidateIntent);
    case 'candidateClaim': {
      const owner = candidate();
      return owner.claimMutation(await owner.active(), new Date(0));
    }
    case 'candidateSnapshot': {
      const owner = candidate();
      return { active: await owner.active(), resource: await owner.resource(), history: await owner.history(candidateIntent.requestKey),
        duplicate: await owner.reserve(candidateIntent), operation: await owner.operation(candidateIntent.operationId) };
    }
    case 'candidateFinishUntil': {
      const owner = candidate();
      const reservation = await owner.reserve(candidateIntent);
      assert.ok(reservation.active);
      let writes = 0;
      const committed = value => { if (++writes === command.writes) throw new Error('fixture-candidate-crash-boundary'); return value; };
      const interrupted = createCandidateOperationState({ ...adapter,
        async compareAndSet(...args) { return committed(await adapter.compareAndSet(...args)); },
        async registerIfAbsent(...args) { return committed(await adapter.registerIfAbsent(...args)); },
      });
      await assert.rejects(interrupted.finish(reservation.active, candidateResult), /fixture-candidate-crash-boundary/);
      return { writes };
    }
    case 'candidateRecover': {
      const owner = candidate();
      const current = await owner.active();
      const final = (await owner.history(candidateIntent.requestKey))?.result ?? current?.result;
      assert.deepEqual(final, candidateResult);
      if (current) await owner.finish(current, final);
      return { final, active: await owner.active(), resource: await owner.resource(),
        history: await owner.history(candidateIntent.requestKey), duplicate: await owner.reserve(candidateIntent),
        sync: sync.entries(), async: await store.entries() };
    }
    case 'exitUnexpectedly': process.exit(23);
    case 'lookup': return store.lookup(command.key);
    case 'observe': return store.observe(command.key);
    case 'cas': return store.compareAndApply(command.key, command.comparison, command.intent);
    case 'claim': return store.registerIfAbsent(command.key, command.value);
    case 'entries': return { sync: sync.entries(), async: await store.entries() };
    case 'seedAsync':
      for (const { key, value } of command.entries) await store.register(key, value);
      return { sync: sync.entries(), async: await store.entries() };
    case 'seed': {
      const owner = state();
      assert.equal(owner.reserve(intent).kind, 'reserved');
      assert.equal(owner.claimUnderTest('fixture-capability', intent.requestKey, intent.operationId, new Date(0)), true);
      owner.finish(owner.active(), result);
      return { sync: sync.entries(), async: await store.entries() };
    }
    case 'reserve': return state().reserve(intent);
    case 'claimMutation': {
      const owner = state();
      return owner.claimMutation(owner.active(), new Date(0));
    }
    case 'finishRelease': {
      const owner = state();
      owner.finish(owner.active(), result);
      const retained = owner.resource().owner;
      assert.equal(owner.releaseResource(retained, { kind: 'fixture-release',
        operationId: retained.operationId, generation: retained.generation }), true);
      return store.lookup(DEVICE);
    }
    case 'snapshot': {
      const owner = state();
      return { active: owner.active(), resource: owner.resource(), history: owner.history(intent.requestKey),
        duplicate: owner.reserve(intent), operation: owner.operation(intent.operationId) };
    }
    case 'finishUntil': {
      const owner = state();
      owner.reserve(intent);
      let writes = 0;
      const committed = (value) => {
        writes += 1;
        if (writes === command.writes) throw new Error('fixture-crash-boundary');
        return value;
      };
      const interrupted = createOperationState({
        lookup: (...args) => sync.lookup(...args),
        update: (...args) => committed(sync.update(...args)),
        registerIfAbsent: (...args) => committed(sync.registerIfAbsent(...args)),
      });
      assert.throws(() => interrupted.finish(interrupted.active(), result), /fixture-crash-boundary/);
      return { writes };
    }
    case 'recoverFinish': {
      const owner = state();
      const final = owner.history(intent.requestKey)?.result ?? owner.active()?.result;
      assert.deepEqual(final, result);
      if (owner.active()) owner.finish(owner.active(), result);
      return { final, snapshot: { active: owner.active(), resource: owner.resource(),
        history: owner.history(intent.requestKey), duplicate: owner.reserve(intent) } };
    }
    case 'revocation': {
      await store.observe(DEVICE);
      let live = true;
      let refused = 0;
      const bound = store.withCurrent({ assertCurrent: () => {
        if (!live) { refused += 1; throw new Error('fixture-revoked'); }
      } });
      async function revoked(pending, before = refused) {
        await assert.rejects(typeof pending === 'function' ? pending : () => pending);
        assert.ok(refused > before, 'the native rejection must invoke the revoked authority guard');
      }
      assert.equal('update' in bound, false);
      assert.equal('deleteIf' in bound, false);
      const beforeWrite = refused;
      const pending = bound.register('fixture-revoked-write', { value: 1 });
      live = false;
      await revoked(pending, beforeWrite);
      await revoked(() => bound.registerIfAbsent('fixture-revoked-claim', { value: 1 }));
      await revoked(() => bound.lookup(DEVICE));
      assert.equal(await store.lookup('fixture-revoked-write'), undefined);
      assert.equal(await store.lookup('fixture-revoked-claim'), undefined);
      live = true;
      const observation = await store.observe('fixture-revoked-cas');
      const beforeCas = refused;
      const cas = bound.compareAndApply('fixture-revoked-cas', observation.comparison,
        { operation: 'update', action: 'set', value: { value: 1 } });
      live = false;
      await revoked(cas, beforeCas);
      assert.equal(await store.lookup('fixture-revoked-cas'), undefined);
      live = true;
      const beforeRead = refused;
      const read = bound.lookup(DEVICE);
      live = false;
      await revoked(read, beforeRead);
      return { refused: true };
    }
    case 'capacity': {
      const bounded = createPluginStateKeyedStore(plugin, { ...options, namespace: 'fixture-capacity', maxEntries: 1 });
      await bounded.register('first', { value: 1 });
      await assert.rejects(bounded.register('second', { value: 2 }));
      assert.deepEqual(await bounded.lookup('first'), { value: 1 });
      assert.equal(await bounded.lookup('second'), undefined);
      return true;
    }
    default: throw new Error('Unknown fixture command');
  }
}
process.on('message', async (command) => {
  try { process.send({ ok: true, value: await execute(command) }); }
  catch (error) {
    const causes = [];
    for (let current = error; current instanceof Error && causes.length < 6; current = current.cause) {
      causes.push({ name: current.name, message: current.message, code: current.code });
    }
    process.send({ ok: false, error: JSON.stringify(causes) });
  }
});
process.send({ ready: true });

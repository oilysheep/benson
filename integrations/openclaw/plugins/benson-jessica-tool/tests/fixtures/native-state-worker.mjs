// Disposable TS01 native fixture. Missing public factory declarations are not shimmed.
import assert from 'node:assert/strict';
import { createPluginStateKeyedStore, createPluginStateSyncKeyedStore } from 'openclaw/plugin-sdk/plugin-state-store-runtime';
import { createOperationState, JESSICA_STATE_OPTIONS } from '../../dist/operation-state.js';

assert.ok(process.env.OPENCLAW_STATE_DIR?.startsWith('/tmp/benson-ts01-state-'));
const plugin = 'benson-jessica-tool';
const options = { ...JESSICA_STATE_OPTIONS, env: process.env };
const sync = createPluginStateSyncKeyedStore(plugin, options);
const store = createPluginStateKeyedStore(plugin, options);
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

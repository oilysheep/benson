import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const DEVICE = 'device:jessica-vacuum';
function fixture(t) {
  const root = mkdtempSync('/tmp/benson-ts01-state-');
  const children = new Set();
  async function cleanup() {
    const results = await Promise.allSettled([...children].map(worker => worker.stop()));
    rmSync(root, { recursive: true, force: true });
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Fixture worker cleanup failed');
  }
  t.after(cleanup);
  async function open() {
    const child = fork(new URL('./fixtures/native-state-worker.mjs', import.meta.url), [], {
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1',
        OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: join(root, 'absent.json') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced',
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = once(child, 'exit');
    async function receive() {
      const controller = new AbortController();
      try {
        return await Promise.race([
          once(child, 'message', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) }),
          exited.then(([code, signal]) => { throw new Error(`Fixture worker exited: code=${code}, signal=${signal}`); }),
        ]);
      } finally { controller.abort(); }
    }
    let closed = false;
    const worker = {
      async call(command) {
        assert.equal(child.connected, true, 'Fixture worker disconnected');
        const response = receive();
        child.send(command);
        const [message] = await response;
        assert.equal(message.ok, true, message.error);
        return message.value;
      },
      async stop(crash = false) {
        if (closed) return;
        closed = true;
        const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
        deadline.unref();
        try {
          if (child.exitCode === null && child.signalCode === null) {
            if (crash) child.kill('SIGKILL'); else if (child.connected) child.disconnect();
          }
          const [code, signal] = await exited;
          assert.equal(crash ? signal : code, crash ? 'SIGKILL' : 0, stderr);
        } finally { clearTimeout(deadline); children.delete(worker); }
      },
    };
    children.add(worker);
    const ready = receive();
    const [message] = await ready;
    assert.equal(message.ready, true, stderr);
    return worker;
  }
  return { open, cleanup, root };
}

test('unexpected worker exit still stops remaining workers and removes the disposable root', async t => {
  const f = fixture(t), a = await f.open(), b = await f.open();
  await b.call({ action: 'observe', key: DEVICE });
  await assert.rejects(a.call({ action: 'exitUnexpectedly' }), /Fixture worker exited: code=23/);
  await assert.rejects(f.cleanup(), error => error instanceof AggregateError && error.errors.length === 1);
  assert.equal(existsSync(f.root), false);
});

test('native sync/async share all four canonical key families and lossless record data', async t => {
  const f = fixture(t), a = await f.open();
  const seeded = await a.call({ action: 'seed' });
  assert.deepEqual(seeded.async, seeded.sync);
  assert.deepEqual(seeded.sync.map(x => x.key.split(':')[0]).sort(), ['device', 'operation', 'request', 'under-test']);
  await a.stop();
  const b = await f.open();
  assert.deepEqual(await b.call({ action: 'entries' }), seeded);
  const reverse = fixture(t), c = await reverse.open();
  const copied = await c.call({ action: 'seedAsync', entries: seeded.sync });
  assert.deepEqual(copied.sync, copied.async);
  assert.deepEqual(copied.sync.map(({ key, value }) => ({ key, value })), seeded.sync.map(({ key, value }) => ({ key, value })));
});

test('two-process native CAS and registerIfAbsent admit exactly one winner', async t => {
  const f = fixture(t), a = await f.open(), b = await f.open();
  // Bootstrap the disposable database before racing record operations, not migrations.
  await a.call({ action: 'observe', key: DEVICE });
  // Both observations complete before either CAS is admitted: IPC is the barrier.
  const snapshots = await Promise.all([a, b].map(w => w.call({ action: 'observe', key: DEVICE })));
  assert.equal(snapshots[0].comparison, snapshots[1].comparison);
  const winners = await Promise.all([a, b].map((w, i) => w.call({ action: 'cas', key: DEVICE,
    comparison: snapshots[i].comparison, intent: { operation: 'update', action: 'set', value: { version: 'fixture', revision: 1, winner: i } } })));
  assert.deepEqual(winners.map(x => x.status).sort(), ['applied', 'conflict']);
  assert.deepEqual(await a.call({ action: 'lookup', key: DEVICE }), await b.call({ action: 'lookup', key: DEVICE }));
  const claims = await Promise.all([a, b].map((w, i) => w.call({ action: 'claim', key: 'under-test:fixture', value: { winner: i } })));
  assert.deepEqual(claims.sort(), [false, true]);
});

test('stale observation survives process exit but conflicts after a native revision change', async t => {
  const f = fixture(t), a = await f.open();
  const stale = await a.call({ action: 'observe', key: DEVICE });
  await a.stop();
  const b = await f.open();
  const current = await b.call({ action: 'observe', key: DEVICE });
  assert.equal((await b.call({ action: 'cas', key: DEVICE, comparison: current.comparison,
    intent: { operation: 'update', action: 'set', value: { revision: 2, generation: 2 } } })).status, 'applied');
  await b.stop();
  const c = await f.open();
  assert.equal((await c.call({ action: 'cas', key: DEVICE, comparison: stale.comparison,
    intent: { operation: 'update', action: 'set', value: { revision: 1, generation: 1 } } })).status, 'conflict');
  assert.deepEqual(await c.call({ action: 'lookup', key: DEVICE }), { revision: 2, generation: 2 });
});

test('action-bound native state refuses revoked writes, claims and awaited reads', async t => {
  const f = fixture(t), worker = await f.open();
  assert.deepEqual(await worker.call({ action: 'revocation' }), { refused: true });
  assert.equal(await worker.call({ action: 'capacity' }), true);
});

test('observe-device before history read fences concurrent finish/release and duplicate admission', async t => {
  const f = fixture(t), a = await f.open(), b = await f.open();
  await a.call({ action: 'reserve' });
  const before = await b.call({ action: 'observe', key: DEVICE });
  assert.equal(await b.call({ action: 'lookup', key: 'request:fixture-request' }), undefined);
  const released = await a.call({ action: 'finishRelease' });
  assert.equal((await b.call({ action: 'cas', key: DEVICE, comparison: before.comparison,
    intent: { operation: 'update', action: 'set', value: before.value } })).status, 'conflict');
  assert.deepEqual(await b.call({ action: 'lookup', key: DEVICE }), released);
  assert.equal((await b.call({ action: 'reserve' })).kind, 'completed');
});

test('process loss after dispatch claim retains the resource and uncertainty barrier', async t => {
  const f = fixture(t), a = await f.open();
  await a.call({ action: 'reserve' });
  assert.equal((await a.call({ action: 'claimMutation' })).changed, true);
  await a.stop(true);
  const b = await f.open(), snapshot = await b.call({ action: 'snapshot' });
  assert.equal(snapshot.active.phase, 'dispatching');
  assert.notEqual(snapshot.resource.inFlight, null);
  assert.notEqual(snapshot.resource.owner, null);
  assert.equal(snapshot.duplicate.kind, 'duplicate');
  assert.equal((await b.call({ action: 'claimMutation' })).changed, false);
});

for (const writes of [1, 2, 3, 4]) {
  test(`restart after finalization write ${writes} preserves canonical outcome and retained ownership`, async t => {
    const f = fixture(t), a = await f.open();
    assert.deepEqual(await a.call({ action: 'finishUntil', writes }), { writes });
    await a.stop(true);
    const b = await f.open(), recovered = await b.call({ action: 'recoverFinish' });
    assert.equal(recovered.final.data.outcome, 'started');
    assert.equal(recovered.snapshot.active, null);
    assert.notEqual(recovered.snapshot.resource.owner, null);
    assert.equal(recovered.snapshot.duplicate.kind, 'completed');
    assert.deepEqual(recovered.snapshot.history.result, recovered.final);
  });
}

test('TS03 adapter preserves the legacy native namespace and all four key families', async t => {
  const f = fixture(t), a = await f.open();
  const seeded = await a.call({ action: 'seed' });
  for (const { key, value } of seeded.sync) assert.deepEqual(await a.call({ action: 'adapterLookup', key }), value);
  await a.stop();
  const b = await f.open();
  for (const { key, value } of seeded.sync) assert.deepEqual(await b.call({ action: 'adapterLookup', key }), value);
});

test('TS03 actual adapter CAS and atomic claims admit one of two processes', async t => {
  const f = fixture(t), a = await f.open(), b = await f.open();
  // Native bootstrap remains host-owned; this races records, not cold migrations.
  await a.call({ action: 'observe', key: DEVICE });
  await Promise.all([a, b].map(worker => worker.call({ action: 'adapterObserve', id: 'race', key: DEVICE })));
  const writes = await Promise.all([a, b].map((worker, winner) => worker.call({ action: 'adapterCas', id: 'race', key: DEVICE, value: { winner } })));
  assert.deepEqual(writes.sort(), ['applied', 'conflict']);
  const claims = await Promise.all([a, b].map((worker, winner) => worker.call({ action: 'adapterClaim', key: 'under-test:race', value: { winner } })));
  assert.deepEqual(claims.sort(), [false, true]);
  assert.deepEqual(await a.call({ action: 'adapterLookup', key: DEVICE }), await b.call({ action: 'adapterLookup', key: DEVICE }));
});

test('TS03 observations reject foreign keys, stores, forged tokens and stale native revisions', async t => {
  const f = fixture(t), a = await f.open();
  assert.deepEqual(await a.call({ action: 'adapterTokenIsolation' }), { isolated: true });
  await a.call({ action: 'adapterObserve', id: 'stale', key: DEVICE });
  const current = await a.call({ action: 'observe', key: DEVICE });
  await a.call({ action: 'cas', key: DEVICE, comparison: current.comparison,
    intent: { operation: 'update', action: 'set', value: { revision: 2 } } });
  assert.equal(await a.call({ action: 'adapterCas', id: 'stale', key: DEVICE, value: { revision: 1 } }), 'conflict');
  assert.deepEqual(await a.call({ action: 'adapterLookup', key: DEVICE }), { revision: 2 });
  await a.stop();
  const restarted = await f.open();
  await assert.rejects(restarted.call({ action: 'adapterCas', id: 'stale', key: DEVICE, value: {} }), /observation-unavailable/);
  assert.deepEqual(await restarted.call({ action: 'adapterLookup', key: DEVICE }), { revision: 2 });
});

test('TS03 native action view fences revoked invocations, cancellation and plugin lifetime', async t => {
  const f = fixture(t), worker = await f.open();
  assert.deepEqual(await worker.call({ action: 'adapterRevocation' }), { rejected: true });
});

test('TS03 ambiguous commit is retained and propagated without automatic retry', async t => {
  const f = fixture(t), worker = await f.open();
  assert.deepEqual(await worker.call({ action: 'adapterAmbiguousCommit' }), { attempts: 1, retained: { committed: true } });
});

test('TS03 missing native capabilities fail closed; post-commit revocation does not erase a committed write', async t => {
  const f = fixture(t), worker = await f.open();
  assert.deepEqual(await worker.call({ action: 'adapterBoundaryNegatives' }), { attempts: 1, retained: { committedBeforeRevocation: true } });
});

test('TS03 migrated operation owner retains the physical/uncertain dispatch barrier across process loss', async t => {
  const f = fixture(t), a = await f.open();
  assert.equal((await a.call({ action: 'candidateReserve' })).kind, 'reserved');
  assert.equal((await a.call({ action: 'candidateClaim' })).changed, true);
  await a.stop(true);
  const b = await f.open(), snapshot = await b.call({ action: 'candidateSnapshot' });
  assert.equal(snapshot.active.phase, 'dispatching');
  assert.ok(snapshot.resource.owner);
  assert.ok(snapshot.resource.inFlight);
  assert.equal(snapshot.duplicate.kind, 'duplicate');
  assert.equal((await b.call({ action: 'candidateClaim' })).changed, false);
});

for (const writes of [1, 2, 3, 4]) {
  test(`TS03 migrated finalization recovers after native write ${writes} and preserves retained owner`, async t => {
    const f = fixture(t), a = await f.open();
    assert.deepEqual(await a.call({ action: 'candidateFinishUntil', writes }), { writes });
    await a.stop(true);
    const b = await f.open(), recovered = await b.call({ action: 'candidateRecover' });
    assert.equal(recovered.final.data.outcome, 'not_sent');
    assert.equal(recovered.active, null);
    assert.ok(recovered.resource.owner);
    assert.equal(recovered.duplicate.kind, 'completed');
    assert.deepEqual(recovered.history.result, recovered.final);
    assert.deepEqual(recovered.sync, recovered.async);
  });
}

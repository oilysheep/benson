import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readVacuumState, readJessicaSensors } from '../../../../../agents/jessica-vacuum/lib/ha-read.mjs';
import { createJessicaReadToolFactory, createJessicaTaskToolFactory } from '../dist/tool.js';

// Supplied host-context fixtures establish source behavior only, never native
// requester custody, loaded isolation, runtime acceptance or zero model usage.
const observedAt = '2026-10-10T10:00:00.000Z';
const clock = () => new Date(observedAt);
const roster = { accountId: 'fixture', approvedIds: ['reader'],
  byRoute: new Map([['fixture-reader-route', 'reader']]) };
const policyConfig = { version: '1', defaultDecision: 'deny', rules: [
  { subject: 'reader', actionClass: 'read', deviceScope: 'jessica-vacuum', decision: 'allow' },
  { subject: 'reader', actionClass: 'control', deviceScope: 'jessica-vacuum', decision: 'allow' },
] };
function fixture(overrides = {}) {
  const state = { live: true, stateReads: 0, sensorReads: 0 };
  const context = { agentId: 'main', requesterSenderId: 'fixture-reader-route',
    deliveryContext: { channel: 'whatsapp', accountId: 'fixture', to: 'fixture-reader-route' },
    assertInvocationCurrent() { assert.ok(state.live, 'native invocation closed'); } };
  const options = { jsonResult: value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }), roster, policyConfig, clock,
    readState: async () => {
      state.stateReads++;
      return { observedAt, state: { state: 'docked', last_updated: observedAt,
        attributes: { battery: 91, current_segment: 8, active_segments: null } } };
    }, readSensors: async () => { state.sensorReads++; return new Map(); }, ...overrides };
  const factory = createJessicaTaskToolFactory(options);
  return { state, context, options, factory, tool: factory(context) };
}

test('Main status task reuses the validated domain read and returns a same-call no-Run result', async () => {
  const f = fixture();
  const native = await f.tool.execute('native-call-1', { operation: 'status' });
  const result = native.details;
  const read = createJessicaReadToolFactory(f.options)({ ...f.context, agentId: 'jessica-vacuum' });
  const legacy = (await read.execute('legacy-call', { operation: 'status' })).details;
  assert.match(native.content[1].text, /91%/);
  assert.match(native.content[1].text, /Home Assistant/);
  assert.equal(native.content[1].text.includes(observedAt), false);
  assert.equal(result.evidence.observedAt, observedAt);
  assert.deepEqual(JSON.parse(JSON.stringify(result.evidence.facts)), legacy);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.disposition, 'handled');
  assert.equal(result.admission.callId, 'native-call-1');
  assert.equal(result.admission.subject, 'reader');
  assert.deepEqual(JSON.parse(JSON.stringify(result.effects)), { status: 'none', refs: [] });
  assert.equal(result.notification, null);
  assert.equal(result.runId, undefined);
  assert.equal(result.evidence.facts.data.sourceKind, 'ha_cached_entity');
  assert.equal(f.state.stateReads, 2);
  assert.equal(f.state.sensorReads, 2);
});

test('native task entry is available to Main only; internal read remains domain-only', () => {
  const f = fixture();
  for (const agentId of ['jessica-vacuum', 'reminder', undefined]) {
    assert.equal(f.factory({ ...f.context, agentId }), null);
  }
  assert.equal(f.factory({ ...f.context, assertInvocationCurrent: undefined }), null);
  assert.equal(createJessicaReadToolFactory(f.options)(f.context), null);
  assert.equal(f.state.stateReads, 0);
});

test('missing, foreign and inconsistent requester context denies before HA reads', async () => {
  for (const change of [{ deliveryContext: undefined }, { requesterSenderId: 'foreign' },
    { deliveryContext: { channel: 'whatsapp', accountId: 'fixture', to: 'foreign' } },
    { deliveryContext: { channel: 'whatsapp', accountId: 'other', to: 'fixture-reader-route' } },
    { requesterSenderId: undefined,
      deliveryContext: { channel: 'whatsapp', accountId: 'fixture', to: 'group@g.us' } }]) {
    const f = fixture();
    await assert.rejects(f.factory({ ...f.context, ...change }).execute('native-call', { operation: 'status' }),
      (error) => error.code === 'IDENTITY_UNTRUSTED');
    assert.equal(f.state.stateReads, 0);
    assert.equal(f.state.sensorReads, 0);
  }
});

test('trusted group sender succeeds without turning Main intent into authority', async () => {
  const f = fixture();
  const result = (await f.factory({ ...f.context,
    deliveryContext: { ...f.context.deliveryContext, to: 'group@g.us' } }).execute('group-call', { operation: 'status' })).details;
  assert.equal(result.admission.subject, 'reader');
});

test('closed task intent rejects mutations, unsupported reads and forged authority', async () => {
  for (const request of [{ operation: 'clean', target: { kind: 'home' } }, { operation: 'pause' },
    { operation: 'rooms' }, { operation: 'capabilities' }, { operation: 'unknown' },
    { operation: 'status', agentId: 'jessica-vacuum' }, { operation: 'status', requesterSenderId: 'reader' },
    { operation: 'status', grant: 'owner' }, { operation: 'status', readOnly: true }]) {
    const f = fixture();
    await assert.rejects(f.tool.execute('native-call', request));
    assert.equal(f.state.stateReads, 0);
    assert.equal(f.state.sensorReads, 0);
  }
  const f = fixture();
  await assert.rejects(f.tool.execute('', { operation: 'status' }), /context_invalid/);
  assert.equal(f.state.stateReads, 0);
});

test('revocation before read, between reads and before release prevents disclosure', async () => {
  const before = fixture(); before.state.live = false;
  await assert.rejects(before.tool.execute('call', { operation: 'status' }), /invocation closed/);
  assert.equal(before.state.stateReads, 0);
  for (const phase of ['state', 'sensors']) {
    const f = fixture();
    const original = f.options[phase === 'state' ? 'readState' : 'readSensors'];
    f.options[phase === 'state' ? 'readState' : 'readSensors'] = async () => {
      const result = await original();
      f.state.live = false;
      return result;
    };
    await assert.rejects(createJessicaTaskToolFactory(f.options)(f.context)
      .execute('call', { operation: 'status' }), /invocation closed/);
    assert.equal(f.state.sensorReads, phase === 'state' ? 0 : 1);
  }
});

test('aborted or asynchronously asserted invocation cannot execute reads', async () => {
  const f = fixture();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.tool.execute('call', { operation: 'status' }, abort.signal));
  assert.equal(f.state.stateReads, 0);
  await assert.rejects(f.factory({ ...f.context, assertInvocationCurrent: async () => {} })
    .execute('call', { operation: 'status' }), /synchronous/);
  assert.equal(f.state.stateReads, 0);
});

test('revocation during HA credential preparation prevents the final HTTP read request', async () => {
  const originalReadFile = fs.promises.readFile;
  try {
    for (const revokedRead of [1, 2]) {
      const f = fixture();
      let preparations = 0;
      let requests = 0;
      let requestsAfterRevocation = 0;
      fs.promises.readFile = async () => {
        if (++preparations === revokedRead) f.state.live = false;
        return 'fixture-only-credential';
      };
      syncBuiltinESMExports();
      const fetchImpl = async url => {
        requests++;
        if (!f.state.live) requestsAfterRevocation++;
        return { ok: true, json: async () => url.endsWith('/api/states') ? [] : {
          entity_id: decodeURIComponent(url.split('/').at(-1)),
          state: 'docked', attributes: { battery: 80 },
        } };
      };
      const tool = createJessicaTaskToolFactory({ ...f.options,
        readState: (_fetch, assertCurrent) => readVacuumState(fetchImpl, assertCurrent),
        readSensors: (_fetch, assertCurrent) => readJessicaSensors(fetchImpl, assertCurrent),
      })(f.context);
      await assert.rejects(tool.execute('call', { operation: 'status' }), /invocation closed/);
      assert.equal(preparations, revokedRead);
      assert.equal(requestsAfterRevocation, 0);
      assert.equal(requests, revokedRead - 1);
    }
  } finally {
    fs.promises.readFile = originalReadFile;
    syncBuiltinESMExports();
  }
});

test('backend unavailable or malformed evidence returns a validated failure, never success', async () => {
  for (const readState of [async () => { throw new Error('backend unavailable'); },
    async () => ({ observedAt, state: { state: 'docked', attributes: { battery: 999 } } })]) {
    const f = fixture({ readState });
    const native = await f.tool.execute('call', { operation: 'status' });
    const result = native.details;
    assert.match(native.content[1].text, /לא ניתן לאמת/);
    assert.equal(result.disposition, 'failed');
    assert.equal(result.evidence.facts.verified, false);
    assert.equal(result.evidence.facts.error.sideEffects, 'none');
    assert.equal(result.error.code, result.evidence.facts.error.code);
    assert.equal(result.notification, null);
  }
});

test('repeat status is a fresh read rather than an input replay claim or cached response', async () => {
  const f = fixture();
  await f.tool.execute('call', { operation: 'status' });
  await f.tool.execute('call', { operation: 'status' });
  assert.equal(f.state.stateReads, 2);
  assert.equal(f.state.sensorReads, 2);
});

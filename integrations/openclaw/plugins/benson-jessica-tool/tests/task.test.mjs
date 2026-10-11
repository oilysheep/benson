import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { readVacuumState, readJessicaSensors } from '../../../../../agents/jessica-vacuum/lib/ha-read.mjs';
import { createJessicaReadToolFactory, createJessicaTaskToolFactory } from '../dist/tool.js';
import { DOMAIN_RESULT_OUTPUT_SCHEMA } from '../../../benson-routing/envelope.mjs';

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

test('observed Code Mode status call receives the validated outcome and prepared source/time wording', async () => {
  const f = fixture();
  const catalog = { async search() { return [async function jessica_task(request) {
    return (await f.tool.execute('native-catalog-call', request)).details;
  }]; } };
  // Exact production guest-code shape. Native catalog handles return details,
  // not the separate content blocks; this fixture does not prove live custody.
  const run = new (Object.getPrototypeOf(async function () {}).constructor)('catalog',
    'const hits = await catalog.search("jessica_task operation status"); const tool = hits.find(x => x.name === "jessica_task"); if (!tool) return {available:false, error:"JESSICA_TASK_UNAVAILABLE"}; return {available:true, result: await tool({operation:"status"})};');
  const value = await run(catalog);
  assert.equal(f.tool.outputSchema, DOMAIN_RESULT_OUTPUT_SCHEMA);
  assert.equal(value.available, true);
  assert.equal(value.result.kind, 'benson.domain-result');
  assert.equal(value.result.executionMode, 'deterministic');
  assert.equal(value.result.facts.verified, true);
  assert.match(value.result.content.text, /Home Assistant/);
  assert.match(value.result.content.text, /13:00/);
  assert.equal(f.state.stateReads, 1);
  assert.equal(f.state.sensorReads, 1);
});

test('Main status task reuses the validated domain read and returns one complete Domain Result', async () => {
  const f = fixture();
  const native = await f.tool.execute('native-call-1', { operation: 'status' });
  const result = native.details;
  assert.equal(native.details.executionMode, 'deterministic');
  assert.equal(JSON.parse(native.content[0].text).content.text, native.details.content.text);
  assert.deepEqual(JSON.parse(native.content[0].text), JSON.parse(JSON.stringify(native.details)));
  const read = createJessicaReadToolFactory(f.options)({ ...f.context, agentId: 'jessica-vacuum' });
  const legacy = (await read.execute('legacy-call', { operation: 'status' })).details;
  assert.match(native.details.content.text, /91%/);
  assert.match(native.details.content.text, /Home Assistant/);
  assert.equal(native.details.content.text.includes(observedAt), false);
  assert.equal(result.evidence.observations[0].observedAt, observedAt);
  assert.deepEqual(JSON.parse(JSON.stringify(result.facts.data)), legacy.data);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.outcome.disposition, 'handled');
  assert.equal(result.admission, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.effects)), { status: 'none', refs: [], details: [], reconciliation: { required: false, reason: null } });
  assert.equal(result.notification, undefined);
  assert.equal(result.runId, undefined);
  assert.equal(result.facts.data.sourceKind, 'ha_cached_entity');
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
  assert.equal(result.executionMode, 'deterministic');
  assert.equal(f.state.stateReads, 1);
});

test('closed task intent rejects mutations, unsupported reads and forged authority', async () => {
  for (const request of [{ operation: 'clean', target: { kind: 'home' } }, { operation: 'pause' },
    { operation: 'rooms' }, { operation: 'capabilities' }, { operation: 'unknown' },
    { operation: 'status', agentId: 'jessica-vacuum' }, { operation: 'status', requesterSenderId: 'reader' },
    { operation: 'status', grant: 'owner' }, { operation: 'status', readOnly: true },
    { operation: 'status', executionMode: 'agentic' }]) {
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
    assert.match(native.details.content.text, /לא ניתן לאמת/);
    assert.equal(result.outcome.disposition, 'failed');
    assert.equal(result.facts.verified, false);
    assert.equal(result.failures.domain.sideEffects, 'none');
    assert.equal(result.failures.handling.code, result.failures.domain.code);
    assert.equal(result.notification, undefined);
  }
});

test('repeat status is a fresh read rather than an input replay claim or cached response', async () => {
  const f = fixture();
  await f.tool.execute('call', { operation: 'status' });
  await f.tool.execute('call', { operation: 'status' });
  assert.equal(f.state.stateReads, 2);
  assert.equal(f.state.sensorReads, 2);
});

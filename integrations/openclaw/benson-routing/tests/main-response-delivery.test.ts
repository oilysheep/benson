import assert from 'node:assert/strict';
import test from 'node:test';
import { createMainResponseDelivery } from '../core/response-control.js';
import { createResponseEnvelope } from '../core/legacy-response.js';

const ordinary = () => createResponseEnvelope({ messageCandidate: { text: 'Reviewed Main reply.', language: 'en' } }, {
  requestId: 'request-1', source: { type: 'main', agentId: 'main', runId: 'run-1' }, status: 'success', results: [],
  pendingContext: null, provenance: { executionVerified: 'not_applicable', completionCorrelated: false },
  lifecycle: { domainExecution: 'none', failure: null },
  responsePolicy: { preferredMode: 'pass_through', allowedModes: ['pass_through', 'safe_failure'] },
});
const presentation = { language: 'en' as const, now: '2026-10-26T00:00:00Z', timezone: 'UTC' };

for (const scenario of ['single', 'multiple', 'none', 'cancelled', 'metadata-error', 'async-metadata'] as const) {
  test(`native candidate resolution preserves fail-closed preparation: ${scenario}`, async () => {
    const abort = new AbortController();
    const delivery = createMainResponseDelivery({ mode: 'native-resolver', requestId: 'request-1', agentId: 'main',
      runId: () => 'run-1', assertCurrent: () => true, responseFor: ordinary, presentation });
    const result = delivery.resolveNativeCandidate({ signal: abort.signal,
      resolve: async () => {
        if (scenario === 'cancelled') abort.abort();
        if (scenario === 'multiple') return [{ text: 'one' }, { text: 'two' }];
        if (scenario === 'none') return undefined;
        return { text: 'unreviewed' };
      }, copyMetadata: (_source, approved) => {
        if (scenario === 'metadata-error') throw Error('metadata failure');
        if (scenario === 'async-metadata') return Promise.resolve(approved);
        return approved;
      } });
    if (scenario === 'single') {
      const approved = await result;
      assert.deepEqual(approved, { text: 'Reviewed Main reply.' });
      assert.equal(delivery.beforeNativeDeliver(approved, { kind: 'final' }), approved);
      assert.equal(delivery.beforeNativeDeliver(approved, { kind: 'final' }), null);
    } else {
      await assert.rejects(result);
      assert.equal(delivery.snapshot().outcome, 'blocked');
      assert.equal(delivery.beforeNativeDeliver({ text: 'fallback' }, { kind: 'final' }), null);
    }
  });
}
function fixture(overrides: Partial<Extract<Parameters<typeof createMainResponseDelivery>[0], { mode?: never }>> = {}) {
  const sink: unknown[] = [];
  const delivery = createMainResponseDelivery({ requestId: 'request-1', agentId: 'main', runId: () => 'run-1',
    assertCurrent: () => true, responseFor: ordinary, presentation,
    deliver: async payload => { assert(Object.isFrozen(payload)); sink.push(payload); }, ...overrides });
  return { delivery, sink };
}

test('Controller text is final; duplicate and concurrent candidates cannot resend', async () => {
  const { delivery, sink } = fixture();
  const first = delivery.deliver({ text: 'Unreviewed candidate.', mediaUrl: 'not-authorized' }, { kind: 'final' });
  await assert.rejects(delivery.deliver({ text: 'Duplicate' }, { kind: 'final' }), /already_settled/);
  await first;
  assert.deepEqual(sink, [{ text: 'Reviewed Main reply.' }]);
  assert.deepEqual(delivery.snapshot(), { outcome: 'delivered', failure: null });
});
for (const mode of ['missing-authority', 'async-authority', 'revoked', 'invalid-schema', 'wrong-request', 'wrong-run',
  'async-response', 'renderer-error', 'reentry'] as const) {
  test(`fail closed before sink: ${mode}`, async () => {
    let checks = 0; let reentry: Promise<void> | undefined;
    const overrides: Partial<Extract<Parameters<typeof createMainResponseDelivery>[0], { mode?: never }>> = {};
    if (mode === 'missing-authority') overrides.assertCurrent = () => false;
    if (mode === 'async-authority') overrides.assertCurrent = () => new Promise(() => {});
    if (mode === 'revoked') overrides.assertCurrent = () => ++checks === 1;
    if (mode === 'invalid-schema') overrides.responseFor = () => ({ ...ordinary(), schemaVersion: 999 });
    if (mode === 'wrong-request') overrides.requestId = 'foreign';
    if (mode === 'wrong-run') overrides.runId = () => 'foreign';
    if (mode === 'async-response') overrides.responseFor = () => new Promise(() => {});
    if (mode === 'renderer-error') overrides.presentation = { ...presentation, timezone: 'invalid' };
    const { delivery, sink } = fixture(overrides);
    // The reentrant callback is a separate hostile host composition, not a grant.
    const subject = mode === 'reentry' ? fixture({ responseFor: () => {
      reentry = subject.delivery.deliver({}, { kind: 'final' }); reentry.catch(() => {}); throw Error('Reentry rejected');
    } }) : { delivery, sink };
    await assert.rejects(subject.delivery.deliver({}, { kind: 'final' }));
    if (reentry) await assert.rejects(reentry, /already_settled/);
    assert.deepEqual(subject.sink, []);
    assert.deepEqual(subject.delivery.snapshot(), { outcome: 'blocked', failure: 'MAIN_RESPONSE_BLOCKED' });
    await assert.rejects(subject.delivery.deliver({}, { kind: 'final' }), /already_settled/);
  });
}
test('possible transport effects remain UNKNOWN and cannot be replayed', async () => {
  let attempts = 0;
  const { delivery } = fixture({ deliver: async () => { attempts++; throw Error('Acknowledgment lost'); } });
  await assert.rejects(delivery.deliver({}, { kind: 'final' }));
  assert.deepEqual(delivery.snapshot(), { outcome: 'unknown', failure: 'MAIN_RESPONSE_DELIVERY_UNKNOWN' });
  await assert.rejects(delivery.deliver({}, { kind: 'final' })); assert.equal(attempts, 1);
});
test('nonterminal sends are rejected without consuming the final response', async () => {
  const { delivery, sink } = fixture();
  await assert.rejects(delivery.deliver({}, { kind: 'block' }), /final_required/);
  await delivery.deliver({}, { kind: 'final' }); assert.equal(sink.length, 1);
});

test('explicit native mode prepares one immutable authorized handoff, not a delivery receipt', async () => {
  const delivery = createMainResponseDelivery({ mode: 'native-resolver', requestId: 'request-1', agentId: 'main',
    runId: () => 'run-1', assertCurrent: () => true, responseFor: ordinary, presentation });
  const prepared = delivery.prepare({ text: 'Unapproved', mediaUrl: 'unapproved' });
  assert(Object.isFrozen(prepared)); assert.deepEqual(prepared, { text: 'Reviewed Main reply.' });
  assert.deepEqual(delivery.snapshot(), { outcome: 'prepared', failure: null });
  assert.throws(() => delivery.prepare({}), /already_settled/);
  await assert.rejects(delivery.deliver({}, { kind: 'final' }), /raw_mode_required/);
  const raw = fixture(); assert.throws(() => raw.delivery.prepare({}), /native_mode_required/);
  assert.deepEqual(raw.delivery.snapshot(), { outcome: 'pending', failure: null });
});
for (const mode of ['stale-after-render', 'foreign', 'async', 'exception', 'reentry'] as const) {
  test(`native preparation rejects before handoff: ${mode}`, () => {
    let checks = 0;
    const delivery = createMainResponseDelivery({ mode: 'native-resolver', requestId: 'request-1', agentId: 'main',
      runId: () => mode === 'foreign' ? 'foreign-run' : 'run-1',
      assertCurrent: () => mode === 'stale-after-render' ? ++checks === 1 : true,
      responseFor: () => {
        if (mode === 'async') return new Promise(() => {});
        if (mode === 'exception') throw Error('Controller unavailable');
        if (mode === 'reentry') delivery.prepare({});
        return ordinary();
      }, presentation });
    assert.throws(() => delivery.prepare({}));
    assert.deepEqual(delivery.snapshot(), { outcome: 'blocked', failure: 'MAIN_RESPONSE_BLOCKED' });
    assert.throws(() => delivery.prepare({}), /already_settled/);
  });
}

test('native gate releases only the exact prepared payload once, preserving native object identity', () => {
  const delivery = createMainResponseDelivery({ mode: 'native-resolver', requestId: 'request-1', agentId: 'main',
    runId: () => 'run-1', assertCurrent: () => true, responseFor: ordinary, presentation });
  assert.equal(delivery.beforeNativeDeliver({ text: 'Uncontrolled fallback' }, { kind: 'final' }), null);
  const approved = delivery.prepare({});
  const native = { ...approved };
  assert.equal(delivery.beforeNativeDeliver(native, { kind: 'final' }), native);
  assert(Object.isFrozen(native));
  assert.throws(() => Object.assign(native, { location: { latitude: 1, longitude: 2 } }), TypeError);
  assert.equal(delivery.beforeNativeDeliver(native, { kind: 'final' }), null);
  assert.equal(delivery.beforeNativeDeliver({ text: 'Native fallback' }, { kind: 'final' }), null);
  assert.deepEqual(delivery.snapshot(), { outcome: 'prepared', failure: null });
});
for (const mode of ['changed-text', 'media', 'nonterminal', 'revoked', 'async', 'throw'] as const) {
  test(`native pre-delivery gate fails closed: ${mode}`, () => {
    let gate = false;
    const delivery = createMainResponseDelivery({ mode: 'native-resolver', requestId: 'request-1', agentId: 'main',
      runId: () => 'run-1', assertCurrent: () => {
        if (gate && mode === 'revoked') return false;
        if (gate && mode === 'async') return new Promise(() => {});
        if (gate && mode === 'throw') throw Error('Authority unavailable');
        return true;
      }, responseFor: ordinary, presentation });
    const approved = delivery.prepare({}); gate = true;
    const candidate = mode === 'changed-text' ? { text: 'Changed after authorization' }
      : mode === 'media' ? { ...approved, mediaUrl: 'not-authorized' } : approved;
    assert.equal(delivery.beforeNativeDeliver(candidate, { kind: mode === 'nonterminal' ? 'tool' : 'final' }), null);
    assert.deepEqual(delivery.snapshot(), { outcome: 'blocked', failure: 'MAIN_RESPONSE_BLOCKED' });
    assert.equal(delivery.beforeNativeDeliver(approved, { kind: 'final' }), null);
  });
}
for (const field of ['fallbackText', 'presentation', 'location', 'channelData', 'interactive', 'attachments',
  'delivery', 'btw', 'spokenText', 'ttsSupplement', 'replyToId', 'isError', 'futureField', 'symbol', 'hidden', 'accessor'] as const) {
  test(`native terminal-text gate rejects extra or dynamic payload surface: ${field}`, () => {
    const delivery = createMainResponseDelivery({ mode: 'native-resolver', requestId: 'request-1', agentId: 'main',
      runId: () => 'run-1', assertCurrent: () => true, responseFor: ordinary, presentation });
    const approved = delivery.prepare({}); const candidate = { ...approved };
    let getterCalls = 0;
    if (field === 'accessor') Object.defineProperty(candidate, 'text', { get() { getterCalls++; return approved.text; } });
    else Object.defineProperty(candidate, field === 'symbol' ? Symbol('unapproved') : field, {
      value: field === 'fallbackText' ? { text: 'Unapproved rich content' } : { unapproved: true }, enumerable: field !== 'hidden' });
    assert.equal(delivery.beforeNativeDeliver(candidate, { kind: 'final' }), null);
    assert.deepEqual(delivery.snapshot(), { outcome: 'blocked', failure: 'MAIN_RESPONSE_BLOCKED' });
    assert.equal(getterCalls, 0);
    assert.equal(delivery.beforeNativeDeliver(approved, { kind: 'final' }), null);
  });
}

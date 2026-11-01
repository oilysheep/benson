import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompletionAuthority, acceptAgentCompletion, reconstructCompletion, validateCompletion } from '../core/completion.js';
import { createCompletionDomainResultV3, validateDomainResultV3, validateDomainResult, MAX_DOMAIN_RESULT_V3_BYTES } from '../core/domain-result.js';
import { createResponseV4Envelope, validateResponseV4Envelope, validateResponseV3Envelope, MAX_RESPONSE_V4_BYTES } from '../core/legacy-response.js';
import { controlResponse, createMainResponseDelivery } from '../core/response-control.js';
import type { Binding6, Completion6 } from '../core/completion-contracts.js';
import type { DomainResultV3, Effects } from '../core/contracts.js';
import { MAX_BYTES, MAX_RESPONSE_RESULTS, MAX_WARNINGS } from '../core/value.js';

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const settings = { language: 'en' as const, now: '2026-11-01T08:00:00Z', timezone: 'UTC' };
const id = (i: number) => `${i}`.padEnd(512, 'א');
function fixture(atom = '😀', budget = MAX_BYTES, possible = false, full = true) {
  let live = true;
  const binding: Binding6 = { inputId: 'input', admissionId: 'admission', conversationId: 'conversation', runId: 'child',
    agentId: 'jessica-vacuum', sessionKey: 'agent:jessica-vacuum:child', sessionId: 'child-session', domain: 'jessica-vacuum', taskId: 'task',
    caller: { runId: 'main', agentId: 'main', sessionKey: 'agent:main:parent', sessionId: 'parent-session' }, completionTarget: 'CALLER',
    authorizationId: 'grant', parentContinuation: { eligible: true, reason: null }, deliveryPolicy: { eligible: false, reason: null } };
  const effects: Effects = { status: possible ? 'possible' : 'known', refs: Array.from({ length: MAX_WARNINGS }, (_, i) => id(i)),
    details: Array.from({ length: MAX_WARNINGS }, (_, i) => ({ ref: id(i), verified: !possible })),
    reconciliation: { required: possible, reason: possible ? id(99) : null } };
  const padding = Array.from({ length: 256 }, () => '');
  const facts: Completion6['facts'] = { domain: 'jessica-vacuum', domainSchemaVersion: '1', operation: 'clean', status: 'success',
    verified: true, verificationScope: Array.from({ length: MAX_WARNINGS }, (_, i) => `scope-${i}`),
    data: { padding }, warnings: Array.from({ length: full ? MAX_WARNINGS : 0 }, (_, i) => ({ code: 'KEEP_WARNING', detail: id(i) })),
    error: null, effects: effects.details, uncertainty: Array.from({ length: full ? MAX_WARNINGS : 0 }, (_, i) => ({ detail: `Keep ${i}` })), pendingContext: null };
  const userResponse = { state: 'unavailable' as const, reason: { code: 'UNKNOWN', detail: 'Reconcile.' } };
  // Authority creation must also fit its retained unavailable default, which is
  // larger than the short final response. Pad against that accepted baseline.
  const baselineResponse = { state: 'unavailable', reason: { code: 'RUNTIME_WORDING_UNAVAILABLE', detail: 'No owner-authored usable message is retained.' } };
  const baseline = { schemaVersion: 6, kind: 'domain-task', binding, facts, results: [], userResponse: baselineResponse,
    completion: { outcome: 'NORMAL', gaps: [] } };
  let remaining = budget - size(baseline);
  assert(remaining >= 0);
  const atomBytes = size(atom) - 2;
  for (let i = 0; i < padding.length && remaining; i++) {
    const n = Math.min(Math.floor(16384 / atom.length), Math.floor(remaining / atomBytes));
    padding[i] = atom.repeat(n); remaining -= n * atomBytes;
    if (remaining < atomBytes && padding[i]!.length < 16384) { padding[i] += 'x'.repeat(remaining); remaining = 0; }
  }
  assert.equal(remaining, 0); assert.equal(size(baseline), budget);
  const authority = createCompletionAuthority({ schemaVersion: 6, kind: 'domain-task', binding, knownFacts: facts,
    results: [], coverage: 'complete', gaps: [], origin: 'agent' }, { assertCurrent() { assert(live, 'retired'); } });
  const record = acceptAgentCompletion({ schemaVersion: 6, kind: 'domain-task', facts, userResponse: baselineResponse }, authority);
  assert(record.schemaVersion === 6);
  const result = createCompletionDomainResultV3(record, authority, { projectEffects: () => effects });
  return { record, authority, result, effects, retire() { live = false; }, userResponse };
}
function trusted(results: unknown[]) {
  return { requestId: id(100), source: { type: 'main', agentId: 'main', runId: '😀'.repeat(256) }, results,
    responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic'] }, lifecycle: { domainExecution: 'attempted', failure: null } };
}

test('v3/v4 preserve accepted full-byte/count upstream payloads with UTF-8, escaping and 16 results', () => {
  for (const atom of ['x', 'א', '😀', '\n', '\u0000', '\ud800']) for (const bytes of [MAX_BYTES - 1, MAX_BYTES]) for (const possible of [false, true]) {
    const f = fixture(atom, bytes, possible);
    assert(size(f.result) <= MAX_DOMAIN_RESULT_V3_BYTES);
    assert.deepEqual(JSON.parse(JSON.stringify(f.result.effects)), f.effects);
    assert.deepEqual(f.result.facts.data, f.record.facts.data);
    assert.deepEqual(f.result.warnings, f.record.facts.warnings);
    assert.deepEqual(f.result.uncertainty, f.record.facts.uncertainty);
    assert.deepEqual(f.result.pendingContext, f.record.facts.pendingContext);
    const response = createResponseV4Envelope({ messageCandidate: null }, trusted(Array(MAX_RESPONSE_RESULTS).fill(f.result)));
    assert.equal(response.results.length, 16); assert(size(response) <= MAX_RESPONSE_V4_BYTES);
    for (const result of response.results) assert.deepEqual(result, f.result);
    assert.throws(() => validateDomainResult(f.result), /shape|bytes/);
    assert.throws(() => validateResponseV3Envelope(response), /invalid|bytes/);
    f.retire(); assert.throws(() => validateCompletion(f.record, f.authority), /retired/);
  }
});

function inherited(value: DomainResultV3) {
  return { facts: { ...value.facts, status: value.outcome.status, domain: value.domain, domainSchemaVersion: value.domainSchemaVersion,
    operation: value.operation, warnings: value.warnings, error: value.failures.domain, effects: value.effects.details,
    uncertainty: value.uncertainty, pendingContext: value.pendingContext }, userResponse: value.content, completion: { gaps: value.evidence.gaps } };
}
function metadata(value: DomainResultV3) {
  return { ...value, facts: { ...value.facts, data: null, verificationScope: [] }, warnings: [],
    failures: { ...value.failures, domain: null }, effects: { ...value.effects, details: [] }, uncertainty: [], pendingContext: null,
    content: null, evidence: { ...value.evidence, gaps: [] } };
}

test('independent payload and metadata budgets compose at both exact caps without duplicating values', () => {
  const raw = structuredClone(fixture().result);
  const data = raw.facts.data; assert(data && typeof data === 'object' && !Array.isArray(data));
  const padding = data.padding; assert(Array.isArray(padding));
  padding[255] = 'x'.repeat(MAX_BYTES - size(inherited(raw)));
  assert.equal(size(inherited(raw)), MAX_BYTES);
  raw.evidence.observations = Array.from({ length: 64 }, (_, i) => ({ ref: id(i), observedAt: null, freshness: 'unknown' as const }));
  raw.effects.reconciliation = { required: true, reason: 'R' };
  let remaining = MAX_BYTES - size(metadata(raw));
  assert(remaining > 0);
  for (const observation of raw.evidence.observations) {
    if (remaining < 23) break;
    const fraction = Math.min(16000, remaining - 23);
    observation.observedAt = `2026-11-01T08:00:00.${'0'.repeat(fraction + 1)}Z`;
    remaining = MAX_BYTES - size(metadata(raw));
  }
  // Finish any sub-timestamp remainder through an existing short metadata id.
  raw.effects.reconciliation.reason += 'R'.repeat(remaining);
  assert.equal(size(metadata(raw)), MAX_BYTES);
  const result = validateDomainResultV3(raw);
  assert(size(result) <= 2 * MAX_BYTES); assert(size(result) > MAX_BYTES);
  const response = createResponseV4Envelope({ messageCandidate: null }, trusted(Array(16).fill(result)));
  assert.equal(size(response), size({ ...response, results: [] }) + 16 * size(result) + 15);
  assert(size(response) <= MAX_RESPONSE_V4_BYTES);
  const payloadOverflow = structuredClone(raw); const d = payloadOverflow.facts.data as { padding: string[] };
  d.padding[255] += 'x'; assert.throws(() => validateDomainResultV3(payloadOverflow), /json_bytes_exceeded/);
  const metadataOverflow = structuredClone(raw); metadataOverflow.effects.reconciliation.reason += 'x';
  assert.throws(() => validateDomainResultV3(metadataOverflow), /json_bytes_exceeded/);
});

test('full-count failed Completion retains gaps, domain failure and bound pending context through v3/v4', () => {
  const f = fixture('x', 180000, true);
  const facts = structuredClone(f.record.facts);
  const padding = Array.from({ length: 256 }, () => ''); facts.data = { padding };
  facts.status = 'unknown'; facts.error = { code: 'KEEP_DOMAIN_FAILURE', detail: 'Reconcile all possible effects.' };
  const conversationId = f.record.binding.conversationId; assert(conversationId);
  facts.pendingContext = { schemaVersion: 1, binding: { requesterId: id(77), conversationId },
    value: { unresolved: 'Keep this exact context.' }, expiresAt: '2026-11-01T09:00:00Z' };
  const gaps = Array.from({ length: 64 }, (_, i) => ({ code: 'REPORT', path: String(i).padEnd(512, 'x'), detail: 'א'.repeat(512) }));
  const baseline = { ...f.record, facts, completion: { outcome: 'FAILED', gaps } };
  let remaining = MAX_BYTES - size(baseline); assert(remaining > 0);
  for (let i = 0; i < padding.length && remaining; i++) { const n = Math.min(16384, remaining); padding[i] = 'x'.repeat(n); remaining -= n; }
  assert.equal(remaining, 0); assert.equal(size(baseline), MAX_BYTES);
  const authority = createCompletionAuthority({ schemaVersion: 6, kind: 'domain-task', binding: f.record.binding, knownFacts: facts,
    results: [], coverage: 'complete', gaps, origin: 'runtime' }, { assertCurrent() { validateCompletion(f.record, f.authority); } });
  const record = reconstructCompletion(authority); assert.equal(size(record), MAX_BYTES);
  const result = createCompletionDomainResultV3(record, authority, { projectEffects: () => f.effects });
  assert.deepEqual(result.evidence.gaps, record.completion.gaps); assert.deepEqual(result.failures.domain, record.facts.error);
  assert.deepEqual(JSON.parse(JSON.stringify(result.pendingContext)), JSON.parse(JSON.stringify(record.facts.pendingContext))); assert.deepEqual(result.effects.details, record.facts.effects);
  const response = createResponseV4Envelope({ messageCandidate: null }, trusted(Array(16).fill(result)));
  assert.deepEqual(response.results[15], result);
});

test('explicit version compatibility rejects unknown/malformed components, count overflow and hostile accessors', () => {
  const result = fixture('x', 180000).result;
  const legacy = validateDomainResult({ ...result, schemaVersion: 2 });
  assert.equal(validateResponseV4Envelope(createResponseV4Envelope({ messageCandidate: null }, trusted([legacy, result]))).results.length, 2);
  assert.throws(() => validateDomainResultV3(legacy));
  assert.throws(() => createResponseV4Envelope({ messageCandidate: null }, trusted([{ ...result, schemaVersion: 99 }])));
  assert.throws(() => createResponseV4Envelope({ messageCandidate: null }, trusted([legacy, { ...result, schemaVersion: 99 }])));
  assert.throws(() => createResponseV4Envelope({ messageCandidate: null }, trusted(Array(17).fill(result))), /count/);
  assert.throws(() => validateResponseV4Envelope({ ...createResponseV4Envelope({ messageCandidate: null }, trusted([result])), schemaVersion: 5 }));
  assert.throws(() => validateDomainResultV3({ ...result, effects: { ...result.effects, reconciliation: { required: false, reason: 'contradiction' } } }), /effects_evidence/);
  let calls = 0;
  const getter = { ...result }; Object.defineProperty(getter, 'effects', { enumerable: true, get() { calls++; return result.effects; } });
  assert.throws(() => validateDomainResultV3(getter));
  const nested = { ...result, facts: { ...result.facts } }; Object.defineProperty(nested.facts, 'data', { enumerable: true, get() { calls++; return {}; } });
  assert.throws(() => validateDomainResultV3(nested)); assert.equal(calls, 0);
  const response = { ...trusted([result]), schemaVersion: 4, messageCandidate: null };
  Object.defineProperty(response.results, '0', { get() { calls++; return result; } });
  assert.throws(() => validateResponseV4Envelope(response)); assert.equal(calls, 0);
});

test('v4 uses the same mandatory live Controller, frozen native payload and duplicate/cancellation fences', async () => {
  const f = fixture('x', 180000, false, false); let live = true, sends = 0;
  const result = f.result;
  const response = createResponseV4Envelope({ messageCandidate: null }, { ...trusted([result]), requestId: 'request', source: { type: 'main', agentId: 'main', runId: 'run' } });
  const presentation = { ...settings, assertResponseCurrent() { assert(live, 'retired'); validateCompletion(f.record, f.authority); },
    renderDomainResult() { return { kind: 'rendered' as const, text: 'Verified.', pendingContext: null }; } };
  assert.throws(() => controlResponse(response, settings), /authority/);
  const delivery = createMainResponseDelivery({ mode: 'native-resolver', requestId: 'request', agentId: 'main', runId: () => 'run',
    assertCurrent() { assert(live); }, responseFor: () => response, presentation });
  const prepared = delivery.prepare({ text: 'candidate' }); assert.equal(prepared.text, 'Verified.');
  const final = delivery.beforeNativeDeliver(prepared, { kind: 'final' }); if (final) sends++;
  assert(Object.isFrozen(final)); assert.equal(sends, 1); assert.equal(delivery.beforeNativeDeliver(prepared, { kind: 'final' }), null);
  assert.throws(() => delivery.prepare({ text: 'duplicate' }), /already_settled/);
  const retired = createMainResponseDelivery({ mode: 'native-resolver', requestId: 'request', agentId: 'main', runId: () => 'run',
    assertCurrent() { assert(live); }, responseFor: () => response, presentation });
  const p = retired.prepare({}); live = false;
  assert.equal(retired.beforeNativeDeliver(p, { kind: 'final' }), null);
  assert.throws(() => controlResponse(response, presentation), /retired/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(retired.resolveNativeCandidate({ signal: abort.signal, resolve: async () => ({}), copyMetadata: x => x }));
});

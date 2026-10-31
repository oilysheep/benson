import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { type Static } from 'typebox';
import { createSourceAdmissionController, projectRequestAdmission } from '../core/request-control.js';
import { createCompletionAuthority, acceptAgentCompletion, validateCompletion, reconstructCompletion } from '../core/completion.js';
import { controlReadResponse, controlResponse } from '../core/response-control.js';
import { createNoRunDomainResult, createCompletionDomainResult } from '../core/domain-result.js';
import { createTaskEnvelope, parseTaskEnvelope } from '../core/task-envelope.js';
import { validateRenderedOutput, validateTaskResultEnvelope, createResponseEnvelope } from '../core/legacy-response.js';
import { type Facts, type NativeReadOutcome, type NativeDispatchReadOutcome, TaskEnvelopeSchema } from '../core/contracts.js';
import { boundedCopy, decode, JsonSchema, jsonCopy, type JsonValue } from '../core/value.js';
import { formatUserDatetime, UserDatetimeError } from '../../../../shared/benson-datetime.js';

const currentTime = Date.parse('2026-10-17T10:00:00Z');
function dispatchReadFixture() {
  const state = { live: true, authorized: true };
  const controller = createSourceAdmissionController({ nativeDispatch: { requestId: 'native-message', domain: 'future-domain', subject: 'reader' },
    now: () => currentTime, assertCurrent() { assert(state.live && state.authorized, 'dispatch_closed_or_denied'); },
    assertDomainOutcome(outcome) { assert.deepEqual(outcome.evidence.facts, boundedCopy({ complete: [1, 2, 3] })); } });
  const input = { schemaVersion: 3, kind: 'benson.source-input', domain: 'future-domain', scope: 'read', request: 'status' };
  const admission = controller.admit(input);
  const outcome: NativeDispatchReadOutcome = { schemaVersion: 3, kind: 'benson.no-run',
    admission: { authorityKind: 'native-dispatch', requestId: admission.requestId, domain: admission.domain, subject: admission.authority.subject },
    disposition: 'handled', evidence: { ref: 'observation', observedAt: new Date(currentTime).toISOString(), freshness: 'fresh', facts: { complete: [1, 2, 3] } },
    effects: { status: 'none', refs: [] }, reconciliation: { required: false, reason: null }, notification: null, error: null };
  return { state, controller, input, admission, outcome };
}
test('native dispatch read v3 preserves complete facts and private admission ownership', () => {
  const f = dispatchReadFixture(); assert(Object.isFrozen(f.admission));
  assert.deepEqual(boundedCopy(f.controller.validateOutcome(f.admission, f.outcome)), boundedCopy(f.outcome));
  assert.throws(() => f.controller.assertCurrent({ ...f.admission }), /unowned/);
  assert.throws(() => dispatchReadFixture().controller.assertCurrent(f.admission), /unowned/);
  f.state.live = false; assert.throws(() => f.controller.validateOutcome(f.admission, f.outcome), /dispatch_closed_or_denied/);
});
test('native dispatch read v3 refuses other versions, domains, effect scopes and invented Tool/grant fields', () => {
  const f = dispatchReadFixture();
  for (const delta of [{ schemaVersion: 1 }, { schemaVersion: 2 }, { schemaVersion: 4 }, { domain: 'foreign' },
    { scope: 'action' }, { scope: 'notify' }, { scope: 'reconcile' }, { callId: 'invented' }, { source: { inputId: 'invented' } },
    { request: '' }, { request: 'x'.repeat(8193) }]) assert.throws(() => f.controller.admit({ ...f.input, ...delta }));
  f.state.authorized = false; assert.throws(() => f.controller.admit(f.input), /dispatch_closed_or_denied/);
});
test('native dispatch read v3 rejects forged correlation, effects, notification and incomplete business evidence', () => {
  const f = dispatchReadFixture();
  for (const delta of [{ requestId: 'foreign' }, { authorityKind: 'native-invocation' }, { callId: 'invented' }, { subject: 'foreign' }, { domain: 'foreign' }]) {
    assert.throws(() => f.controller.validateOutcome(f.admission, { ...f.outcome, admission: { ...f.outcome.admission, ...delta } }));
  }
  for (const delta of [{ schemaVersion: 2 }, { schemaVersion: 4 }, { effects: { status: 'known', refs: ['effect'] } },
    { reconciliation: { required: true, reason: 'effect' } },
    { notification: { identity: 'intent', policyRevision: 'policy', evidenceRef: 'observation', route: { recipient: 'reader', channel: 'whatsapp', accountId: 'account', target: 'reader' }, content: 'notify' } },
    { evidence: { ...f.outcome.evidence, facts: { complete: [1] } } }]) assert.throws(() => f.controller.validateOutcome(f.admission, { ...f.outcome, ...delta }));
});
test('native dispatch read v3 reuses read Response and unchanged DomainResultV2 consumers', () => {
  const f = dispatchReadFixture();
  const response = controlReadResponse(f.outcome, { controller: f.controller, admission: f.admission,
    renderOutcome: () => ({ schemaVersion: 2, message: 'Complete read result.' }) });
  const result = createNoRunDomainResult(response, { controller: f.controller, admission: f.admission, language: 'en',
    normalizeFacts: () => ({ ...facts, domain: 'future-domain', data: { complete: [1, 2, 3] } }) });
  assert.equal(result.schemaVersion, 2); assert.equal(result.executionMode, 'deterministic'); assert.equal(result.effects.status, 'none');
  assert.deepEqual(result.facts.data, boundedCopy({ complete: [1, 2, 3] })); assert.equal(result.content?.state, 'usable');
});
function readFixture() {
  let live = true; const trace: string[] = [];
  const controller = createSourceAdmissionController({ invocation: { callId: 'call-1', domain: 'future-domain', subject: 'subject-1' },
    now: () => currentTime, assertCurrent() { trace.push('current'); assert.ok(live, 'closed'); },
    assertDomainOutcome() { trace.push('domain'); } });
  const admission = controller.admit({ schemaVersion: 2, kind: 'benson.source-input', domain: 'future-domain', scope: 'read', request: 'read only' });
  const outcome: NativeReadOutcome = { schemaVersion: 2, kind: 'benson.no-run',
    admission: { authorityKind: 'native-invocation', callId: 'call-1', domain: 'future-domain', subject: 'subject-1' },
    disposition: 'handled', evidence: { ref: 'observation', observedAt: new Date(currentTime).toISOString(), freshness: 'fresh', facts: { value: 7 } },
    effects: { status: 'none', refs: [] }, reconciliation: { required: false, reason: null }, notification: null, error: null };
  return { controller, admission, outcome, trace, close() { live = false; } };
}
const facts: Facts = { status: 'success', domain: 'jessica-vacuum', domainSchemaVersion: '1', operation: 'status', verified: true,
  verificationScope: ['observation'], data: { state: 'docked' }, warnings: [], error: null, effects: [], uncertainty: [], pendingContext: null };
function evidence(generation: number | string = 1) {
  return { schemaVersion: 5, kind: 'domain-task', binding: { inputId: 'input', admissionId: 'admission', conversationId: 'conversation',
    conversationGeneration: generation, runId: 'run', runGeneration: generation, agentId: 'jessica-vacuum', sessionKey: 'child', sessionId: 'session',
    sessionGeneration: generation, domain: 'jessica-vacuum', taskId: 'task', caller: null, completionTarget: 'NATIVE', authorizationId: 'grant',
    parentContinuation: { eligible: false, reason: null }, deliveryPolicy: { eligible: false, reason: null } },
    knownFacts: facts, results: [], coverage: 'complete', gaps: [], origin: 'agent' };
}
const wording = { state: 'usable', text: 'Jessica is docked.', language: 'en' };

test('schema-derived DTOs remain strict below recursive JSON, exact optionals and discriminants', () => {
  type IsUntyped<T> = 0 extends (1 & T) ? true : false;
  type JsonArray = Extract<JsonValue, readonly unknown[]>;
  type Nested = Extract<Extract<JsonArray[number], readonly unknown[]>[number], readonly unknown[]>[number];
  const strict: IsUntyped<Nested> = false;
  assert.equal(strict, false);
  const value: Static<typeof TaskEnvelopeSchema> = createTaskEnvelope('request');
  assert.equal(value.version, 1);
  if (false) {
    // @ts-expect-error Unknown versions cannot be authored as a decoded DTO.
    const version: Static<typeof TaskEnvelopeSchema> = { kind: 'benson.self-contained-request', version: 9, request: 'x' };
    // @ts-expect-error Recursive JSON leaves do not accept callables.
    const invalid: JsonValue = { a: [{ b: [() => 1] }] };
    // @ts-expect-error Narrow v2 read admissions cannot acquire source grants.
    readFixture().admission.source;
    // @ts-expect-error Exact optional properties reject explicit undefined.
    controlResponse({}, { language: undefined });
    void version; void invalid;
  }
});

test('Unicode uses existing UTF-16 bounds while request admission counts UTF-8 bytes', () => {
  assert.equal(validateRenderedOutput({ schemaVersion: 2, message: '😀'.repeat(2048) }).message.length, 4096);
  assert.throws(() => validateRenderedOutput({ schemaVersion: 2, message: '😀'.repeat(2049) }));
  assert.equal(jsonCopy('😀'.repeat(8192)), '😀'.repeat(8192));
  assert.throws(() => jsonCopy('😀'.repeat(8193)));
  assert.equal(jsonCopy('\ud800'), '\ud800');
  const admission = { schemaVersion: 1, kind: 'candidate', reason: null, requestId: 'input', sessionKey: 'session', request: 'א'.repeat(4096) };
  assert.equal(projectRequestAdmission(admission).kind, 'candidate');
  assert.throws(() => projectRequestAdmission({ ...admission, request: 'א'.repeat(4097) }));
  assert.throws(() => projectRequestAdmission({ ...admission, requestId: '😀'.repeat(257) }));
});

test('bounded JSON rejects hostile descriptors, symbols, sparse arrays, prototypes and nonfinite values without reading getters', () => {
  let called = 0; const getter = { get value() { called++; return 'secret'; } };
  const sparse = new Array<unknown>(2);
  for (const invalid of [getter, { [Symbol('x')]: true }, Object.defineProperty({}, 'x', { value: 1 }), sparse,
    { constructor: 'x' }, { prototype: 'x' }, JSON.parse('{"__proto__":1}'), Number.NaN, Infinity, undefined, 1n, new Date()]) {
    assert.throws(() => boundedCopy(invalid));
  }
  assert.equal(called, 0);
  const cycle: Record<string, unknown> = {}; cycle.next = cycle; assert.throws(() => boundedCopy(cycle), /json_too_deep/);
  const deep = Array.from({ length: 17 }).reduce<unknown>(value => ({ child: value }), null);
  assert.throws(() => boundedCopy(deep), /json_too_deep/);
  assert.throws(() => boundedCopy(Array.from({ length: 256 }, () => 'x'.repeat(16384))), /json_bytes_exceeded/);
  assert.equal(boundedCopy(0.5), 0.5);
  assert.throws(() => decode(JsonSchema, { x: () => 1 }, 'json_shape'));
});

test('native evidence never evaluates accessor versions or array elements', () => {
  let called = 0;
  const native = Object.defineProperty(evidence(), 'schemaVersion', { get() { called++; return 5; } });
  assert.throws(() => createCompletionAuthority(native));
  const results: unknown[] = [null]; Object.defineProperty(results, '0', { get() { called++; return {}; } });
  assert.throws(() => createCompletionAuthority({ ...evidence(), kind: 'agent-run', results }));
  assert.equal(called, 0);
});

test('task/request contracts reject unknown or mixed versions and never upgrade or coerce', () => {
  assert.equal(parseTaskEnvelope(JSON.stringify(createTaskEnvelope(''))).request, '');
  for (const version of [0, 2, '1', null]) assert.throws(() => parseTaskEnvelope(JSON.stringify({ kind: 'benson.self-contained-request', version, request: 'x' })));
  const f = readFixture();
  for (const version of [1, 3, '2']) assert.throws(() => f.controller.validateOutcome(f.admission, { ...f.outcome, schemaVersion: version }));
  const extra = { ...f.outcome, ignored: true }; assert.throws(() => f.controller.validateOutcome(f.admission, extra));
  assert.ok(Object.hasOwn(extra, 'ignored'));
});

test('live admission identity and post-normalization currentness gate every disclosure', () => {
  const f = readFixture();
  const rendered = controlReadResponse(f.outcome, { ...f, renderOutcome: () => ({ schemaVersion: 2, message: 'Seven.' }) });
  const result = createNoRunDomainResult(rendered, { ...f, language: 'en', normalizeFacts: data => ({ ...facts, domain: 'future-domain', data }) });
  assert.equal(result.executionMode, 'deterministic'); assert.deepEqual(result.facts.data, Object.assign(Object.create(null), { value: 7 }));
  assert.equal('runId' in result, false); assert.equal(f.trace.at(-1), 'current');
  assert.throws(() => f.controller.assertCurrent(structuredClone(f.admission)), /unowned/);
  assert.throws(() => readFixture().controller.assertCurrent(f.admission), /unowned/);
  assert.throws(() => controlReadResponse(f.outcome, { ...f, renderOutcome: () => { f.close(); return { schemaVersion: 2, message: 'Seven.' }; } }), /closed/);
  const racing = readFixture(); const response = controlReadResponse(racing.outcome, { ...racing, renderOutcome: () => ({ schemaVersion: 2, message: 'Seven.' }) });
  assert.throws(() => createNoRunDomainResult(response, { ...racing, language: 'en', normalizeFacts: data => {
    racing.close(); return { ...facts, domain: 'future-domain', data };
  } }), /closed/);
});

test('async callbacks reject and rejected Promises are contained without authority or effects', async () => {
  const f = readFixture();
  assert.throws(() => controlReadResponse(f.outcome, { ...f, renderOutcome: async () => { throw new Error('renderer'); } }), /synchronous/);
  const response = controlReadResponse(f.outcome, { ...f, renderOutcome: () => ({ schemaVersion: 2, message: 'Seven.' }) });
  assert.throws(() => createNoRunDomainResult(response, { ...f, language: 'en', normalizeFacts: async () => { throw new Error('normalizer'); } }), /synchronous/);
  for (const assertCurrent of [() => false, async () => { throw new Error('authority'); }]) {
    assert.throws(() => createSourceAdmissionController({ invocation: { callId: 'call', domain: 'future', subject: 'reader' },
      assertCurrent, assertDomainOutcome() {}, now: () => currentTime }).admit({ schemaVersion: 2, kind: 'benson.source-input', domain: 'future', scope: 'read', request: 'x' }));
  }
  assert.throws(() => controlReadResponse(f.outcome, { ...f, controller: { ...f.controller,
    // @ts-expect-error An untyped composition callback must also fail at runtime.
    validateOutcome: async () => { throw new Error('validator'); },
  }, renderOutcome: () => ({ schemaVersion: 2, message: 'Seven.' }) }), /synchronous/);
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('completion authorities cannot be cloned or forged; opaque generations and facts remain exact', () => {
  for (const generation of [1, '1', 'opaque-generation']) {
    const native = evidence(generation), authority = createCompletionAuthority(native);
    const record = acceptAgentCompletion({ schemaVersion: 5, kind: 'domain-task', facts, userResponse: wording }, authority);
    assert.equal(record.schemaVersion, 5); if (record.schemaVersion !== 5) assert.fail('version');
    assert.equal(record.binding.runGeneration, generation);
    assert.throws(() => validateCompletion(record, {}), /authority_required/);
    assert.throws(() => validateCompletion(record, structuredClone(authority)), /authority_required/);
    assert.throws(() => validateCompletion({ ...record, binding: { ...record.binding, runGeneration: generation === 1 ? '1' : 1 } }, authority), /binding_mismatch/);
    assert.throws(() => acceptAgentCompletion({ schemaVersion: 5, kind: 'domain-task', facts: { ...facts, data: { guessed: true } }, userResponse: wording }, authority), /evidence_mismatch/);
  }
  const { effects: _effects, ...knownFacts } = facts;
  const authority = createCompletionAuthority({ ...evidence(), origin: 'runtime', knownFacts });
  const recovered = reconstructCompletion(authority);
  const projected = createCompletionDomainResult(recovered, authority);
  assert.equal(projected.effects.status, 'possible');
  assert.equal(projected.effects.reconciliation.required, true);
  assert.equal(projected.outcome.status, 'success');
});

test('response policy consumes a narrow renderer Port and preserves language and effect-aware failure behavior', () => {
  const { verificationScope: _scope, effects: _effects, uncertainty: _uncertainty, ...taskFacts } = facts;
  const task = validateTaskResultEnvelope({ ...taskFacts, schemaVersion: 1, taskId: 'task', messageCandidate: { text: 'Jessica is docked.', language: 'en' } });
  const response = createResponseEnvelope({ messageCandidate: task.messageCandidate }, {
    requestId: 'input', source: { type: 'main', agentId: 'main', runId: 'main-run' }, status: 'success', results: [task],
    pendingContext: null, responsePolicy: { allowedModes: ['pass_through', 'deterministic', 'safe_failure'], preferredMode: 'pass_through' },
    provenance: { executionVerified: true, completionCorrelated: true }, lifecycle: { domainExecution: 'attempted', failure: null },
  });
  const options = { language: 'en' as const, now: new Date(currentTime).toISOString(), timezone: 'Asia/Jerusalem',
    renderResult: () => ({ kind: 'rendered' as const, text: 'Jessica is docked.', pendingContext: null }) };
  assert.equal(controlResponse(response, options).mode, 'pass_through');
  assert.equal(controlResponse(response, { ...options, language: 'he' }).mode, 'deterministic');
  const { schemaVersion: _version, messageCandidate: _candidate, ...trusted } = response;
  const mismatch = createResponseEnvelope({ messageCandidate: { text: 'Unverified guess.', language: 'en' } }, trusted);
  assert.equal(controlResponse(mismatch, options).mode, 'deterministic');
});

function importGraph(entries: readonly string[], sources: (path: string) => string): Set<string> {
  const seen = new Set<string>(), pending = [...entries];
  const core = resolve('integrations/openclaw/benson-routing/core'), shared = resolve('shared/benson-datetime.ts');
  while (pending.length) {
    const path = pending.pop(); if (!path || seen.has(path)) continue; seen.add(path);
    assert.ok(path.startsWith(core + sep) || path === shared, `core_native_path:${path}`);
    const source = sources(path);
    assert.doesNotMatch(source, /\b(?:import|require)\s*\(/, 'core_dynamic_import');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]; assert.ok(specifier);
      if (specifier.startsWith('node:') || specifier === 'typebox' || specifier.startsWith('typebox/')) continue;
      assert.ok(specifier.startsWith('.'), `core_external_dependency:${specifier}`);
      pending.push(resolve(dirname(path), specifier.replace(/\.js$/, '.ts')));
    }
  }
  return seen;
}
test('the entire transitive Business Core source graph admits only Node, TypeBox and the shared time owner', async () => {
  const core = resolve('integrations/openclaw/benson-routing/core');
  const entries = readdirSync(core).filter(name => name.endsWith('.ts')).map(name => join(core, name));
  const graph = importGraph([...entries, resolve('shared/benson-datetime.ts')], path => readFileSync(path, 'utf8'));
  assert.ok(graph.size >= entries.length);
  for (const hidden of ["export type { X } from 'openclaw/plugin-sdk/plugin-entry';", "import '../adapters/openclaw/context.js';", "const x = import('openclaw');"]) {
    const fake = new Map([[join(core, 'a.ts'), "export * from './b.js';"], [join(core, 'b.ts'), hidden]]);
    assert.throws(() => importGraph([join(core, 'a.ts')], path => fake.get(path) ?? assert.fail('missing fixture')));
  }
  const sdk = 'openclaw' + '/plugin-sdk/plugin-entry';
  await assert.rejects(import(sdk), /portability_dependency_forbidden/);
});

test('shared time retains explicit offsets, calendar-day and DST semantics', () => {
  for (const [value, now, expected] of [
    ['2026-03-27T21:30:00Z', '2026-03-27T20:30:00Z', 'מחר ב־00:30'],
    ['2026-10-25T00:30:00Z', '2026-10-24T22:30:00Z', 'היום ב־02:30'],
  ] as const) assert.equal(formatUserDatetime(value, 'Asia/Jerusalem', { now }), expected);
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-17T10:00:00', '2026-10-17T10:00:00+24:00']) {
    assert.throws(() => formatUserDatetime(value, 'Asia/Jerusalem'), UserDatetimeError);
  }
});

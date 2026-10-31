import assert from 'node:assert/strict';
import test from 'node:test';
import { createResponseEnvelope, createResponseV3Envelope, validateResponseEnvelope, validateResponseV3Envelope } from '../core/legacy-response.js';
import { validateDomainResult } from '../core/domain-result.js';
import { controlResponse, createMainResponseDelivery, createDirectReadResponseDelivery, type ResponseV3Options } from '../core/response-control.js';
import { createSourceAdmissionController } from '../core/request-control.js';
import { type DomainResult, type ResponseV3, RESPONSE_CONTRACT_VERSION } from '../core/contracts.js';
import { boundedCopy } from '../core/value.js';
import { renderJessicaDomainResult } from '../../../../agents/jessica-vacuum/lib/presentation.js';
import { renderReminderDomainResult } from '../../../../agents/reminder-service/lib/presentation.js';

const settings = { language: 'en' as const, now: '2026-10-26T00:00:00Z', timezone: 'UTC' };
for (const fault of ['none', 'foreign-request', 'foreign-subject', 'foreign-domain', 'main-source', 'revoked', 'mutation', 'duplicate', 'fallback'] as const) {
  test(`direct native read uses the shared mandatory Response gate: ${fault}`, async () => {
    let live = true;
    const controller = createSourceAdmissionController({ nativeDispatch: { requestId: 'direct-request', domain: 'jessica-vacuum', subject: 'reader' },
      assertCurrent() { assert(live); }, assertDomainOutcome() {}, now: () => Date.parse(settings.now) });
    const admission = controller.admit({ schemaVersion: 3, kind: 'benson.source-input', domain: 'jessica-vacuum', scope: 'read', request: 'status' });
    const binding = { authorityKind: 'native-dispatch', requestId: admission.requestId, domain: admission.domain, subject: admission.authority.subject };
    const source = { type: 'direct', executionMode: 'deterministic', agentId: 'jessica-vacuum', admission: binding };
    const response = () => createResponseV3Envelope({ messageCandidate: null }, { requestId: 'direct-request', source:
      fault === 'main-source' ? { type: 'main', agentId: 'main', runId: 'run' } : { ...source, admission: { ...binding,
        ...fault === 'foreign-subject' ? { subject: 'foreign' } : {},
        ...fault === 'foreign-domain' ? { domain: 'foreign' } : {} } }, results: [result()],
      lifecycle: { domainExecution: 'attempted', failure: null }, responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic'] } });
    const delivery = createDirectReadResponseDelivery({ mode: 'native-resolver', requestId: fault === 'foreign-request' ? 'foreign' : 'direct-request',
      agentId: 'jessica-vacuum', admission, assertCurrent() { assert(live); }, responseFor: response,
      presentation: { ...settings, renderDomainResult(value) { assert(value.content?.state === 'usable'); return { kind: 'rendered', text: value.content.text, pendingContext: boundedCopy(value.pendingContext) }; },
        assertResponseCurrent(value) { assert(live); assert.deepEqual(boundedCopy(value.source), boundedCopy(source)); assert.deepEqual(value.results, [result()]); } } });
    if (['foreign-request', 'foreign-subject', 'foreign-domain', 'main-source'].includes(fault)) {
      assert.throws(() => delivery.prepare({ text: 'candidate' })); assert.equal(delivery.beforeNativeDeliver({ text: 'fallback' }, { kind: 'final' }), null); return;
    }
    if (fault === 'fallback') {
      await assert.rejects(delivery.resolveNativeCandidate({ resolve: async () => ({ text: 'Fallback', isFallbackNotice: true }),
        copyMetadata: (_raw, approved) => approved }), /terminal_candidate_required/);
      assert.equal(delivery.snapshot().outcome, 'blocked');
      assert.equal(delivery.beforeNativeDeliver({ text: 'Fallback' }, { kind: 'final' }), null); return;
    }
    const prepared = delivery.prepare({ text: 'candidate' });
    if (fault === 'revoked') live = false;
    const payload = fault === 'mutation' ? { text: 'changed' } : prepared;
    const allowed = delivery.beforeNativeDeliver(payload, { kind: 'final' });
    assert.equal(allowed, fault === 'revoked' || fault === 'mutation' ? null : payload);
    assert.equal(delivery.beforeNativeDeliver(payload, { kind: 'final' }), null);
  });
}
const pending = (id: string) => ({ schemaVersion: 1, value: { question: `Question ${id}` },
  binding: { requesterId: 'reader', conversationId: id }, expiresAt: '2026-10-27T00:00:00Z' });
function result(domain = 'jessica-vacuum', overrides: Record<string, unknown> = {}): DomainResult {
  return validateDomainResult({ schemaVersion: 2, kind: 'benson.domain-result', executionMode: 'deterministic',
    domain, domainSchemaVersion: '1', operation: domain === 'reminder' ? 'list' : 'status',
    outcome: { status: 'success', disposition: 'handled' }, facts: { verified: true, verificationScope: ['read'], data: { complete: [1, 2, 3] } },
    evidence: { observations: [], gaps: [] }, warnings: [], failures: { domain: null, handling: null },
    effects: { status: 'none', refs: [], details: [], reconciliation: { required: false, reason: null } }, uncertainty: [], pendingContext: null,
    content: { state: 'usable', text: `Full ${domain} result.`, language: 'en' }, ...overrides });
}
function envelope(results: DomainResult[] = [], overrides: Record<string, unknown> = {}) {
  return createResponseV3Envelope({ messageCandidate: results.length ? null : { text: 'Ordinary reply.', language: 'en' } }, {
    requestId: 'request', source: { type: 'main', agentId: 'main', runId: 'run' }, results,
    lifecycle: { domainExecution: results.length ? 'attempted' : 'none', failure: null },
    responsePolicy: { preferredMode: 'pass_through', allowedModes: ['pass_through', 'deterministic', 'safe_failure'] }, ...overrides });
}
function options(expected: ResponseV3): ResponseV3Options {
  return { ...settings, assertResponseCurrent(value) { assert.deepEqual(value, expected); },
    renderDomainResult(value) { assert(value.content?.state === 'usable');
      return { kind: 'rendered', text: value.content.text, pendingContext: boundedCopy(value.pendingContext) }; } };
}
test('v3 has exact fields, bounded full results and all three discriminated sources', () => {
  const r = result();
  const admissions = [{ authorityKind: 'native-invocation', callId: 'call', domain: r.domain, subject: 'reader' },
    { inputId: 'input', sourceType: 'user', sourceRef: 'source', authorityRef: 'grant', authorityRevision: 'revision', domain: r.domain, subject: 'reader' }];
  for (const admission of admissions) {
    const v = envelope([r], { source: { type: 'direct', executionMode: 'deterministic', agentId: 'jessica-vacuum', admission } });
    assert.equal(v.results[0]?.executionMode, 'deterministic'); assert(!('runId' in v.source));
  }
  const a = envelope([result('jessica-vacuum', { executionMode: 'agentic' })],
    { source: { type: 'direct', executionMode: 'agentic', agentId: 'jessica-vacuum', runId: 'child' } });
  assert.equal(a.source.type, 'direct');
  assert.equal(envelope(Array.from({ length: 16 }, () => r)).results.length, 16);
  assert(Object.isFrozen(a.results[0]));
});
for (const mode of ['unknown-version', 'legacy-status', 'legacy-pending', 'legacy-provenance', 'mixed-result-version', 'extra-source',
  'too-many', 'direct-empty', 'direct-many', 'direct-mode', 'direct-domain', 'fake-no-run', 'zero-uncertain', 'bad-policy', 'byte-bound'] as const) {
  test(`strict v3 rejects ${mode}`, () => {
    const r = result(), v: Record<string, unknown> = JSON.parse(JSON.stringify(envelope([r])));
    if (mode === 'unknown-version') v.schemaVersion = 999;
    if (mode === 'legacy-status') v.status = 'success';
    if (mode === 'legacy-pending') v.pendingContext = null;
    if (mode === 'legacy-provenance') v.provenance = { completionCorrelated: true };
    if (mode === 'mixed-result-version') v.results = [r, { ...r, schemaVersion: 1 }];
    if (mode === 'extra-source') v.source = { type: 'main', agentId: 'main', runId: 'run', executionMode: 'agentic' };
    if (mode === 'too-many') v.results = Array.from({ length: 17 }, () => r);
    if (mode.startsWith('direct-') || mode === 'fake-no-run') {
      v.source = { type: 'direct', executionMode: 'deterministic', agentId: 'jessica-vacuum',
        admission: { authorityKind: 'native-invocation', callId: 'call', domain: mode === 'direct-domain' ? 'reminder' : r.domain, subject: 'reader' },
        ...mode === 'fake-no-run' ? { runId: 'fake' } : {} };
      if (mode === 'direct-empty') v.results = [];
      if (mode === 'direct-many') v.results = [r, r];
      if (mode === 'direct-mode') v.results = [result(r.domain, { executionMode: 'agentic' })];
    }
    if (mode === 'zero-uncertain') { v.results = []; v.lifecycle = { domainExecution: 'uncertain', failure: null }; }
    if (mode === 'bad-policy') v.responsePolicy = { preferredMode: 'pass_through', allowedModes: ['deterministic'] };
    if (mode === 'byte-bound') v.results = Array.from({ length: 16 }, () => ({ ...r, facts: { ...r.facts,
      data: { bulk: Array.from({ length: 32 }, () => 'x'.repeat(16384)) } } }));
    assert.throws(() => validateResponseV3Envelope(v));
  });
}
test('strict v2 reader/constructor and rendered v2 output retain compatibility', () => {
  assert.equal(RESPONSE_CONTRACT_VERSION, 2); assert.throws(() => validateResponseEnvelope(envelope()));
  const v2 = createResponseEnvelope({ messageCandidate: { text: 'Ordinary reply.', language: 'en' } }, {
    requestId: 'request', source: { type: 'main', agentId: 'main', runId: 'run' }, status: 'success', results: [], pendingContext: null,
    lifecycle: { domainExecution: 'none', failure: null }, provenance: { executionVerified: 'not_applicable', completionCorrelated: false },
    responsePolicy: { preferredMode: 'pass_through', allowedModes: ['pass_through'] } });
  assert.throws(() => validateResponseV3Envelope(v2));
  assert.deepEqual(controlResponse(v2, settings).rendered, controlResponse(envelope(), options(envelope())).rendered);
  assert.equal(controlResponse(envelope(), options(envelope())).rendered?.schemaVersion, 2);
});
test('all per-domain outcomes, full metadata and conflicting pending contexts survive attributed composition', () => {
  const statuses = ['success', 'failure', 'partial', 'unknown', 'clarification_required', 'not_applicable'] as const;
  const values = statuses.map((status, index) => result(index % 2 ? 'reminder' : 'jessica-vacuum', {
    outcome: { status, disposition: status === 'failure' ? 'failed' : 'handled' },
    facts: { verified: status === 'success' ? true : status === 'not_applicable' ? 'not_applicable' : status === 'unknown' ? 'unknown' : false,
      verificationScope: status === 'not_applicable' ? [] : ['read'], data: { allFacts: [index, status] } },
    warnings: [{ code: 'QUALIFIED', message: `Warning ${index}` }], uncertainty: status === 'unknown' ? [{ code: 'UNRESOLVED' }] : [],
    failures: { domain: status === 'failure' ? { code: 'FAILED' } : null, handling: null },
    pendingContext: status === 'clarification_required' || status === 'partial' ? pending(String(index)) : null,
    content: { state: 'usable', language: 'en', text: `${status}: complete facts and warning ${index}.` },
  }));
  const v = envelope(values), o = options(v); const controlled = controlResponse(v, o);
  assert.equal(controlled.rendered?.message, values.map((r, i) => `${i + 1}. ${r.content?.state === 'usable' ? r.content.text : ''}`).join('\n\n'));
  assert.equal(v.results.filter(r => r.pendingContext).length, 2); assert.equal('pendingContext' in v, false);
  assert.deepEqual(v.results.map(r => r.facts.data), values.map(r => r.facts.data));
});
test('candidate must equal complete authorized text; lifecycle failure cannot erase known results', () => {
  const r = result(), v = envelope([r]);
  const forged = { ...v, messageCandidate: { text: 'Everything succeeded.', language: 'en' } };
  assert.equal(controlResponse(forged, options(validateResponseV3Envelope(forged))).mode, 'deterministic');
  const exact = { ...v, messageCandidate: r.content?.state === 'usable' ? { text: r.content.text, language: 'en' } : null };
  assert.equal(controlResponse(exact, options(validateResponseV3Envelope(exact))).mode, 'pass_through');
  const failed = envelope([r], { lifecycle: { domainExecution: 'uncertain', failure: { code: 'LATE_RUN_ERROR' } } });
  const text = controlResponse(failed, options(failed)).rendered?.message; assert(text); assert(text.includes('may have had effects')); assert(text.includes('Full jessica-vacuum result.'));
  const zero = envelope([], { lifecycle: { domainExecution: 'uncertain', failure: { code: 'RUN_FAILED' } } });
  assert.match(controlResponse(zero, options(zero)).rendered?.message ?? '', /will not repeat it automatically/);
});
for (const mode of ['missing', 'false', 'async', 'foreign', 'incomplete', 'revoked', 'renderer-missing', 'renderer-async', 'renderer-throws',
  'unavailable', 'pending-mismatch', 'overflow', 'inactive-modes'] as const) {
  test(`Controller fails closed: ${mode}`, () => {
    const v = envelope([result(), result('reminder')]); const o: Record<string, unknown> = { ...options(v) }; let checks = 0;
    if (mode === 'missing') delete o.assertResponseCurrent;
    if (mode === 'false') o.assertResponseCurrent = () => false;
    if (mode === 'async') o.assertResponseCurrent = async () => {};
    if (mode === 'foreign') o.assertResponseCurrent = (r: ResponseV3) => assert.equal(r.requestId, 'foreign');
    if (mode === 'incomplete') o.assertResponseCurrent = (r: ResponseV3) => assert.equal(r.results.length, 3);
    if (mode === 'revoked') o.assertResponseCurrent = () => ++checks === 1;
    if (mode === 'renderer-missing') delete o.renderDomainResult;
    if (mode === 'renderer-async') o.renderDomainResult = async () => ({ kind: 'rendered', text: 'Async', pendingContext: null });
    if (mode === 'renderer-throws') o.renderDomainResult = () => { throw Error('Renderer failed'); };
    if (mode === 'unavailable') o.renderDomainResult = () => ({ kind: 'unsupported', reason: 'no_safe_content' });
    if (mode === 'pending-mismatch') o.renderDomainResult = () => ({ kind: 'rendered', text: 'Unbound question', pendingContext: pending('foreign') });
    if (mode === 'overflow') o.renderDomainResult = () => ({ kind: 'rendered', text: 'x'.repeat(4096), pendingContext: null });
    const raw = mode === 'inactive-modes' ? { ...v, responsePolicy: { preferredMode: 'response_model', allowedModes: ['response_model', 'main_continuation'] } } : v;
    assert.throws(() => Reflect.apply(controlResponse, undefined, [raw, o]));
  });
}
test('domain read owners preserve prepared text and refuse unsupported material qualifications', () => {
  for (const [domain, renderer] of [['jessica-vacuum', renderJessicaDomainResult], ['reminder', renderReminderDomainResult]] as const) {
    const r = result(domain, domain === 'jessica-vacuum' ? { facts: { verified: true, verificationScope: ['status_read'],
      data: { kind: 'status', state: 'docked', batteryLevel: 90, observedAt: '2026-10-25T23:59:00Z',
        sourceUpdatedAt: null, freshness: 'fresh', activeSegments: [], currentSegment: null } } } : {});
    assert.equal(renderer(r, settings).kind, 'rendered');
    assert.equal(renderer(result(domain, { warnings: [{ code: 'REQUIRES_DOMAIN_PRESENTATION' }] }), settings).kind, 'unsupported');
    assert.equal(renderer(result(domain, { content: { state: 'unavailable', reason: { code: 'UNAVAILABLE', detail: 'No wording' } } }), settings).kind, 'unsupported');
    assert.equal(renderer(r, { language: 'he' }).kind, 'unsupported');
  }
});
for (const mode of ['positive', 'handoff-revocation', 'duplicate', 'transport-unknown', 'reentry'] as const) {
  test(`Main v3 final binding: ${mode}`, async () => {
    const v = envelope([result()]), sink: unknown[] = []; let checks = 0; let nested: Promise<void> | undefined;
    const delivery = createMainResponseDelivery({ requestId: 'request', agentId: 'main', runId: () => 'run', assertCurrent: () => true,
      responseFor: () => v, presentation: { ...options(v), assertResponseCurrent(r) {
        assert.deepEqual(r, v); checks++;
        if (mode === 'reentry' && checks === 1) { nested = delivery.deliver({}, { kind: 'final' }); nested.catch(() => {}); }
        if (mode === 'handoff-revocation' && checks === 3) return false;
        return true;
      } }, deliver: async p => { sink.push(p); if (mode === 'transport-unknown') throw Error('ACK lost'); } });
    if (mode === 'handoff-revocation' || mode === 'transport-unknown') await assert.rejects(delivery.deliver({}, { kind: 'final' }));
    else await delivery.deliver({ text: 'Unapproved final', mediaUrl: 'forbidden' }, { kind: 'final' });
    if (nested) await assert.rejects(nested, /already_settled/);
    assert.equal(sink.length, mode === 'handoff-revocation' ? 0 : 1);
    assert.equal(delivery.snapshot().outcome, mode === 'transport-unknown' ? 'unknown' : mode === 'handoff-revocation' ? 'blocked' : 'delivered');
    await assert.rejects(delivery.deliver({}, { kind: 'final' }), /already_settled/);
    assert.equal(sink.length, mode === 'handoff-revocation' ? 0 : 1);
    if (sink.length) assert.deepEqual(sink, [{ text: 'Full jessica-vacuum result.' }]);
  });
}

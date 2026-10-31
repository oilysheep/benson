import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompletionAuthority, acceptAgentCompletion, reconstructCompletion, validateCompletion,
  completionProposalSchema, type CompletionCustody } from '../core/completion.js';
import { BOUNDED_COMPLETION_SCHEMA_VERSION, COMPLETION_SCHEMA_VERSION, CURRENT_COMPLETION_SCHEMA_VERSION,
  SUCCESSOR_COMPLETION_SCHEMA_VERSION, type Binding6, type Completion6 } from '../core/completion-contracts.js';
import { createCompletionDomainResult } from '../core/domain-result.js';
import { renderJessicaDomainResult } from '../../../../agents/jessica-vacuum/lib/presentation.js';
import { createResponseV3Envelope } from '../core/legacy-response.js';
import { controlResponse } from '../core/response-control.js';

// Synthetic owner guards test the contract; they do not establish native authority.
function fixture() {
  const binding: Binding6 = { inputId: 'input', admissionId: 'admission', conversationId: 'conversation',
    runId: 'child-run', agentId: 'jessica-vacuum', sessionKey: 'agent:jessica-vacuum:child', sessionId: 'child-session',
    domain: 'jessica-vacuum', taskId: 'task', caller: { runId: 'parent-run', agentId: 'main',
      sessionKey: 'agent:main:parent', sessionId: 'parent-session' }, completionTarget: 'CALLER', authorizationId: 'original-grant',
    parentContinuation: { eligible: true, reason: null }, deliveryPolicy: { eligible: false, reason: null } };
  const facts: Completion6['facts'] = { domain: 'jessica-vacuum', domainSchemaVersion: '1', operation: 'status',
    status: 'success', verified: true, verificationScope: ['status_read'], data: { kind: 'status', state: 'docked', batteryLevel: 90,
      observedAt: '2026-10-26T08:00:00Z', sourceUpdatedAt: '2026-10-26T07:59:00Z', freshness: 'fresh', activeSegments: [], currentSegment: null },
    warnings: [], error: null, pendingContext: null, effects: [], uncertainty: [] };
  const state = { live: true, checks: 0, runId: binding.runId, terminal: true, callsComplete: true };
  const custody: CompletionCustody = { assertCurrent(value) {
    state.checks++; assert(state.live && state.terminal && state.callsComplete, 'custody unavailable');
    assert.equal(value.runId, state.runId); assert.equal(JSON.stringify(value), JSON.stringify(binding));
  } };
  const evidence = { schemaVersion: 6, kind: 'domain-task', binding, knownFacts: facts,
    results: [], coverage: 'complete', gaps: [], origin: 'agent' };
  const proposal = { schemaVersion: 6, kind: 'domain-task', facts,
    userResponse: { state: 'usable', text: 'Docked; battery 100%.', language: 'en' } };
  return { binding, facts, state, custody, evidence, proposal };
}
function accepted() {
  const f = fixture(), authority = createCompletionAuthority(f.evidence, f.custody);
  const record = acceptAgentCompletion(f.proposal, authority);
  return { ...f, authority, record };
}

test('explicit domain-only v6 preserves full facts, wording and DomainResultV2 without fabricated generations', () => {
  const f = accepted(); assert.equal(f.record.schemaVersion, BOUNDED_COMPLETION_SCHEMA_VERSION);
  assert.equal(f.record.completion.outcome, 'NORMAL');
  assert.deepEqual(JSON.parse(JSON.stringify(f.record.facts)), f.facts);
  assert.deepEqual(JSON.parse(JSON.stringify(f.record.userResponse)), f.proposal.userResponse);
  assert(!JSON.stringify(f.record).includes('Generation')); assert.deepEqual(f.record.results, []);
  assert(Object.isFrozen(f.record.binding)); assert(Object.isFrozen(f.record.facts.data));
  assert.deepEqual(validateCompletion(structuredClone(f.record), f.authority), f.record);
  const result = createCompletionDomainResult(f.record, f.authority, { expectedRunId: f.binding.runId });
  assert.equal(result.executionMode, 'agentic'); assert.equal(result.outcome.status, 'success');
  assert.deepEqual(result.facts.data, f.record.facts.data); assert.equal(JSON.stringify(result.content), JSON.stringify(f.record.userResponse));
  assert.deepEqual(JSON.parse(JSON.stringify(renderJessicaDomainResult(result, { language: 'en', now: '2026-10-26T08:00:30Z' }))),
    { kind: 'rendered', text: 'Jessica is docked with 90% battery.', pendingContext: null });
  assert.equal(renderJessicaDomainResult(result, { language: 'he' }).kind, 'unsupported');
  assert.equal(renderJessicaDomainResult({ ...result, warnings: [{ code: 'QUALIFIED', message: 'Do not omit.' }] }, { language: 'en' }).kind, 'unsupported');
  assert.equal(COMPLETION_SCHEMA_VERSION, 3); assert.equal(CURRENT_COMPLETION_SCHEMA_VERSION, 4);
  assert.equal(SUCCESSOR_COMPLETION_SCHEMA_VERSION, 5);
});

test('v6 verified facts, not contradictory agent wording, determine the authorized Response v3', () => {
  const f = fixture();
  const authority = createCompletionAuthority(f.evidence, f.custody);
  const record = acceptAgentCompletion({ ...f.proposal, userResponse: { state: 'usable', language: 'he',
    text: 'Jessica סיימה לנקות את כל הבית והסוללה מלאה.' } }, authority);
  const result = createCompletionDomainResult(record, authority);
  assert(record.userResponse.state === 'usable');
  const response = createResponseV3Envelope({ messageCandidate: { text: record.userResponse.text, language: record.userResponse.language } }, {
    requestId: 'request', source: { type: 'direct', executionMode: 'agentic', agentId: 'jessica-vacuum', runId: f.binding.runId },
    results: [result], lifecycle: { domainExecution: 'attempted', failure: null },
    responsePolicy: { preferredMode: 'pass_through', allowedModes: ['pass_through', 'deterministic', 'safe_failure'] } });
  const controlled = controlResponse(response, { language: 'he', now: '2026-10-26T08:01:00Z', timezone: 'Asia/Jerusalem',
    assertResponseCurrent(value) { f.custody.assertCurrent(f.binding); assert.deepEqual(value, response); },
    renderDomainResult: renderJessicaDomainResult });
  assert.equal(controlled.mode, 'deterministic');
  assert.match(controlled.rendered?.message ?? '', /docked.*90%/);
  assert(!controlled.rendered?.message.includes('כל הבית'));
  assert(!controlled.rendered?.message.includes('מלאה'));
  const malformed = { ...result, facts: { ...result.facts, data: { state: 'docked', batteryLevel: 90 } } };
  assert.equal(renderJessicaDomainResult(malformed, { language: 'he', now: '2026-10-26T08:01:00Z' }).kind, 'unsupported');
  for (const now of [undefined, 'invalid', '2026-10-26T07:59:59Z', '2026-10-26T08:01:01Z']) {
    assert.equal(renderJessicaDomainResult(result, { language: 'he', ...(now === undefined ? {} : { now }) }).kind, 'unsupported');
  }
});

test('v6 cannot be enabled by serialized evidence, missing/asynchronous custody or altered version semantics', async () => {
  const f = fixture();
  assert.throws(() => createCompletionAuthority(f.evidence), /live_custody_required/);
  for (const assertCurrent of [() => false, async () => { throw new Error('closed'); }]) {
    assert.throws(() => createCompletionAuthority(f.evidence, { assertCurrent }), /custody/);
  }
  const legacy = { ...f.evidence, schemaVersion: 5, binding: { ...f.binding, runGeneration: 1, sessionGeneration: 1,
    conversationGeneration: 1, caller: { ...f.binding.caller, runGeneration: 1, sessionGeneration: 1 } } };
  const oldAuthority = createCompletionAuthority(legacy);
  assert.throws(() => createCompletionAuthority(legacy, f.custody), /version_mismatch/);
  assert.throws(() => createCompletionAuthority({ ...f.evidence, binding: legacy.binding }, f.custody), /binding_shape/);
  assert.throws(() => createCompletionAuthority({ ...f.evidence, schemaVersion: 7 }, f.custody), /version_or_kind/);
  assert.throws(() => createCompletionAuthority({ ...f.evidence, kind: 'agent-run' }, f.custody), /native_evidence_invalid/);
  const current = accepted();
  assert.throws(() => validateCompletion(current.record, oldAuthority), /version_or_kind/);
  assert.throws(() => validateCompletion(current.record, {}), /authority_required/);
  assert.throws(() => createCompletionDomainResult(current.record, current.authority, { expectedRunId: 'foreign' }), /run_mismatch/);
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('all v6 production and consumption boundaries revalidate custody after cancellation, revocation or lost terminal evidence', async () => {
  for (const invalidate of [
    (state: ReturnType<typeof fixture>['state']) => { state.live = false; },
    (state: ReturnType<typeof fixture>['state']) => { state.runId = 'foreign-run'; },
    (state: ReturnType<typeof fixture>['state']) => { state.terminal = false; },
    (state: ReturnType<typeof fixture>['state']) => { state.callsComplete = false; },
  ]) {
    const f = accepted(); await Promise.resolve(); invalidate(f.state);
    for (const operation of [() => validateCompletion(f.record, f.authority),
      () => acceptAgentCompletion(f.proposal, f.authority), () => reconstructCompletion(f.authority),
      () => completionProposalSchema(f.authority), () => createCompletionDomainResult(f.record, f.authority)]) {
      assert.throws(operation);
    }
  }
  const f = fixture(); let checks = 0;
  assert.throws(() => createCompletionAuthority(f.evidence, { assertCurrent() {
    assert(++checks < 2, 'revoked during construction');
  } }), /revoked during construction/);
  const g = accepted();
  // The live callback is captured once; replacing its property cannot resurrect retired authority.
  g.state.live = false; g.custody.assertCurrent = () => {};
  assert.throws(() => validateCompletion(g.record, g.authority));
});

test('v6 revalidates after domain-owned effect projection and never converts possible/missing effects into none', () => {
  const f = fixture(); f.facts.effects = [{ kind: 'possibly_started' }]; f.facts.uncertainty = [{ kind: 'ack_lost' }];
  const authority = createCompletionAuthority(f.evidence, f.custody), record = acceptAgentCompletion(f.proposal, authority);
  assert.throws(() => createCompletionDomainResult(record, authority), /projection_required/);
  const effects = (details: readonly unknown[]) => ({ status: 'possible', refs: ['original-operation'], details,
    reconciliation: { required: true, reason: 'UNKNOWN_EFFECT' } });
  const projected = createCompletionDomainResult(record, authority, { projectEffects: effects });
  assert.equal(projected.effects.status, 'possible'); assert.equal(projected.effects.reconciliation.required, true);
  assert.equal(renderJessicaDomainResult(projected, { language: 'en' }).kind, 'unsupported');
  assert.throws(() => createCompletionDomainResult(record, authority, { projectEffects(details) {
    f.state.live = false; return effects(details);
  } }), /custody unavailable/);
  const g = fixture(); const { effects: _missing, ...knownFacts } = g.facts;
  const recovery = createCompletionAuthority({ ...g.evidence, knownFacts, coverage: 'incomplete', origin: 'runtime' }, g.custody);
  const failed = reconstructCompletion(recovery); assert.equal(failed.completion.outcome, 'FAILED');
  const outcome = createCompletionDomainResult(failed, recovery);
  assert.equal(outcome.effects.status, 'possible'); assert(outcome.effects.reconciliation.required);
  assert.throws(() => acceptAgentCompletion(g.proposal, recovery), /origin_mismatch/);
});

test('v6 rejects foreign ownership, ineligible continuation/delivery, nested or duplicate records and over-bound carriers', () => {
  const f = fixture();
  for (const binding of [ { ...f.binding, agentId: 'main' }, { ...f.binding, taskId: null },
    { ...f.binding, caller: null }, { ...f.binding, caller: { ...f.binding.caller, runId: f.binding.runId } },
    { ...f.binding, completionTarget: 'NATIVE' },
    { ...f.binding, deliveryPolicy: { eligible: true, reason: null } },
    { ...f.binding, runGeneration: 1 } ]) {
    assert.throws(() => createCompletionAuthority({ ...f.evidence, binding }, f.custody));
  }
  const value = accepted();
  for (const results of [[value.record], [value.record, value.record]]) {
    assert.throws(() => createCompletionAuthority({ ...f.evidence, results }, f.custody));
  }
  assert.throws(() => createCompletionAuthority({ ...f.evidence,
    knownFacts: { ...f.facts, data: Array(17).fill('x'.repeat(16384)) } }, f.custody), /bytes_exceeded|array_bound/);
  assert.throws(() => acceptAgentCompletion({ ...value.proposal, userResponse: { ...value.proposal.userResponse, text: 'x'.repeat(4097) } }, value.authority));
});

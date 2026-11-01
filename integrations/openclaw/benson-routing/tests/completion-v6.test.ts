import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompletionAuthority, acceptAgentCompletion, reconstructCompletion, validateCompletion,
  completionProposalSchema, settleNativeDomainCompletion, type CompletionCustody } from '../core/completion.js';
import { MAX_BYTES, MAX_WARNINGS } from '../core/value.js';
import { BOUNDED_COMPLETION_SCHEMA_VERSION, COMPLETION_SCHEMA_VERSION, CURRENT_COMPLETION_SCHEMA_VERSION,
  SUCCESSOR_COMPLETION_SCHEMA_VERSION, type Binding6, type Completion6 } from '../core/completion-contracts.js';
import { createCompletionDomainResult, createCompletionDomainResultV3 } from '../core/domain-result.js';
import { renderJessicaDomainResult } from '../../../../agents/jessica-vacuum/lib/presentation.js';
import { createResponseV3Envelope } from '../core/legacy-response.js';
import { controlResponse } from '../core/response-control.js';
import { normalizeJessicaCompletion, createJessicaCompletionToolFactory } from '../../plugins/benson-jessica-tool/src/completion.js';

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
function native() {
    const f = accepted(), value = { schemaVersion: '1' as const, domain: 'jessica-vacuum' as const,
      operation: f.facts.operation, status: f.facts.status, verified: f.facts.verified,
      data: f.facts.data, warnings: f.facts.warnings, error: f.facts.error, pendingContext: null };
    const result = { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
    return { f, input: { binding: f.binding, knownFacts: f.facts,
      tool: { runId: f.binding.runId, sessionKey: f.binding.sessionKey, sessionId: f.binding.sessionId, callId: 'tool-call', name: 'jessica_read' as const, value },
      after: { runId: f.binding.runId, callId: 'tool-call', value: result, error: undefined as string | undefined },
      terminal: { runId: f.binding.runId, sessionKey: f.binding.sessionKey, sessionId: f.binding.sessionId, success: true,
        messages: [
          { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-call', name: 'jessica_read' }] },
          { role: 'toolResult', toolCallId: 'tool-call', toolName: 'jessica_read', ...result },
          { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(f.proposal) }] },
        ] as unknown[] }, custody: f.custody } };
  }
test('native Jessica Completion adapter binds actual tool/terminal evidence and retains live source custody', async () => {
  const f = native();
  // Native wrappers may carry optional metadata outside the domain JSON.
  Reflect.set(f.input.after.value, 'optionalNativeMetadata', undefined);
  Reflect.set(f.input.tool, 'nativeGuard', () => { throw new Error('Host callbacks are not observation data'); });
  const acceptedNative = normalizeJessicaCompletion(f.input);
  assert.deepEqual(JSON.parse(JSON.stringify(acceptedNative.result.facts.data)), f.input.tool.value.data);
  const factory = createJessicaCompletionToolFactory({ async readNativeCompletion() { return f.input; },
    jsonResult: value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }) });
  const caller = f.input.binding.caller; assert(caller);
  const context = { agentId: 'main', sessionKey: caller.sessionKey, sessionId: caller.sessionId,
    assertInvocationCurrent() { assert(f.f.state.live); } };
  assert.equal(factory({ ...context, agentId: 'jessica-vacuum' }), null);
  const tool = factory(context); assert(tool && !Array.isArray(tool));
  assert.deepEqual((await tool.execute('validate', { runId: f.input.binding.runId })).details, { validated: true, result: acceptedNative.result });
  await assert.rejects(tool.execute('duplicate', { runId: f.input.binding.runId }));
  const foreign = factory({ ...context, sessionId: 'foreign-parent' }); assert(foreign && !Array.isArray(foreign));
  await assert.rejects(foreign.execute('foreign', { runId: f.input.binding.runId }));
  f.f.state.live = false; assert.throws(() => validateCompletion(acceptedNative.record, acceptedNative.authority));
  f.input.custody = { assertCurrent() {} };
  assert.throws(() => validateCompletion(acceptedNative.record, acceptedNative.authority), /custody unavailable/);
  for (const mode of ['run', 'oversized-foreign-run', 'session', 'error', 'changed-tool', 'duplicate', 'reordered', 'false-custody', 'async-custody', 'known-facts', 'unknown-version', 'converted-carrier'] as const) {
    const g = native();
    if (mode === 'run') g.input.terminal.runId = 'foreign';
    if (mode === 'oversized-foreign-run') {
      g.input.terminal.runId = 'foreign';
      g.input.terminal.messages[2] = { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(16385) }] };
    }
    if (mode === 'session') g.input.tool.sessionId = 'foreign';
    if (mode === 'error') g.input.after.error = 'native tool failed';
    if (mode === 'changed-tool') g.input.after.value.details = { ...g.input.after.value.details, operation: 'foreign' };
    if (mode === 'duplicate') g.input.terminal.messages.splice(2, 0, g.input.terminal.messages[1]);
    if (mode === 'reordered') [g.input.terminal.messages[0], g.input.terminal.messages[1]] = [g.input.terminal.messages[1], g.input.terminal.messages[0]];
    if (mode === 'false-custody') g.input.custody = { assertCurrent() { return false; } };
    if (mode === 'async-custody') g.input.custody = { async assertCurrent() {} };
    if (mode === 'known-facts') g.input.knownFacts.data = { invented: true };
    if (mode === 'unknown-version') Reflect.set(g.input.tool.value, 'schemaVersion', '2');
    if (mode === 'converted-carrier') Reflect.set(g.input.tool, 'value', createCompletionDomainResult(g.f.record, g.f.authority));
    assert.throws(() => normalizeJessicaCompletion(g.input), mode);
  }
});

test('mutation reporting failure preserves verified effects in controlled UNKNOWN settlement without replay', () => {
  for (const fault of ['malformed', 'oversized', 'uncertainty-capacity', 'missing', 'terminal-error', 'foreign-facts'] as const) {
    const g = native();
    const details = [{ kind: 'jessica-dispatch', operationId: 'original-operation', verified: true }];
    g.input.tool.name = 'jessica_execute' as typeof g.input.tool.name;
    g.input.tool.value.operation = 'clean'; g.input.tool.value.data = { operationId: 'original-operation' };
    g.input.knownFacts.operation = 'clean'; g.input.knownFacts.data = g.input.tool.value.data; g.input.knownFacts.effects = details;
    if (fault === 'uncertainty-capacity') g.input.knownFacts.uncertainty = Array.from({ length: 64 }, (_, i) => ({ code: 'EXISTING_UNCERTAINTY', detail: `Retained domain observation ${i}` }));
    const carrier = { content: [{ type: 'text', text: JSON.stringify(g.input.tool.value) }], details: g.input.tool.value };
    g.input.after.value = carrier;
    g.input.terminal.messages = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-call', name: 'jessica_execute' }] },
      { role: 'toolResult', toolCallId: 'tool-call', toolName: 'jessica_execute', ...carrier },
      { role: 'assistant', content: [{ type: 'text', text: fault === 'foreign-facts'
        ? JSON.stringify({ ...g.f.proposal, facts: { ...g.f.proposal.facts, data: { invented: true } } }) : '{bad json' }] },
    ];
    if (fault === 'missing') g.input.terminal.messages.pop();
    if (fault === 'oversized') g.input.terminal.messages[2] = { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(16385) }] };
    if (fault === 'terminal-error') g.input.terminal.success = false;
    const recovered = normalizeJessicaCompletion({ ...g.input, tool: { ...g.input.tool, name: 'jessica_execute' }, projectEffects: effects => ({
      status: 'known', refs: ['original-operation'], details: effects, reconciliation: { required: false, reason: null },
    }) });
    assert.equal(recovered.record.completion.outcome, 'FAILED'); assert.equal(recovered.record.facts.status, 'unknown');
    assert.equal(recovered.result.outcome.disposition, 'unresolved'); assert.equal(recovered.result.outcome.status, 'unknown');
    assert.deepEqual(JSON.parse(JSON.stringify(recovered.result.effects.details)), details);
    assert.deepEqual(recovered.result.effects.refs, ['original-operation']); assert.equal(recovered.result.effects.status, 'known');
    assert.equal(recovered.record.userResponse.state, 'unavailable');
    assert.deepEqual(JSON.parse(JSON.stringify(recovered.result.uncertainty)), g.input.knownFacts.uncertainty);
    if (fault === 'uncertainty-capacity') {
      assert.deepEqual(JSON.parse(JSON.stringify(recovered.result.uncertainty)), g.input.knownFacts.uncertainty);
      assert(recovered.result.evidence.gaps.some(gap => gap.code === 'REPORT'));
    }
    const response = createResponseV3Envelope({ messageCandidate: null }, {
      requestId: 'request', source: { type: 'main', agentId: 'main', runId: 'parent-run' }, results: [recovered.result],
      lifecycle: { domainExecution: 'uncertain', failure: null },
      responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic', 'safe_failure'] },
    });
    const controlled = controlResponse(response, { language: 'he', now: '2026-10-26T08:01:00Z', timezone: 'Asia/Jerusalem',
      assertResponseCurrent() { validateCompletion(recovered.record, recovered.authority); }, renderDomainResult: renderJessicaDomainResult });
    assert.equal(controlled.mode, 'deterministic'); assert.match(controlled.rendered?.message ?? '', /לא אבצע.*שוב אוטומטית/u);
    g.f.state.live = false;
    assert.throws(() => validateCompletion(recovered.record, recovered.authority));
  }
});

test('native recovery is nonexpanding for accepted byte/count boundaries and preserves all authoritative facts', () => {
  const unavailable = { state: 'unavailable' as const, reason: { code: 'RUNTIME_WORDING_UNAVAILABLE',
    detail: 'No owner-authored usable message is retained.' } };
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const classes = [
    { status: 'success', count: 0, atom: 'x' }, { status: 'partial', count: MAX_WARNINGS, atom: 'א' },
    { status: 'failure', count: MAX_WARNINGS, atom: '\n' }, { status: 'unknown', count: MAX_WARNINGS, atom: '😀' },
  ] as const;
  for (const { status, count, atom } of classes) for (const budget of [MAX_BYTES - 1, MAX_BYTES]) {
    for (const success of [true, false]) {
      const g = native(), facts = g.input.knownFacts;
      facts.status = status;
      facts.effects = Array.from({ length: count || 1 }, (_, i) => ({ ref: `effect-${i}`, possible: true }));
      facts.uncertainty = Array.from({ length: count }, (_, i) => ({ code: 'EXISTING_UNCERTAINTY', detail: `Keep ${i}` }));
      facts.warnings = Array.from({ length: count }, (_, i) => ({ code: 'EXISTING_WARNING', detail: `Keep ${i}` }));
      facts.verificationScope = Array.from({ length: count || 1 }, (_, i) => `scope-${i}`);
      facts.error = status === 'failure' ? { code: 'DOMAIN_FAILURE', detail: 'Preserve the domain failure.' } : null;
      const padding = Array.from({ length: 256 }, () => '');
      facts.data = { padding };
      const baseline = { schemaVersion: 6, kind: 'domain-task', binding: g.input.binding, facts,
        results: [], userResponse: unavailable, completion: { outcome: 'NORMAL', gaps: [] } };
      let remaining = budget - size(baseline);
      const atomBytes = size(atom) - 2;
      for (let i = 0; i < padding.length && remaining; i++) {
        const n = Math.min(Math.floor(16384 / atom.length), Math.floor(remaining / atomBytes));
        padding[i] = atom.repeat(n); remaining -= n * atomBytes;
        if (remaining < atomBytes && padding[i]!.length < 16384) {
          padding[i] += 'x'.repeat(remaining); remaining = 0;
        }
      }
      assert.equal(remaining, 0); assert.equal(size(baseline), budget);
      const authority = createCompletionAuthority({ ...g.f.evidence, knownFacts: facts }, g.f.custody);
      const accepted = acceptAgentCompletion({ ...g.f.proposal, facts, userResponse: unavailable }, authority);
      assert.equal(size(accepted), budget, 'the exact boundary payload is accepted before recovery');
      Object.assign(g.input.tool.value, { status, data: facts.data, warnings: facts.warnings, error: facts.error });
      const carrier = { content: [{ type: 'text', text: JSON.stringify(g.input.tool.value) }], details: g.input.tool.value };
      g.input.after.value = carrier;
      g.input.terminal.success = success;
      g.input.terminal.messages = [
        { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-call', name: 'jessica_read' }] },
        { role: 'toolResult', toolCallId: 'tool-call', toolName: 'jessica_read', ...carrier },
        { role: 'assistant', content: [{ type: 'text', text: '{bad json' }] },
      ];
      const original = JSON.stringify(facts);
      const recovered = settleNativeDomainCompletion(g.input);
      assert.equal(recovered.record.completion.outcome, 'FAILED');
      assert.deepEqual(JSON.parse(JSON.stringify(recovered.record.facts)), { ...JSON.parse(original), status: 'unknown' });
      assert.equal(JSON.stringify(facts), original, 'recovery never mutates authoritative evidence');
      assert(size(recovered.record) <= size(accepted), 'recovery never consumes more bytes than its accepted baseline');
      assert.equal(recovered.record.completion.gaps.length, 1);
      assert.equal(recovered.record.completion.gaps[0]?.code, success ? 'REPORT' : 'RUN');
      assert.equal(recovered.record.userResponse.state, 'unavailable');
      const result = createCompletionDomainResultV3(recovered.record, recovered.authority, { projectEffects: details => ({
        status: 'possible', refs: [], details, reconciliation: { required: true, reason: 'EFFECT_ACK_UNKNOWN' },
      }) });
      assert.equal(result.effects.status, 'possible'); assert(result.effects.reconciliation.required);
      assert.equal(result.effects.reconciliation.reason, 'EFFECT_ACK_UNKNOWN');
      assert.equal(JSON.stringify(result.effects.details), JSON.stringify(recovered.record.facts.effects));
      assert.equal(result.outcome.status, 'unknown');
      assert.equal(renderJessicaDomainResult(result, { language: 'en' }).kind, count ? 'unsupported' : 'rendered',
        'warnings remain authoritative and cannot disappear into generic wording');
      const forged = JSON.parse(JSON.stringify(recovered.record));
      forged.userResponse.reason.detail = 'It worked.';
      assert.throws(() => validateCompletion(forged, recovered.authority), /completion_runtime_response_mismatch/);
      if (budget === MAX_BYTES) {
        const oversized = structuredClone(facts);
        assert(oversized.data && typeof oversized.data === 'object' && !Array.isArray(oversized.data));
        const more = oversized.data.padding; assert(Array.isArray(more));
        const index = more.findIndex(item => typeof item === 'string' && item.length < 16384);
        assert(index >= 0); more[index] += 'x';
        assert.throws(() => createCompletionAuthority({ ...g.f.evidence, knownFacts: oversized }, g.f.custody), /json_bytes_exceeded/);
      }
      g.f.state.live = false;
      assert.throws(() => validateCompletion(recovered.record, recovered.authority), /custody unavailable/);
    }
  }
});

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

test('Jessica adapter rejects unknown result-version opt-in without silent legacy fallback', () => {
  const g = native(); Reflect.set(g.input, 'resultVersion', 99);
  assert.throws(() => normalizeJessicaCompletion(g.input), /domain_result_version/);
});

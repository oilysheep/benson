import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReminderCompletion, runReminderNativeTask } from '../src/completion.js';
import { normalizeReminderServiceResult } from '../../../../../agents/reminder-service/lib/results.js';
import { renderReminderDomainResult } from '../../../../../agents/reminder-service/lib/presentation.js';
import { createResponseV3Envelope, createResponseV4Envelope } from '../../../benson-routing/core/legacy-response.js';
import { controlResponse } from '../../../benson-routing/core/response-control.js';
import { validateCompletion, createCompletionAuthority, acceptAgentCompletion } from '../../../benson-routing/core/completion.js';
import { createCompletionDomainResultV3 } from '../../../benson-routing/core/domain-result.js';
import { MAX_BYTES, MAX_WARNINGS } from '../../../benson-routing/core/value.js';
import { createCurrentRequestContext } from '../../../benson-routing/core/conversation-context.js';
import { loadIdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';

function fixture() {
  const state = { live: true, launches: 0, waits: 0 };
  const binding: Parameters<typeof normalizeReminderCompletion>[0]['binding'] = {
    inputId: 'original-input', admissionId: 'original-input', conversationId: 'conversation', runId: 'actual-child',
    agentId: 'reminder-service', sessionKey: 'agent:reminder-service:subagent:isolated', sessionId: 'actual-child-session',
    domain: 'reminder', taskId: 'actual-task', caller: { runId: 'actual-main', agentId: 'main', sessionKey: 'main-session', sessionId: 'main-id' },
    completionTarget: 'CALLER', authorizationId: 'original-input', parentContinuation: { eligible: true, reason: null },
    deliveryPolicy: { eligible: false, reason: null },
  };
  const raw = { status: 'success', operation: 'delete', transaction: { status: 'success', verified: true },
    data: { reminderIds: ['existing'], record: { reminderId: 'existing', content: 'fixture', status: 'deleted' } }, transport: { deliveries: [] }, warnings: [] };
  const value = normalizeReminderServiceResult('delete-reminder', raw, { taskId: binding.taskId, pendingBinding: null, pendingExpiresAt: null });
  const effects = [{ kind: 'reminder-delete', reminderId: 'existing', verified: true }];
  const facts = { domain: value.domain, domainSchemaVersion: value.domainSchemaVersion, operation: value.operation, status: value.status,
    verified: value.verified, verificationScope: ['reminder_transaction'], data: value.data, warnings: value.warnings, error: value.error,
    pendingContext: value.pendingContext, effects, uncertainty: [] };
  const carrier = { content: [{ type: 'text', text: JSON.stringify(raw) }], details: raw };
  const input: Parameters<typeof normalizeReminderCompletion>[0] = { binding, operation: 'delete-reminder',
    tool: { runId: binding.runId, sessionKey: binding.sessionKey, sessionId: binding.sessionId, callId: 'actual-call', name: 'benson_reminder_delete', value: raw },
    after: { runId: binding.runId, callId: 'actual-call', value: carrier, error: undefined },
    terminal: { runId: binding.runId, sessionKey: binding.sessionKey, sessionId: binding.sessionId, success: true, messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'actual-call', name: 'benson_reminder_delete' }] },
      { role: 'toolResult', toolCallId: 'actual-call', toolName: 'benson_reminder_delete', ...carrier },
      { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 6, kind: 'domain-task', facts,
        userResponse: { state: 'unavailable', reason: { code: 'DOMAIN_RENDERING_REQUIRED', detail: 'Use domain facts' } } }) }] },
    ] }, effects: { status: 'known', refs: ['existing'], details: effects, reconciliation: { required: false, reason: null } }, uncertainty: [],
    custody: { assertCurrent() { assert(state.live, 'source retired'); } },
  };
  return { input, state, raw };
}

test('Reminder Completion consumes unchanged raw transaction and preserves effects through reporting errors', () => {
  for (const fault of ['none', 'malformed', 'oversized', 'terminal-error'] as const) {
    const f = fixture(), original = JSON.stringify(f.raw);
    if (fault === 'malformed') f.input.terminal.messages[2] = { role: 'assistant', content: [{ type: 'text', text: '{bad json' }] };
    if (fault === 'oversized') f.input.terminal.messages[2] = { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(16385) }] };
    if (fault === 'terminal-error') f.input.terminal.success = false;
    const result = normalizeReminderCompletion(f.input);
    assert.equal(JSON.stringify(f.raw), original);
    assert.equal(result.result.outcome.status, fault === 'none' ? 'success' : 'unknown');
    assert.equal(result.completion.completion.outcome, fault === 'none' ? 'NORMAL' : 'FAILED');
    assert.deepEqual(result.effects.refs, ['existing']); assert.deepEqual(JSON.stringify(result.effects.details), JSON.stringify(f.input.effects.details));
    const response = createResponseV3Envelope({ messageCandidate: null }, { requestId: 'original-input',
      source: { type: 'main', agentId: 'main', runId: 'actual-main' }, results: [result.result],
      lifecycle: { domainExecution: fault === 'none' ? 'attempted' : 'uncertain', failure: null },
      responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic'] } });
    const controlled = controlResponse(response, { language: 'he', now: '2026-11-01T08:00:00Z', timezone: 'Asia/Jerusalem',
      assertResponseCurrent() { validateCompletion(result.completion, result.authority); }, renderDomainResult: renderReminderDomainResult });
    assert.equal(controlled.mode, 'deterministic');
    assert.match(controlled.rendered?.message ?? '', fault === 'none' ? /נמחקה/u : /לא אבצע.*שוב אוטומטית/u);
    f.state.live = false; f.input.custody.assertCurrent = () => {};
    assert.throws(() => validateCompletion(result.completion, result.authority), /source retired/);
  }
  for (const fault of ['foreign-run', 'changed-carrier', 'unverified', 'duplicate', 'retired'] as const) {
    const f = fixture();
    if (fault === 'foreign-run') f.input.tool.runId = 'foreign';
    if (fault === 'changed-carrier') f.input.after.value = { details: {} };
    if (fault === 'unverified') f.raw.transaction.verified = false;
    if (fault === 'duplicate') f.input.terminal.messages.splice(2, 0, f.input.terminal.messages[1]);
    if (fault === 'retired') f.state.live = false;
    assert.throws(() => normalizeReminderCompletion(f.input), fault);
  }
});

test('Reminder reporting recovery preserves original uncertainty at schema capacity', () => {
  for (const count of [1, 64]) for (const fault of ['none', 'malformed', 'terminal-error'] as const) {
    const f = fixture();
    const uncertainty = Array.from({ length: count }, (_, i) => ({ code: 'EXISTING_UNCERTAINTY', detail: `Retained domain observation ${i}` }));
    f.input.uncertainty = uncertainty;
    const final = f.input.terminal.messages[2] as { content: [{ text: string }] };
    const proposal = JSON.parse(final.content[0].text);
    proposal.facts.uncertainty = uncertainty;
    f.input.terminal.messages[2] = { role: 'assistant', content: [{ type: 'text', text: fault === 'malformed' ? '{bad json' : JSON.stringify(proposal) }] };
    if (fault === 'terminal-error') f.input.terminal.success = false;
    const result = normalizeReminderCompletion(f.input);
    assert.equal(result.result.outcome.status, fault === 'none' ? 'success' : 'unknown');
    assert.deepEqual(JSON.parse(JSON.stringify(result.completion.facts.uncertainty)), uncertainty);
    assert.deepEqual(JSON.parse(JSON.stringify(result.result.uncertainty)), uncertainty);
    assert.deepEqual(result.effects.refs, ['existing']);
    assert.equal(JSON.stringify(result.effects.details), JSON.stringify(f.input.effects.details));
    if (fault !== 'none') {
      const code = fault === 'terminal-error' ? 'RUN' : 'REPORT';
      assert.equal(result.completion.completion.outcome, 'FAILED');
      assert(result.result.evidence.gaps.some(gap => gap.code === code && gap.path === 'run'));
      const response = createResponseV3Envelope({ messageCandidate: null }, { requestId: 'original-input',
        source: { type: 'main', agentId: 'main', runId: 'actual-main' }, results: [result.result],
        lifecycle: { domainExecution: 'uncertain', failure: null },
        responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic'] } });
      const controlled = controlResponse(response, { language: 'en', now: '2026-11-01T08:00:00Z', timezone: 'Asia/Jerusalem',
        assertResponseCurrent() { validateCompletion(result.completion, result.authority); }, renderDomainResult: renderReminderDomainResult });
      assert.equal(controlled.mode, 'deterministic'); assert.match(controlled.rendered?.message ?? '', /will not repeat/u);
    }
    f.state.live = false;
    assert.throws(() => validateCompletion(result.completion, result.authority), /source retired/);
  }
});

test('Reminder full-byte recovery retains known/possible effect projections at maximum count', () => {
  for (const status of ['known', 'possible'] as const) {
    const f = fixture();
    const projection = { status,
      refs: Array.from({ length: MAX_WARNINGS }, (_, i) => `effect-${i}`),
      details: Array.from({ length: MAX_WARNINGS }, (_, i) => ({ ref: `effect-${i}`, verified: status === 'known' })),
      reconciliation: { required: status === 'possible', reason: status === 'possible' ? 'EFFECT_ACK_UNKNOWN' : null } };
    f.input.effects = projection;
    const padding = Array.from({ length: 16 }, () => '');
    Reflect.set(f.raw.data, 'padding', padding);
    const final = f.input.terminal.messages[2] as { content: [{ text: string }] };
    const proposal = JSON.parse(final.content[0].text);
    proposal.facts.data = normalizeReminderServiceResult('delete-reminder', f.raw,
      { taskId: f.input.binding.taskId, pendingBinding: null, pendingExpiresAt: null }).data;
    proposal.facts.effects = projection.details;
    proposal.facts.uncertainty = Array.from({ length: MAX_WARNINGS }, (_, i) => ({ code: 'DOMAIN_UNCERTAINTY', detail: `Keep ${i}` }));
    f.input.uncertainty = proposal.facts.uncertainty;
    const unavailable = { state: 'unavailable', reason: { code: 'RUNTIME_WORDING_UNAVAILABLE',
      detail: 'No owner-authored usable message is retained.' } };
    const baseline = { schemaVersion: 6, kind: 'domain-task', binding: f.input.binding, facts: proposal.facts,
      results: [], userResponse: unavailable, completion: { outcome: 'NORMAL', gaps: [] } };
    let remaining = MAX_BYTES - Buffer.byteLength(JSON.stringify(baseline));
    for (let i = 0; i < padding.length && remaining; i++) {
      padding[i] = 'x'.repeat(Math.min(16384, remaining)); remaining -= padding[i]!.length;
    }
    assert.equal(remaining, 0);
    // Normalization copies the original carrier; refresh its exact facts after padding.
    proposal.facts.data = normalizeReminderServiceResult('delete-reminder', f.raw,
      { taskId: f.input.binding.taskId, pendingBinding: null, pendingExpiresAt: null }).data;
    const authority = createCompletionAuthority({ schemaVersion: 6, kind: 'domain-task', binding: f.input.binding,
      knownFacts: proposal.facts, results: [], coverage: 'complete', gaps: [], origin: 'agent' }, f.input.custody);
    const accepted = acceptAgentCompletion({ ...proposal, userResponse: unavailable }, authority);
    assert.equal(Buffer.byteLength(JSON.stringify(accepted)), MAX_BYTES);
    const normal = createCompletionDomainResultV3(accepted, authority, { projectEffects: () => projection });
    assert.deepEqual(JSON.parse(JSON.stringify(normal.effects)), projection);
    assert.equal(JSON.stringify(normal.facts.data), JSON.stringify(proposal.facts.data));
    const carrier = { content: [{ type: 'text', text: JSON.stringify(f.raw) }], details: f.raw };
    f.input.after.value = carrier;
    f.input.terminal.messages[1] = { role: 'toolResult', toolCallId: 'actual-call', toolName: 'benson_reminder_delete', ...carrier };
    f.input.terminal.messages[2] = { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ ...proposal, userResponse: unavailable }) }] };
    const nativeNormal = normalizeReminderCompletion({ ...f.input, resultVersion: 3 });
    assert.equal(nativeNormal.completion.completion.outcome, 'NORMAL');
    assert.equal(Buffer.byteLength(JSON.stringify(nativeNormal.completion)), MAX_BYTES);
    assert.deepEqual(JSON.parse(JSON.stringify(nativeNormal.result.effects)), projection);
    assert.equal(JSON.stringify(nativeNormal.result.facts.data), JSON.stringify(proposal.facts.data));
    f.input.terminal.messages[2] = { role: 'assistant', content: [{ type: 'text', text: '{bad json' }] };
    const recovered = normalizeReminderCompletion({ ...f.input, resultVersion: 3 });
    assert.equal(recovered.completion.completion.outcome, 'FAILED');
    assert.deepEqual(JSON.parse(JSON.stringify(recovered.result.effects)), projection);
    assert.equal(JSON.stringify(recovered.result.facts.data), JSON.stringify(proposal.facts.data));
    assert.equal(JSON.stringify(recovered.result.uncertainty), JSON.stringify(f.input.uncertainty));
    assert.equal(renderReminderDomainResult(recovered.result, { language: 'en' }).kind, 'rendered');
    const response = createResponseV4Envelope({ messageCandidate: null }, { requestId: 'א'.repeat(512),
      source: { type: 'main', agentId: 'main', runId: '😀'.repeat(256) }, results: Array(16).fill(recovered.result),
      lifecycle: { domainExecution: 'attempted', failure: null },
      responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic'] } });
    assert.equal(response.results.length, 16);
    const controlled = controlResponse(response, { language: 'en', now: '2026-11-01T08:00:00Z', timezone: 'Asia/Jerusalem',
      assertResponseCurrent() { validateCompletion(recovered.completion, recovered.authority); }, renderDomainResult: renderReminderDomainResult });
    assert.match(controlled.rendered?.message ?? '', /will not repeat/);
    f.state.live = false;
    assert.throws(() => controlResponse(response, { language: 'en', now: '2026-11-01T08:00:00Z', timezone: 'Asia/Jerusalem',
      assertResponseCurrent() { validateCompletion(recovered.completion, recovered.authority); }, renderDomainResult: renderReminderDomainResult }), /source retired/);
  }
});

test('Reminder native Completion bounds the JSON carrier in UTF-8 bytes and logical strings independently', () => {
  for (const unit of ['x', 'א', '😀', '\n', '\0', '\ud800']) {
    const f = fixture();
    const padding = Array(2).fill(unit.repeat(Math.floor(16384 / unit.length)));
    Reflect.set(f.raw.data, 'padding', padding);
    const final = f.input.terminal.messages[2] as { content: [{ text: string }] };
    const proposal = JSON.parse(final.content[0].text);
    proposal.facts.data = normalizeReminderServiceResult('delete-reminder', f.raw,
      { taskId: f.input.binding.taskId, pendingBinding: null, pendingExpiresAt: null }).data;
    const carrier = { content: [{ type: 'text', text: JSON.stringify(f.raw) }], details: f.raw };
    f.input.after.value = carrier;
    f.input.terminal.messages[1] = { role: 'toolResult', toolCallId: 'actual-call', toolName: 'benson_reminder_delete', ...carrier };
    const report = JSON.stringify(proposal);
    assert(report.length > 16384 && Buffer.byteLength(report, 'utf8') <= MAX_BYTES);
    for (const fault of ['none', 'carrier-overflow', 'invalid-logical-string', 'utf8-overflow'] as const) {
      let text = report;
      if (fault === 'carrier-overflow') text += ' '.repeat(MAX_BYTES + 1 - Buffer.byteLength(text, 'utf8'));
      if (fault === 'invalid-logical-string') text = JSON.stringify({ ...proposal, userResponse: {
        state: 'unavailable', reason: { code: 'UNKNOWN', detail: 'x'.repeat(16385) } } });
      if (fault === 'utf8-overflow') {
        text = JSON.stringify({ ...proposal, extra: 'א'.repeat(Math.ceil((MAX_BYTES - Buffer.byteLength(report, 'utf8')) / 2) + 512) });
        assert(text.length <= MAX_BYTES && Buffer.byteLength(text, 'utf8') > MAX_BYTES);
      }
      f.input.terminal.messages[2] = { role: 'assistant', content: [{ type: 'text', text }] };
      const result = normalizeReminderCompletion({ ...f.input, resultVersion: 3 });
      assert.equal(result.completion.completion.outcome, fault === 'none' ? 'NORMAL' : 'FAILED');
      assert.equal(result.result.outcome.status, fault === 'none' ? 'success' : 'unknown');
      assert.equal(JSON.stringify(result.result.facts.data), JSON.stringify(proposal.facts.data));
      assert.deepEqual(result.effects.refs, ['existing']);
      assert.equal(JSON.stringify(result.effects.details), JSON.stringify(f.input.effects.details));
      if (fault !== 'none') assert(result.result.evidence.gaps.some(gap => gap.code === 'REPORT'));
    }
  }
});

test('Reminder product producer binds native launch, original input, caller and terminal observation', async () => {
  for (const fault of ['none', 'foreign-receipt', 'foreign-terminal', 'timeout-only', 'retired', 'false-custody'] as const) {
    const f = fixture(), abort = new AbortController();
    const source = createCurrentRequestContext({ request: 'Delete the existing reminder.',
      binding: { conversationRef: 'conversation', channel: 'whatsapp', accountId: 'fixture', kind: 'direct', peerId: 'peer', threadId: null, requesterId: 'peer' },
      currentTurn: () => ({ entryId: 'original-input', role: 'user', text: 'Delete the existing reminder.',
        sender: { source: 'canonical_peer_binding', id: 'peer', channel: 'whatsapp', accountId: 'fixture' }, inputProvenance: { kind: 'external_user' } }),
      assertCurrent() { assert(f.state.live); }, assertAuthorized() { assert(f.state.live); },
    }).projectCurrentRequest();
    assert.equal(source.status, 'available');
    const identities = loadIdentityContract({ accountId: 'fixture', trustedRequesterIds: ['reader'], recipients: [{ id: 'reader', type: 'person', channel: 'whatsapp', to: 'peer' }] });
    const promise = runReminderNativeTask({ kind: 'benson.self-contained-request', version: 1, request: source.context.current.text }, {
      callId: 'actual-task', source, deps: { identities, route: { requesterId: 'reader', senderId: 'peer', sourceId: 'peer', sourceType: 'private' },
        authority: { signal: abort.signal, assertCurrent() { assert(f.state.live); return fault !== 'false-custody'; } },
        transaction: { async execute() { throw new Error('No transaction replay'); } },
        evidence: { async readCurrentUserText() { return source.context.current.text; }, async readOriginalUserTurns() { return []; } } },
    }, { sessionKey: f.input.binding.sessionKey, message: source.context.current.text, caller: f.input.binding.caller!, toolsAlsoAllow: ['benson_reminder_delete'],
      runtime: { async run(options) { f.state.launches++; assert.equal(options.deliver, false);
        assert.deepEqual(options.toolsAlsoAllow, ['benson_reminder_delete']); options.assertCurrent?.();
        return { runId: f.input.binding.runId, sessionKey: fault === 'foreign-receipt' ? 'foreign' : options.sessionKey }; },
        async waitForRun(options) { f.state.waits++; assert.equal(options.runId, f.input.binding.runId);
          if (fault === 'retired') f.state.live = false;
          return { status: fault === 'timeout-only' ? 'timeout' : 'ok', runId: options.runId }; } },
      observe() { if (fault === 'timeout-only') throw new Error('No terminal observation');
        if (fault === 'foreign-terminal') f.input.terminal.runId = 'foreign'; return f.input; },
    });
    if (fault === 'none') { const result = await promise; assert.equal(result.completion.binding.caller?.runId, 'actual-main');
      assert.equal(result.completion.binding.inputId, 'original-input'); assert.equal(result.result.outcome.status, 'success'); }
    else await assert.rejects(promise, fault);
    assert.equal(f.state.launches, fault === 'false-custody' ? 0 : 1); assert(f.state.waits <= 1);
  }
});

test('Reminder adapter rejects unknown result-version opt-in without silent legacy fallback', () => {
  const f = fixture(); Reflect.set(f.input, 'resultVersion', 99);
  assert.throws(() => normalizeReminderCompletion(f.input), /domain_result_version/);
});

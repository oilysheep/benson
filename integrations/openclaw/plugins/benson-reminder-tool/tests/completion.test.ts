import { unitToolEvidence } from '../../../benson-routing/tests/fixtures/tool-evidence.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectReminderRunEffects, normalizeReminderCompletion, runReminderNativeTask } from '../src/completion.js';
import { normalizeReminderServiceResult } from '../../../../../agents/reminder-service/lib/results.js';
import { renderReminderDomainResult } from '../../../../../agents/reminder-service/lib/presentation.js';
import { createResponseV3Envelope, createResponseV4Envelope } from '../../../benson-routing/core/legacy-response.js';
import { controlResponse } from '../../../benson-routing/core/response-control.js';
import { validateCompletion, createCompletionAuthority, acceptAgentCompletion } from '../../../benson-routing/core/completion.js';
import { createCompletionDomainResultV3 } from '../../../benson-routing/core/domain-result.js';
import { MAX_BYTES, MAX_WARNINGS } from '../../../benson-routing/core/value.js';
import { createCurrentRequestContext } from '../../../benson-routing/core/conversation-context.js';
import { loadIdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';

function fixture(operation: 'create' | 'update' | 'pause' | 'resume' | 'delete' = 'delete') {
  const state = { live: true, launches: 0, waits: 0 };
  const binding: Parameters<typeof normalizeReminderCompletion>[0]['binding'] = {
    inputId: 'original-input', admissionId: 'original-input', conversationId: 'conversation', runId: 'actual-child',
    agentId: 'reminder-service', sessionKey: 'agent:reminder-service:subagent:isolated', sessionId: 'actual-child-session',
    domain: 'reminder', taskId: 'actual-task', caller: { runId: 'actual-main', agentId: 'main', sessionKey: 'main-session', sessionId: 'main-id' },
    completionTarget: 'CALLER', authorizationId: 'original-input', parentContinuation: { eligible: true, reason: null },
    deliveryPolicy: { eligible: false, reason: null },
  };
  const operations = { create: 'create-intent', update: 'update-reminder', pause: 'pause-reminder', resume: 'resume-reminder', delete: 'delete-reminder' } as const;
  const raw = { status: 'success', operation, reminderId: 'existing', transaction: { status: 'success', verified: true },
    data: { record: { reminderId: 'existing', content: 'fixture',
      status: operation === 'delete' ? 'deleted' : operation === 'pause' ? 'paused' : 'active' } }, transport: { deliveries: [] }, warnings: [] };
  const value = normalizeReminderServiceResult(operations[operation], raw, { taskId: binding.taskId, pendingBinding: null, pendingExpiresAt: null });
  const effects = [{ kind: `reminder-${operation}`, reminderId: 'existing', verified: true }];
  const facts = { domain: value.domain, domainSchemaVersion: value.domainSchemaVersion, operation: value.operation, status: value.status,
    verified: value.verified, verificationScope: ['reminder_transaction'], data: value.data, warnings: value.warnings, error: value.error,
    pendingContext: value.pendingContext, effects, uncertainty: [] };
  const carrier = { content: [{ type: 'text', text: JSON.stringify(raw) }], details: raw };
  const input: Parameters<typeof normalizeReminderCompletion>[0] = { binding, operation: operations[operation],
    tool: { runId: binding.runId, sessionKey: binding.sessionKey, sessionId: binding.sessionId, callId: 'actual-call', name: `benson_reminder_${operation}`, value: raw },
    after: { runId: binding.runId, callId: 'actual-call', value: carrier, error: undefined },
    terminal: { runId: binding.runId, sessionKey: binding.sessionKey, sessionId: binding.sessionId, success: true, messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'actual-call', name: `benson_reminder_${operation}` }] },
      { role: 'toolResult', toolCallId: 'actual-call', toolName: `benson_reminder_${operation}`, ...carrier },
      { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 6, kind: 'domain-task', facts,
        userResponse: { state: 'unavailable', reason: { code: 'DOMAIN_RENDERING_REQUIRED', detail: 'Use domain facts' } } }) }] },
    ] }, effects: { status: 'known', refs: ['existing'], details: effects, reconciliation: { required: false, reason: null } }, uncertainty: [],
    validateTool() { assert(state.live, 'source retired'); },
    custody: { assertCurrent() { assert(state.live, 'source retired'); } },
  };
  input.executionEvidence = unitToolEvidence(input);
  return { input, state, raw };
}

function refresh(f: ReturnType<typeof fixture>) {
  const value = normalizeReminderServiceResult(f.input.operation, f.raw, { taskId: f.input.binding.taskId, pendingBinding: null, pendingExpiresAt: null });
  const final = f.input.terminal.messages.at(-1) as { content: [{ text: string }] };
  const proposal = JSON.parse(final.content[0].text); proposal.facts.data = value.data; proposal.facts.effects = f.input.effects.details;
  final.content[0].text = JSON.stringify(proposal);
  const carrier = { content: [{ type: 'text', text: JSON.stringify(f.raw) }], details: f.raw };
  f.input.after.value = carrier;
  f.input.terminal.messages[0] = { role: 'assistant', content: [{ type: 'toolCall', id: f.input.tool.callId, name: f.input.tool.name }] };
  f.input.terminal.messages[1] = { role: 'toolResult', toolCallId: f.input.tool.callId, toolName: f.input.tool.name, ...carrier };
  f.input.executionEvidence = unitToolEvidence(f.input);
}

test('Reminder effect aggregation retains every verified transaction, including repeated entity operations', () => {
  for (const count of [1, 3, 5]) {
    const tools = Array.from({ length: count }, (_, i) => {
      const f = fixture(i % 2 ? 'pause' : 'resume');
      return { ...f.input.tool, callId: `call-${i}` };
    });
    const { effects, uncertainty } = collectReminderRunEffects(tools, 'task');
    assert.equal(effects.status, 'known'); assert.deepEqual(effects.refs, ['existing']);
    assert.equal(effects.details.length, count); assert.deepEqual(uncertainty, []);
    assert.deepEqual(effects.details.map(item => item.kind), tools.map(tool => 'reminder-' + tool.name.slice('benson_reminder_'.length)));
    assert.throws(() => collectReminderRunEffects([...tools, tools[0]!], 'task'), /effect_calls_invalid/);
  }
  const f = fixture('create');
  Reflect.deleteProperty(f.raw, 'reminderId'); Reflect.set(f.raw, 'reminderIds', ['first', 'second', 'third']);
  Reflect.deleteProperty(f.raw.data, 'record');
  Reflect.set(f.raw.data, 'records', ['first', 'second', 'third'].map(reminderId => ({ reminderId })));
  const tool = { ...f.input.tool, name: 'benson_reminder_create_plan' };
  assert.deepEqual(collectReminderRunEffects([tool], 'task').effects.refs, ['first', 'second', 'third']);
  Reflect.set(f.raw.data, 'records', [{ reminderId: 'first' }]);
  assert.throws(() => collectReminderRunEffects([tool], 'task'), /effect_identity_missing/);
});

test('Reminder failed writes retain prior effects and uncertainty; read-only runs retain no effects', () => {
  const f = fixture('delete');
  const failed = { ...f.input.tool, callId: 'failed-write', value: { status: 'failure', operation: 'delete',
    error: { code: 'TRANSACTION_UNVERIFIED', retryable: false } } };
  for (const tools of [[f.input.tool, failed], [failed, f.input.tool]]) {
    const { effects, uncertainty } = collectReminderRunEffects(tools, 'task');
    assert.equal(effects.status, 'possible'); assert.deepEqual(effects.refs, ['existing']);
    assert.equal(effects.details.length, 1); assert.equal(effects.reconciliation.required, true);
    assert.equal(uncertainty[0]?.callId, 'failed-write');
  }
  const read = { ...f.input.tool, name: 'benson_reminder_list', value: { status: 'success', operation: 'list', verified: true,
    matches: [], matchCount: 0, warnings: [] } };
  assert.deepEqual(collectReminderRunEffects([read], 'task'), { effects: { status: 'none', refs: [], details: [],
    reconciliation: { required: false, reason: null } }, uncertainty: [] });
  assert.throws(() => collectReminderRunEffects([{ ...read, name: 'unknown' }], 'task'), /tool_not_admitted/);
});

test('Reminder Completion rejects failed writes projected as no effects or without exact uncertainty', () => {
  const f = fixture('delete');
  Reflect.set(f.raw, 'status', 'failure'); Reflect.set(f.raw, 'error', { code: 'TRANSACTION_UNVERIFIED' });
  f.input.effects = { status: 'none', refs: [], details: [], reconciliation: { required: false, reason: null } };
  refresh(f);
  assert.throws(() => normalizeReminderCompletion(f.input), /reminder_uncertain_effect_omitted/);
  f.input.effects = collectReminderRunEffects([f.input.tool], f.input.binding.taskId).effects;
  assert.throws(() => normalizeReminderCompletion(f.input), /reminder_uncertain_effect_omitted/);
  f.input.uncertainty = collectReminderRunEffects([f.input.tool], f.input.binding.taskId).uncertainty;
  const settled = normalizeReminderCompletion(f.input);
  assert.equal(settled.completion.completion.outcome, 'FAILED');
  assert.equal(settled.effects.status, 'possible'); assert.equal(settled.effects.reconciliation.required, true);
  assert.equal(JSON.stringify(settled.result.uncertainty), JSON.stringify(f.input.uncertainty));
});

test('all verified Reminder lifecycle operations pass common Response with complete record wording', () => {
  const words = { create: 'נקבעה', update: 'עודכנה', pause: 'הושהתה', resume: 'הופעלה מחדש', delete: 'נמחקה' };
  for (const operation of ['create', 'update', 'pause', 'resume', 'delete'] as const) {
    const f = fixture(operation);
    Reflect.set(f.raw.data.record, 'schedules', [
      { type: 'one-shot', resolvedTime: '2026-11-03T10:00:00+02:00', timezone: 'Asia/Jerusalem' },
      { type: 'recurring', cron: '0 10 * * 1', timezone: 'Asia/Jerusalem' },
    ]);
    Reflect.set(f.raw.data.record, 'calendar', { requested: true, eventId: 'verified-calendar-event' });
    refresh(f);
    const settled = normalizeReminderCompletion({ ...f.input, resultVersion: 3 });
    const response = createResponseV4Envelope({ messageCandidate: null }, { requestId: f.input.binding.inputId,
      source: { type: 'main', agentId: 'main', runId: 'actual-main' }, results: [settled.result],
      lifecycle: { domainExecution: 'attempted', failure: null }, responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic'] } });
    const controlled = controlResponse(response, { language: 'he', now: '2026-11-02T08:00:00Z', timezone: 'Asia/Jerusalem',
      assertResponseCurrent() { validateCompletion(settled.completion, settled.authority); }, renderDomainResult: renderReminderDomainResult });
    assert.equal(controlled.mode, 'deterministic');
    assert(controlled.rendered?.message.includes(words[operation])); assert.match(controlled.rendered?.message ?? '', /fixture/u);
    if (operation !== 'delete' && operation !== 'pause') assert.match(controlled.rendered?.message ?? '', /חוזר/u);
    assert.match(controlled.rendered?.message ?? '', /Calendar/u);
    const english = renderReminderDomainResult(settled.result, { language: 'en', now: '2026-11-02T08:00:00Z', timezone: 'Asia/Jerusalem' });
    assert.equal(english.kind, 'rendered');
  }
});

test('Reminder presentation retains all plan/restructured records and rejects unverified delivery or partial records', () => {
  const schedule = { type: 'one-shot', resolvedTime: '2026-11-03T10:00:00+02:00', timezone: 'Asia/Jerusalem' };
  const options = { language: 'he' as const, now: '2026-11-02T08:00:00Z', timezone: 'Asia/Jerusalem' };
  for (const count of [2, 5]) {
    const f = fixture('create');
    const records = Array.from({ length: count }, (_, i) => ({ reminderId: `r-${i}`, status: 'active', content: `content-${i}`, schedules: [schedule], calendar: { requested: false } }));
    Reflect.deleteProperty(f.raw, 'reminderId'); Reflect.set(f.raw, 'reminderIds', records.map(record => record.reminderId));
    Reflect.deleteProperty(f.raw.data, 'record'); Reflect.set(f.raw.data, 'records', records);
    f.input.tool.name = 'benson_reminder_create_plan';
    f.input.effects.refs = records.map(record => record.reminderId);
    f.input.effects.details = records.map(record => ({ kind: 'reminder-create', reminderId: record.reminderId, verified: true }));
    refresh(f);
    const result = normalizeReminderCompletion(f.input).result;
    const rendered = renderReminderDomainResult(result, options); assert.equal(rendered.kind, 'rendered');
    if (rendered.kind === 'rendered') for (const record of records) assert(rendered.text.includes(record.content));
    const removed = f.input.effects.refs.shift(); assert(removed);
    assert.throws(() => normalizeReminderCompletion(f.input), /reminder_effect_omitted/);
    f.input.effects.refs.unshift(removed);
    records.push(records[0]!); Reflect.set(f.raw, 'reminderIds', records.map(record => record.reminderId)); refresh(f);
    assert.throws(() => normalizeReminderCompletion(f.input), /reminder_effect_identity/);
  }
  const f = fixture('update'); f.raw.data.record.status = 'paused';
  Reflect.set(f.raw.data.record, 'schedules', [schedule]);
  Reflect.set(f.raw.data, 'restructuredRecord', { reminderId: 'selected-recipient-record', status: 'active', content: 'changed content', schedules: [schedule] });
  Reflect.set(f.raw.data, 'changedRecipientId', 'selected-recipient');
  f.input.effects.refs.push('selected-recipient-record');
  f.input.effects.details.push({ kind: 'reminder-update', reminderId: 'selected-recipient-record', verified: true });
  refresh(f);
  const rendered = renderReminderDomainResult(normalizeReminderCompletion(f.input).result, options);
  assert.equal(rendered.kind, 'rendered');
  if (rendered.kind === 'rendered') { assert.match(rendered.text, /נותרה.*fixture/u); assert.match(rendered.text, /לנמען שנבחר.*changed content/u); }
  for (const fault of ['notification', 'missing-schedule', 'conflicting-schedules', 'calendar', 'wrong-status'] as const) {
    const f = fixture('create'); Reflect.set(f.raw.data.record, 'schedules', [schedule]);
    if (fault === 'notification') Reflect.set(f.raw.transport, 'deliveries', [{ status: 'pending', idempotencyKey: 'owned-pending-key' }]);
    if (fault === 'missing-schedule') Reflect.deleteProperty(f.raw.data.record, 'schedules');
    if (fault === 'conflicting-schedules') Reflect.set(f.raw.data.record, 'schedule', { ...schedule, resolvedTime: '2026-11-04T10:00:00+02:00' });
    if (fault === 'calendar') Reflect.set(f.raw.data.record, 'calendar', { requested: true });
    if (fault === 'wrong-status') f.raw.data.record.status = 'deleted';
    refresh(f);
    const settled = normalizeReminderCompletion(f.input), before = JSON.stringify(settled.effects);
    assert.equal(renderReminderDomainResult(settled.result, options).kind, 'unsupported', fault);
    assert.equal(JSON.stringify(settled.effects), before);
  }
});

test('canonical Reminder result identities reject missing, conflicting, foreign and omitted effects', () => {
  for (const fault of ['missing-primary', 'record-mismatch', 'foreign-target', 'legacy-nested', 'unexpected-array',
    'restructured-duplicate', 'restructured-missing', 'restructured-omitted', 'missing-ref', 'missing-detail'] as const) {
    const f = fixture('update');
    if (fault === 'missing-primary' || fault === 'legacy-nested') Reflect.deleteProperty(f.raw, 'reminderId');
    if (fault === 'legacy-nested') Reflect.set(f.raw.data, 'reminderIds', ['existing']);
    if (fault === 'record-mismatch') f.raw.data.record.reminderId = 'foreign';
    if (fault === 'foreign-target') { f.raw.reminderId = 'foreign'; f.raw.data.record.reminderId = 'foreign'; }
    if (fault === 'unexpected-array') Reflect.set(f.raw, 'reminderIds', ['existing']);
    if (fault.startsWith('restructured-')) Reflect.set(f.raw.data, 'restructuredRecord',
      fault === 'restructured-missing' ? {} : { reminderId: fault === 'restructured-duplicate' ? 'existing' : 'new-record' });
    if (fault === 'missing-ref') f.input.effects.refs = [];
    if (fault === 'missing-detail') f.input.effects.details = [];
    refresh(f);
    assert.throws(() => normalizeReminderCompletion(f.input), /reminder_effect_identity|reminder_effect_omitted/, fault);
  }
});

test('Reminder discovery prefix is native-correlated and every raw result remains domain validated', () => {
  for (const count of [1, 4]) {
    const f = fixture();
    const raw = { status: 'success', operation: 'find', verified: true, matches: [], matchCount: 0 };
    const carrier = { content: [{ type: 'text', text: JSON.stringify(raw) }], details: raw };
    const preceding = Array.from({ length: count }, (_, index) => ({
      tool: { ...f.input.tool, name: 'benson_reminder_find', callId: `find-${index}`, value: raw },
      after: { ...f.input.after, callId: `find-${index}`, value: carrier },
    }));
    f.input.preceding = preceding;
    f.input.executionEvidence = unitToolEvidence(f.input);
    f.input.terminal.messages.unshift(...preceding.flatMap(({ tool, after }) => [
      { role: 'assistant', content: [{ type: 'toolCall', id: tool.callId, name: tool.name }] },
      { role: 'toolResult', toolCallId: tool.callId, toolName: tool.name, ...after.value },
    ]));
    const settled = normalizeReminderCompletion(f.input);
    assert.equal(settled.completion.completion.outcome, 'NORMAL');
    assert.deepEqual(settled.effects.refs, ['existing']);
    raw.verified = false;
    assert.throws(() => normalizeReminderCompletion(f.input), /success contradicts verification|native_tool_original_result_mismatch/);
    raw.verified = true;
    const first = preceding[0]; assert(first); first.tool.name = 'foreign_tool';
    assert.throws(() => normalizeReminderCompletion(f.input), /reminder_native_tool_not_admitted|native_completion_unverified/);
    f.state.live = false;
    assert.throws(() => validateCompletion(settled.completion, settled.authority), /source retired/);
  }
});

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
  for (const fault of ['foreign-run', 'changed-original', 'unverified', 'duplicate', 'retired'] as const) {
    const f = fixture();
    if (fault === 'foreign-run') f.input.tool.runId = 'foreign';
    if (fault === 'changed-original') f.input.tool.value = { ...f.raw, warnings: ['foreign'] };
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
      refs: Array.from({ length: MAX_WARNINGS }, (_, i) => i === 0 ? 'existing' : `effect-${i}`),
      details: Array.from({ length: MAX_WARNINGS }, (_, i) => i === 0 ? { kind: 'reminder-delete', reminderId: 'existing', verified: status === 'known' } : { ref: `effect-${i}`, verified: status === 'known' }),
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
    f.input.executionEvidence = unitToolEvidence(f.input);
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
    f.input.executionEvidence = unitToolEvidence(f.input);
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
  for (const fault of ['none', 'foreign-receipt', 'foreign-terminal', 'timeout-only', 'retired', 'false-custody', 'retired-task'] as const) {
    const f = fixture(), abort = new AbortController();
    let taskLive = true;
    const assertTaskCurrent = () => { assert(taskLive, 'Task invocation retired'); assert(f.state.live); return fault !== 'false-custody'; };
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
        authority: { signal: abort.signal, assertCurrent: assertTaskCurrent },
        transaction: { async execute() { throw new Error('No transaction replay'); } },
        evidence: { async readCurrentUserText() { return source.context.current.text; }, async readOriginalUserTurns() { return []; } } },
    }, { sessionKey: f.input.binding.sessionKey, message: source.context.current.text, caller: f.input.binding.caller!, toolsAlsoAllow: ['benson_reminder_delete'],
      executionEvidence: { async waitForSettlement() {}, evidence() { assert(f.input.executionEvidence); return f.input.executionEvidence as ReturnType<typeof unitToolEvidence>; } },
      runtime: { async run(options) { f.state.launches++; assert.equal(options.deliver, false);
        assert.deepEqual(options.toolsAlsoAllow, ['benson_reminder_delete']); options.assertCurrent?.();
        return { runId: f.input.binding.runId, sessionKey: fault === 'foreign-receipt' ? 'foreign' : options.sessionKey }; },
        async waitForRun(options) { f.state.waits++; assert.equal(options.runId, f.input.binding.runId);
          if (fault === 'retired') f.state.live = false;
          return { status: fault === 'timeout-only' ? 'timeout' : 'ok', runId: options.runId }; } },
      observe(runId) { assert.equal(runId, f.input.binding.runId);
        if (fault === 'timeout-only') throw new Error('No terminal observation');
        if (fault === 'foreign-terminal') f.input.terminal.runId = 'foreign'; return f.input; },
    });
    if (fault === 'none' || fault === 'retired-task') { const result = await promise; assert.equal(result.completion.binding.caller?.runId, 'actual-main');
      assert.equal(result.completion.binding.inputId, 'original-input'); assert.equal(result.result.outcome.status, 'success');
      if (fault === 'retired-task') {
        taskLive = false;
        assert.throws(assertTaskCurrent, /Task invocation retired/);
        assert.doesNotThrow(() => validateCompletion(result.completion, result.authority));
        f.state.live = false;
        assert.throws(() => validateCompletion(result.completion, result.authority), /source retired/);
      }
    }
    else await assert.rejects(promise, fault);
    assert.equal(f.state.launches, fault === 'false-custody' ? 0 : 1); assert(f.state.waits <= 1);
  }
});

test('Reminder adapter rejects unknown result-version opt-in without silent legacy fallback', () => {
  const f = fixture(); Reflect.set(f.input, 'resultVersion', 99);
  assert.throws(() => normalizeReminderCompletion(f.input), /domain_result_version/);
});

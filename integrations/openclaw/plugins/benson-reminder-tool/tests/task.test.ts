import assert from 'node:assert/strict';
import test from 'node:test';
import { plain } from '../../../benson-routing/core/value.js';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { createReminderTaskToolFactory, createReminderToolFactory } from '../src/tool.js';
import { loadIdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';
import { validateDomainResult } from '../../../benson-routing/core/domain-result.js';
import { createCompletionAuthority, acceptAgentCompletion } from '../../../benson-routing/core/completion.js';
import { executeReminderCreateTask } from '../../../../../agents/reminder-service/lib/task.js';
import { renderReminderDomainResult } from '../../../../../agents/reminder-service/lib/presentation.js';
import { SERVICE_OPERATIONS, normalizeReminderServiceResult } from '../../../../../agents/reminder-service/lib/results.js';
import type { ToolName } from '../../../../../agents/reminder-service/lib/schemas.js';

function fixture() {
  const state = { live: true, reads: 0, serialized: 0, malformed: false, revokeRead: false, revokeSerialize: false };
  const abort = new AbortController();
  const identities = loadIdentityContract({ accountId: 'fixture-account', trustedRequesterIds: ['reader'],
    recipients: [{ id: 'reader', type: 'person', channel: 'whatsapp', to: 'fixture-private' }] });
  const context: OpenClawPluginToolContext<2> = { agentId: 'main', requesterSenderId: 'fixture-private',
    deliveryContext: { channel: 'whatsapp', accountId: 'fixture-account', to: 'fixture-private' },
    assertInvocationCurrent() { assert(state.live, 'invocation retired'); } };
  const records = [1, 2, 3].map(i => ({ schemaVersion: 4, reminderId: `fixture-${i}`, status: 'active', content: `Reminder ${i}`,
    schedules: [{ type: 'one-shot', resolvedTime: '2026-10-28T10:00:00+02:00', timezone: 'Asia/Jerusalem' }] }));
  const factory = createReminderTaskToolFactory({ identities, clock: () => new Date('2026-10-26T08:00:00Z'),
    transaction: { async execute(request) {
      assert.equal(request.operation, 'list-reminders'); assert.equal(request.requesterId, 'reader'); state.reads++;
      if (state.revokeRead) state.live = false;
      return state.malformed ? { status: 'failure', operation: 'list', error: { code: 'SAFE_CODE', message: 'private backend diagnostic' } }
        : { status: 'success', operation: 'list', verified: true, matchCount: records.length, matches: structuredClone(records), warnings: [] };
    } },
    jsonResult(value) { state.serialized++; if (state.revokeSerialize) state.live = false;
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; } });
  const tool = factory(context); assert(tool && !Array.isArray(tool));
  return { state, abort, factory, context, tool, records, identities };
}

test('intent entry admits existing Reminder discovery and lifecycle owners through controlled Completion', async () => {
  const operations = [
    ['benson_reminder_find', { text: 'fixture' }, 'find-reminders'],
    ['benson_reminder_list', {}, 'list-reminders'],
    ['benson_reminder_update', { reminderId: 'existing', input: { content: 'updated' } }, 'update-reminder'],
    ['benson_reminder_pause', { reminderId: 'existing' }, 'pause-reminder'],
    ['benson_reminder_resume', { reminderId: 'existing' }, 'resume-reminder'],
    ['benson_reminder_delete', { reminderId: 'existing' }, 'delete-reminder'],
  ] as const;
  for (const [name, args, operation] of operations) {
    const f = fixture(); let transactions = 0;
    f.context.sessionKey = 'main-session'; f.context.sessionId = 'main-session-id';
    const text = 'A self-contained Reminder request';
    const create = createReminderTaskToolFactory({ identities: f.identities,
      transaction: { async execute(request, authority) {
        authority.assertCurrent(); assert.equal(request.operation, operation); assert.equal(request.requesterId, 'reader'); transactions++;
        return operation === 'find-reminders' || operation === 'list-reminders'
          ? { operation: SERVICE_OPERATIONS[operation], status: 'success', verified: true, matches: [], matchCount: 0 }
          : { operation: SERVICE_OPERATIONS[operation], status: 'success', transaction: { status: 'success', verified: true },
            data: { record: { reminderId: 'existing', status: operation === 'delete-reminder' ? 'deleted' : 'active', content: 'fixture' } },
            transport: { deliveries: [] }, warnings: [] };
      } }, jsonResult: value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }),
      task: { source: () => ({ request: text,
        binding: { conversationRef: 'original-conversation', channel: 'whatsapp', accountId: 'fixture-account', kind: 'direct',
          peerId: 'fixture-private', threadId: null, requesterId: 'fixture-private' },
        currentTurn: () => ({ entryId: 'original-input', role: 'user', text,
          sender: { source: 'canonical_peer_binding', id: 'fixture-private', channel: 'whatsapp', accountId: 'fixture-account' }, inputProvenance: { kind: 'external_user' } }),
        assertCurrent() { assert(f.state.live); }, assertAuthorized() { assert(f.state.live); } }),
        async run(_request, work) {
          const factory = createReminderToolFactory({ name: name as ToolName, source: work.deps,
            jsonResult: value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }) });
          const raw = factory({ agentId: 'reminder-service', assertInvocationCurrent: work.deps.authority.assertCurrent }); assert(raw && !Array.isArray(raw));
          const value = normalizeReminderServiceResult(operation, (await raw.execute('actual-child-call', { requesterId: 'reader', ...args })).details,
            { taskId: work.callId, pendingBinding: null, pendingExpiresAt: null });
          const read = operation === 'find-reminders' || operation === 'list-reminders';
          const details = read ? [] : [{ kind: operation, reminderId: 'existing', verified: true }];
          const facts = { domain: value.domain, domainSchemaVersion: value.domainSchemaVersion, operation: value.operation, status: value.status,
            verified: value.verified, verificationScope: [read ? 'discovery' : 'reminder_transaction'], data: value.data,
            warnings: value.warnings, error: value.error, pendingContext: null, effects: details, uncertainty: [] };
          const binding = { inputId: 'original-input', admissionId: 'original-input', conversationId: 'original-conversation', runId: 'actual-child',
            agentId: 'reminder-service', sessionKey: 'child-session', sessionId: 'child-session-id', domain: 'reminder', taskId: work.callId,
            caller: { runId: 'actual-main', agentId: 'main', sessionKey: 'main-session', sessionId: 'main-session-id' },
            completionTarget: 'CALLER', authorizationId: 'original-input', parentContinuation: { eligible: true, reason: null }, deliveryPolicy: { eligible: false, reason: null } };
          const authority = createCompletionAuthority({ schemaVersion: 6, kind: 'domain-task', binding, knownFacts: facts, results: [], coverage: 'complete', gaps: [], origin: 'agent' },
            { assertCurrent: work.deps.authority.assertCurrent });
          const completion = acceptAgentCompletion({ schemaVersion: 6, kind: 'domain-task', facts,
            userResponse: { state: 'unavailable', reason: { code: 'DOMAIN_RENDERING_REQUIRED', detail: 'Use verified domain facts' } } }, authority);
          return { completion, authority, effects: { status: read ? 'none' : 'known', refs: read ? [] : ['existing'], details, reconciliation: { required: false, reason: null } } };
        } } });
    const tool = create(f.context); assert(tool && !Array.isArray(tool));
    const request = { kind: 'benson.self-contained-request', version: 1, request: text };
    const value = validateDomainResult((await tool.execute('actual-main-call', request)).details);
    assert.equal(value.operation, SERVICE_OPERATIONS[operation]); assert.equal(value.executionMode, 'agentic'); assert.equal(transactions, 1);
    await assert.rejects(tool.execute('retry', request), /already_started/); assert.equal(transactions, 1);
  }
});
test('Main read factory preserves full list in the model-visible JSON and details', async () => {
  const f = fixture(), output = await f.tool.execute('fixture-call', { operation: 'list' }, f.abort.signal);
  const result = validateDomainResult(output.details);
  assert.equal(result.executionMode, 'deterministic'); assert.equal(result.effects.status, 'none');
  assert.equal(result.facts.verified, true); assert(plain(result.facts.data));
  assert.deepEqual(JSON.parse(JSON.stringify(result.facts.data.matches)), f.records);
  const content = output.content[0]; assert(content?.type === 'text');
  assert.deepEqual(JSON.parse(content.text), JSON.parse(JSON.stringify(result)));
  assert(result.content?.state === 'usable'); for (const r of f.records) assert(result.content.text.includes(r.content));
  assert.equal(f.state.reads, 1); assert.equal(f.state.serialized, 1);
});
test('group identity is the native sender, never the group or tool arguments', async () => {
  const f = fixture(); f.context.deliveryContext = { channel: 'whatsapp', accountId: 'fixture-account', to: 'fixture-group@g.us' };
  const tool = f.factory(f.context); assert(tool && !Array.isArray(tool));
  await tool.execute('group-call', { operation: 'list' }, f.abort.signal); assert.equal(f.state.reads, 1);
  f.context.requesterSenderId = ''; await assert.rejects(tool.execute('missing-sender', { operation: 'list' }, f.abort.signal));
  f.context.requesterSenderId = 'foreign'; await assert.rejects(tool.execute('foreign-sender', { operation: 'list' }, f.abort.signal));
  assert.equal(f.state.reads, 1);
});
for (const mode of ['foreign-account', 'foreign-channel', 'private-sender-mismatch', 'missing-route', 'forged-params', 'mutation',
  'closed', 'aborted', 'async-assertion', 'revoke-read', 'revoke-serialize'] as const) {
  test(`Main list refuses ${mode}`, async () => {
    const f = fixture(); let request: unknown = { operation: 'list' };
    if (mode === 'foreign-account') f.context.deliveryContext = { channel: 'whatsapp', accountId: 'foreign', to: 'fixture-private' };
    if (mode === 'foreign-channel') f.context.deliveryContext = { channel: 'webchat', accountId: 'fixture-account', to: 'fixture-private' };
    if (mode === 'private-sender-mismatch') f.context.requesterSenderId = 'foreign';
    if (mode === 'missing-route') delete f.context.deliveryContext;
    if (mode === 'forged-params') request = { operation: 'list', requesterId: 'foreign' };
    if (mode === 'mutation') request = { operation: 'delete', reminderId: 'fixture-1' };
    if (mode === 'closed') f.state.live = false;
    if (mode === 'aborted') f.abort.abort();
    if (mode === 'async-assertion') f.context.assertInvocationCurrent = async () => {};
    if (mode === 'revoke-read') f.state.revokeRead = true;
    if (mode === 'revoke-serialize') f.state.revokeSerialize = true;
    await assert.rejects(f.tool.execute('negative-call', request, f.abort.signal));
    assert.equal(f.state.reads, mode === 'revoke-read' || mode === 'revoke-serialize' ? 1 : 0);
  });
}
test('foreign agent has no tool; optional signal never substitutes for live authority', async () => {
  const f = fixture(); assert.equal(f.factory({ ...f.context, agentId: 'reminder-service' }), null);
  await f.tool.execute('no-signal', { operation: 'list' }); f.state.live = false;
  await assert.rejects(f.tool.execute('retired-no-signal', { operation: 'list' })); assert.equal(f.state.reads, 1);
});
test('unverified/backend failure becomes safe DomainResult without raw diagnostics', async () => {
  const f = fixture(); f.state.malformed = true;
  const result = await f.tool.execute('failure-call', { operation: 'list' }, f.abort.signal);
  assert.equal(validateDomainResult(result.details).outcome.disposition, 'failed');
  assert(!JSON.stringify(result).includes('private backend diagnostic'));
});
for (const fault of ['none', 'foreign-source', 'changed-source', 'forged-intent', 'missing-provenance', 'foreign-input', 'cancel-before-transaction', 'foreign-completion', 'foreign-caller-key', 'foreign-caller-id', 'missing-caller-session', 'changed-caller-session', 'duplicate-completion'] as const) {
  test(`source-bound Reminder create entry: ${fault}`, async () => {
    const f = fixture(); let changed = false, transactions = 0;
    f.context.sessionKey = 'main-session'; f.context.sessionId = 'main-session-id';
    if (fault === 'missing-caller-session') { delete f.context.sessionKey; delete f.context.sessionId; }
    const text = 'Remind me to drink water on October 28 at 10:00, without a calendar event.';
    const record = { reminderId: 'created-fixture', status: 'active', content: 'drink water',
      schedule: { type: 'one-shot', resolvedTime: '2026-10-28T10:00:00+02:00', timezone: 'Asia/Jerusalem' }, calendar: { requested: false } };
    const details = [{ kind: 'reminder-create', reminderId: record.reminderId, verified: true }];
    let retained: { completion: unknown; authority: ReturnType<typeof createCompletionAuthority>; effects: { status: 'known'; refs: string[]; details: typeof details; reconciliation: { required: false; reason: null } } } | undefined;
    const create = createReminderTaskToolFactory({ identities: loadIdentityContract({ accountId: 'fixture-account', trustedRequesterIds: ['reader'],
      recipients: [{ id: 'reader', type: 'person', channel: 'whatsapp', to: 'fixture-private' }] }),
      clock: () => new Date('2026-10-26T08:00:00Z'),
      transaction: { async execute(_request, authority) { authority.assertCurrent(); transactions++;
        return { status: 'success', operation: 'create', transaction: { status: 'success', verified: true }, data: { record }, transport: { deliveries: [] }, warnings: [] }; } },
      jsonResult: value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }),
      task: {
        source: () => ({ request: text,
          binding: { conversationRef: 'original-conversation', channel: 'whatsapp', accountId: fault === 'foreign-source' ? 'foreign' : 'fixture-account',
            kind: 'direct', peerId: 'fixture-private', threadId: null, requesterId: 'fixture-private' },
          currentTurn: () => ({ entryId: changed ? 'replacement' : 'original-input', role: 'user', text,
            sender: { source: 'canonical_peer_binding', id: 'fixture-private', channel: 'whatsapp', accountId: 'fixture-account' }, inputProvenance: { kind: 'external_user' } }),
          assertCurrent() { assert(f.state.live); }, assertAuthorized() { assert(f.state.live); } }),
        async run(_request, { callId, source, deps }) {
          if (retained) return retained;
          await Promise.resolve(); if (fault === 'changed-source') changed = true;
          if (fault === 'changed-caller-session') f.context.sessionId = 'replacement-session';
          if (fault === 'cancel-before-transaction') f.abort.abort();
          const input = { sourceConversation: { type: 'private', id: 'fixture-private' }, requesterId: 'reader', recipientIds: ['reader'],
            content: record.content, schedule: record.schedule, calendar: record.calendar,
            ...fault === 'missing-provenance' ? {} : { provenance: { schemaVersion: 1, contextId: 'original-conversation', revision: 1,
              createdAt: '2026-10-26T08:00:00Z', expiresAt: '2026-10-26T09:00:00Z', sourceConversation: { type: 'private', id: 'fixture-private' }, requesterId: 'reader',
              currentEvidenceId: fault === 'foreign-input' ? 'foreign' : 'original-input', evidence: [{ id: 'original-input', text }],
              fieldEvidence: [{ field: 'content', evidenceId: 'original-input', quote: 'drink water' },
                { field: 'schedule', evidenceId: 'original-input', quote: 'October 28 at 10:00' },
                { field: 'calendar.requested', evidenceId: 'original-input', quote: 'without a calendar event' }] } } };
          const value = await executeReminderCreateTask(callId, { input }, source, deps);
          const binding = { inputId: fault === 'foreign-completion' ? 'foreign' : 'original-input', admissionId: 'original-input', conversationId: 'original-conversation',
            runId: 'actual-child', agentId: 'reminder-service', sessionKey: 'child-session', sessionId: 'child-session-id', domain: 'reminder', taskId: callId,
            caller: { runId: 'actual-main', agentId: 'main', sessionKey: fault === 'foreign-caller-key' ? 'foreign-main' : 'main-session', sessionId: fault === 'foreign-caller-id' ? 'foreign-id' : 'main-session-id' }, completionTarget: 'CALLER', authorizationId: 'original-input',
            parentContinuation: { eligible: true, reason: null }, deliveryPolicy: { eligible: false, reason: null } };
          const facts = { domain: value.domain, domainSchemaVersion: value.domainSchemaVersion, operation: value.operation, status: value.status,
            verified: value.verified, verificationScope: ['reminder_transaction'], data: value.data, warnings: value.warnings, error: value.error,
            pendingContext: value.pendingContext, effects: details, uncertainty: [] };
          const authority = createCompletionAuthority({ schemaVersion: 6, kind: 'domain-task', binding, knownFacts: facts, results: [], coverage: 'complete', gaps: [], origin: 'agent' }, { assertCurrent: deps.authority.assertCurrent });
          const completion = acceptAgentCompletion({ schemaVersion: 6, kind: 'domain-task', facts,
            userResponse: { state: 'unavailable', reason: { code: 'DOMAIN_RENDERING_REQUIRED', detail: 'Render the verified Reminder facts through the existing domain presentation owner.' } } }, authority);
          retained = { completion, authority, effects: { status: 'known', refs: [record.reminderId], details, reconciliation: { required: false, reason: null } } }; return retained;
        },
      } });
    const tool = create(f.context); assert(tool && !Array.isArray(tool));
    const request = { kind: 'benson.self-contained-request', version: 1, request: fault === 'forged-intent' ? 'Untrusted replacement' : text };
    const output = tool.execute('original-call', request, f.abort.signal);
    if (fault !== 'none' && fault !== 'duplicate-completion') { await assert.rejects(output); assert.equal(transactions, ['foreign-completion', 'foreign-caller-key', 'foreign-caller-id'].includes(fault) ? 1 : 0); return; }
    const value = validateDomainResult((await output).details); assert.equal(value.executionMode, 'agentic'); assert.equal(value.effects.status, 'known'); assert.equal(transactions, 1);
    const rendered = renderReminderDomainResult(value, { language: 'he', timezone: 'Asia/Jerusalem', now: '2026-10-26T08:00:00Z' });
    assert.equal(rendered.kind, 'rendered');
    if (fault === 'duplicate-completion') { await assert.rejects(tool.execute('original-call', request, f.abort.signal), /already_started/); assert.equal(transactions, 1); }
  });
}

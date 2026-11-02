import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { acquireOriginalUserTurns, retainOriginalUserWrite } from '../adapters/openclaw/conversation.js';
import { MAX_TRANSCRIPT_HYDRATION_BYTES, MAX_TRANSCRIPT_HYDRATION_EVENTS } from '../core/request-control.js';
import { validateProvenance } from '../../../../agents/reminder-service/lib/provenance.js';
import type { CreateInput } from '../../../../agents/reminder-service/lib/schemas.js';
import { formatTaskEnvelope, createPendingTaskEnvelope } from '../core/task-envelope.js';
import { validateDomainResultEnvelope, withDomainPending } from '../core/domain-result.js';

const binding = { conversationRef: 'agent:main:main', channel: 'whatsapp', accountId: 'test',
  kind: 'group' as const, peerId: 'group@g.us', threadId: null, requesterId: '+15550000001' };
function message(id: string, text: string) {
  return { role: 'user', content: text, idempotencyKey: id,
    __openclaw: { senderId: binding.requesterId,
      senderIdentity: { type: 'observation', id: binding.requesterId, pluginId: binding.channel, accountId: binding.accountId },
      transport: { channel: 'whatsapp', conversationRef: 'native-group-conversation', messageId: id } } };
}
function fixture() {
  const messages: Record<string, unknown>[] = [message('earlier', 'Remind me to buy milk'),
    { role: 'assistant', content: [{ type: 'toolCall', id: 'read-1', name: 'benson_reminder_list', arguments: {} }] },
    { role: 'toolResult', toolCallId: 'read-1', content: [{ type: 'text', text: '{"verified":true}' }] },
    message('current', 'Tomorrow at nine')];
  const entries = messages.map((message, i) => ({ entryId: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null, seq: i + 1, message }));
  const state = { live: true, generation: 'generation-1', header: { id: 'main-session' },
    messages: structuredClone(messages), page: { kind: 'page', entries, hasMore: false, serializedBytes: 2048 }, reads: 0 };
  const original = message('current', 'Tomorrow at nine');
  const source = { requestId: 'current', request: original.content, senderId: binding.requesterId, accountId: binding.accountId };
  const readers = {
    async visible(input: { maxMessages: number; maxBytes: number }) {
      state.reads++; assert.equal(input.maxMessages, MAX_TRANSCRIPT_HYDRATION_EVENTS - 2);
      assert.equal(input.maxBytes, MAX_TRANSCRIPT_HYDRATION_BYTES); return state.page;
    },
    context(_target: unknown, read: (messages: Iterable<unknown>, header: unknown, version: unknown) => unknown) {
      return read(state.messages, state.header, { generation: state.generation, rawSeq: state.messages.length, updatedAt: Date.now() });
    },
  };
  const options = { target: { agentId: 'main' as const, sessionKey: binding.conversationRef, sessionId: 'main-session' },
    binding, request: original.content, write: retainOriginalUserWrite(original, source),
    assertCurrent() { assert(state.live, 'retired'); } };
  return { state, readers, options, original, source };
}

test('native history is disabled before transcript access without proven pre-hydration bounds', async () => {
  const f = fixture(); let sdkResolutions = 0, payloadAccesses = 0;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'openclaw/plugin-sdk/session-transcript-runtime' || specifier === 'openclaw/plugin-sdk/agent-sessions') sdkResolutions++;
    return next(specifier, context);
  } });
  try {
    const write = new Proxy(f.options.write, { get() { payloadAccesses++; throw Error('History payload must remain unread'); } });
    await assert.rejects(acquireOriginalUserTurns({ ...f.options, write }), /native_original_history_resource_bounds_unavailable/);
    assert.equal(sdkResolutions, 0); assert.equal(payloadAccesses, 0);
  } finally { hooks.deregister(); }
});

test('isolated original-context custody retains exact same-sender turns without fabricating provenance or pending', async () => {
  const f = fixture(), acquired = await acquireOriginalUserTurns(f.options, f.readers);
  assert.deepEqual(acquired.turns.map(turn => [turn.entryId, turn.text, turn.inputProvenance]),
    [['entry-0', 'Remind me to buy milk', null], ['entry-3', 'Tomorrow at nine', null]]);
  assert(Object.isFrozen(acquired.turns[0]?.sender)); assert(Object.isFrozen(acquired.turns));
  assert.deepEqual(Object.keys(acquired).sort(), ['acquireTaskResults', 'assertCurrent', 'turns']);
  // The exact full prefix includes the tool result, despite projecting only
  // original user text into the domain's evidence reader.
  f.state.messages.push({ role: 'assistant', content: 'own progress' }, { role: 'toolResult', content: 'later result' });
  assert.doesNotThrow(() => acquired.assertCurrent()); assert.equal(f.state.reads, 2);
  f.state.messages[2] = { role: 'toolResult', toolCallId: 'read-1', content: 'changed' };
  assert.throws(() => acquired.assertCurrent(), /context_unavailable/);
});

for (const fault of ['generation', 'rewrite', 'branch', 'omission', 'new-user', 'retired', 'header'] as const) {
  test(`selected native prefix rejects before effect: ${fault}`, async () => {
    const f = fixture(), acquired = await acquireOriginalUserTurns(f.options, f.readers);
    if (fault === 'generation') f.state.generation = 'generation-2';
    if (fault === 'rewrite') f.state.messages[0] = message('earlier', 'Remind me to buy eggs');
    if (fault === 'branch') f.state.messages.reverse();
    if (fault === 'omission') f.state.messages.splice(2, 1);
    if (fault === 'new-user') f.state.messages.push(message('newer', 'Cancel that'));
    if (fault === 'retired') f.state.live = false;
    if (fault === 'header') f.state.header.id = 'another-session';
    assert.throws(() => acquired.assertCurrent());
  });
}

for (const fault of ['sender', 'internal', 'excluded', 'late-media',
  'duplicate', 'missing', 'changed-write', 'partial', 'bytes', 'events', 'context-limit'] as const) {
  test(`unverifiable native acquisition is unavailable: ${fault}`, async () => {
    const f = fixture(), earlier = f.state.page.entries[0]; assert(earlier);
    const raw = earlier.message; assert(raw.__openclaw && typeof raw.__openclaw === 'object');
    const first = message('earlier', 'Remind me to buy milk');
    if (fault === 'sender') first.__openclaw.senderId = 'foreign';
    if (fault === 'internal') Object.assign(first, { provenance: { kind: 'internal_system' } });
    if (fault === 'excluded') Object.assign(first, { excludeFromContext: true });
    if (fault === 'late-media') Object.assign(first.__openclaw, { lateMedia: true });
    earlier.message = first;
    if (fault === 'duplicate') f.state.page.entries.push({ ...f.state.page.entries.at(-1)!, entryId: 'duplicate' });
    if (fault === 'missing') f.state.page.entries.pop();
    if (fault === 'changed-write') f.state.page.entries.at(-1)!.message.content = 'changed';
    if (fault === 'partial') f.state.page.hasMore = true;
    if (fault === 'bytes') f.state.page.serializedBytes = MAX_TRANSCRIPT_HYDRATION_BYTES + 1;
    if (fault === 'events') while (f.state.page.entries.length <= MAX_TRANSCRIPT_HYDRATION_EVENTS) f.state.page.entries.push(earlier);
    if (fault === 'context-limit') f.state.messages.push({ role: 'toolResult', content: 'x'.repeat(MAX_TRANSCRIPT_HYDRATION_BYTES) });
    await assert.rejects(acquireOriginalUserTurns(f.options, f.readers), /context_unavailable/);
  });
}

test('positively identified foreign originals cannot supply domain quotes', async () => {
  for (const fault of ['sender', 'account', 'conversation', 'thread'] as const) {
    const f = fixture(), foreign = message('earlier', 'Foreign request');
    if (fault === 'sender') { foreign.__openclaw.senderId = 'foreign'; foreign.__openclaw.senderIdentity.id = 'foreign'; }
    if (fault === 'account') foreign.__openclaw.senderIdentity.accountId = 'foreign';
    if (fault === 'conversation') foreign.__openclaw.transport.conversationRef = 'foreign';
    if (fault === 'thread') Object.assign(foreign.__openclaw.transport, { threadId: 'foreign' });
    f.state.page.entries[0]!.message = foreign; f.state.messages[0] = structuredClone(foreign);
    const acquired = await acquireOriginalUserTurns(f.options, f.readers);
    assert.deepEqual(acquired.turns.map(turn => turn.text), ['Tomorrow at nine']);
  }
});

test('native entry identity is rechecked across asynchronous acquisition', async () => {
  for (const fault of ['identity', 'generation'] as const) {
    const f = fixture(), read = f.readers.visible;
    const readers = { ...f.readers, async visible(input: Parameters<typeof read>[0]) {
      const page = structuredClone(await read(input));
      if (f.state.reads === 2) {
        if (fault === 'identity') page.entries[0]!.entryId = 'replaced-native-entry';
        else f.state.generation = 'replaced-generation';
      }
      return page;
    } };
    await assert.rejects(acquireOriginalUserTurns(f.options, readers), /context_unavailable/);
  }
});

test('Reminder provenance consumes acquired originals and cannot use a foreign turn or a changed prefix', async () => {
  for (const foreign of [false, true]) {
    const f = fixture();
    if (foreign) {
      const first = message('earlier', 'Remind me to buy milk'); first.__openclaw.senderIdentity.accountId = 'foreign';
      f.state.page.entries[0]!.message = first; f.state.messages[0] = structuredClone(first);
    }
    const acquired = await acquireOriginalUserTurns(f.options, f.readers);
    const route = { requesterId: 'operator', sourceType: 'group' as const, sourceId: binding.peerId, senderId: binding.requesterId };
    const input: CreateInput = { requesterId: route.requesterId, sourceConversation: { type: route.sourceType, id: route.sourceId },
      recipientIds: ['operator'], content: 'buy milk', calendar: { requested: false },
      schedule: { type: 'one-shot', resolvedTime: '2026-11-03T09:00:00+02:00', timezone: 'Asia/Jerusalem' },
      provenance: { schemaVersion: 1, contextId: 'original-source', revision: 2,
        createdAt: '2026-11-02T10:00:00Z', expiresAt: '2026-11-02T10:05:00Z',
        sourceConversation: { type: route.sourceType, id: route.sourceId }, requesterId: route.requesterId,
        currentEvidenceId: 'entry-3', evidence: [{ id: 'entry-0', text: 'Remind me to buy milk' }, { id: 'entry-3', text: f.options.request }],
        fieldEvidence: [{ field: 'content', evidenceId: 'entry-0', quote: 'buy milk' },
          ...['schedule', 'calendar.requested'].map(field => ({ field, evidenceId: 'entry-3', quote: f.options.request }))] } };
    const evidence = { async readCurrentUserText() { acquired.assertCurrent(); return f.options.request; },
      async readOriginalUserTurns() { acquired.assertCurrent(); return acquired.turns; } };
    const validate = () => validateProvenance(input, evidence, route, new Date('2026-11-02T10:01:00Z'));
    if (foreign) await assert.rejects(validate(), /original turns/);
    else {
      assert(await validate());
      f.state.messages[0] = message('earlier', 'Changed source');
      await assert.rejects(validate(), /context_unavailable/);
    }
  }
});

test('the original write is not an authority default and asynchronous guards cannot grant custody', async () => {
  for (const fault of ['text', 'sender', 'message', 'provenance'] as const) {
    const f = fixture();
    if (fault === 'text') f.original.content += 'changed';
    if (fault === 'sender') f.original.__openclaw.senderIdentity.id = 'foreign';
    if (fault === 'message') f.original.__openclaw.transport.messageId = 'foreign';
    if (fault === 'provenance') Object.assign(f.original, { provenance: null });
    assert.throws(() => retainOriginalUserWrite(f.original, f.source), /context_unavailable/);
  }
  const f = fixture();
  await assert.rejects(acquireOriginalUserTurns({ ...f.options, assertCurrent: async () => {} }, f.readers), /authority/);
  await assert.rejects(acquireOriginalUserTurns(f.options, { ...f.readers, context: async () => true }), /synchronous/);
  await assert.rejects(acquireOriginalUserTurns(f.options, { ...f.readers, context: () => true }), /context_unavailable/);
});

function historicalResult(pending = true) {
  return validateDomainResultEnvelope({ schemaVersion: 3, kind: 'benson.domain-result', executionMode: 'agentic',
    domain: 'reminder', domainSchemaVersion: 'legacy-unversioned', operation: 'create',
    outcome: { disposition: pending ? 'unresolved' : 'handled', status: pending ? 'clarification_required' : 'success' },
    facts: { verified: !pending, verificationScope: pending ? [] : ['readback'], data: null },
    evidence: { observations: [], gaps: [] }, warnings: [], failures: { domain: null, handling: null },
    effects: { status: 'none', refs: [], details: [], reconciliation: { required: false, reason: null } }, uncertainty: [],
    pendingContext: pending ? { schemaVersion: 1, value: { question: 'When?' },
      binding: { requesterId: binding.requesterId, conversationId: binding.conversationRef }, expiresAt: '2026-11-02T10:30:00Z' } : null,
    content: { state: 'usable', text: pending ? 'When?' : 'Done', language: 'en' } });
}
function taskMessages(id: string, pending = true): Record<string, unknown>[] {
  const user = message(id, 'Remind me to buy milk'), result = historicalResult(pending);
  return [user, { role: 'assistant', content: [{ type: 'toolCall', id: `call-${id}`, name: 'reminder_task',
    arguments: JSON.parse(formatTaskEnvelope(user.content)) }] },
  { role: 'toolResult', toolCallId: `call-${id}`, toolName: 'reminder_task', isError: false,
    content: [{ type: 'text', text: JSON.stringify(result) }], details: result }];
}
function taskHistory(history = taskMessages('earlier')) {
  const f = fixture();
  f.state.messages = structuredClone([...history, f.original]);
  f.state.page.entries = f.state.messages.map((message, i) => ({ entryId: `entry-${i}`,
    parentId: i ? `entry-${i - 1}` : null, seq: i + 1, message: structuredClone(message) }));
  const raw = { kind: 'page', hasMore: false, cursor: 'opaque-original-cursor', serializedBytes: 4096,
    events: [{ seq: 0, event: { type: 'session', id: 'main-session' } as Record<string, unknown> },
      ...f.state.page.entries.map(entry => ({ seq: entry.seq, event: { type: 'message', id: entry.entryId,
        parentId: entry.parentId, message: structuredClone(entry.message) } as Record<string, unknown> }))] };
  const state = { rawSeq: raw.events.at(-1)!.seq, raw, reads: 0, continuation: { kind: 'page', hasMore: false,
    cursor: raw.cursor, events: [] as unknown[] }, duringRead() {} };
  const readers = { ...f.readers,
    async raw(input: { cursor?: string; maxEvents: number; maxBytes: number }) {
      assert.equal(input.maxEvents, MAX_TRANSCRIPT_HYDRATION_EVENTS);
      assert.equal(input.maxBytes, MAX_TRANSCRIPT_HYDRATION_BYTES);
      state.reads++; state.duringRead(); return input.cursor ? state.continuation : state.raw;
    },
    context(_target: unknown, read: (messages: Iterable<unknown>, header: unknown, version: unknown) => unknown) {
      return read(f.state.messages, f.state.header, { generation: f.state.generation, rawSeq: state.rawSeq });
    } };
  return { ...f, rawState: state, readers };
}

test('original consumption retains transport identity and must match the pre-effect v2 selection', async () => {
  const reference = { schemaVersion: 1 as const, domain: 'reminder' as const,
    binding: { requesterId: binding.requesterId, conversationId: binding.conversationRef },
    contextId: binding.conversationRef, revision: 1, currentEvidenceId: 'earlier' };
  for (const fault of ['none', 'v1', 'null', 'other-reference'] as const) {
    const messages = taskMessages('answer', false), result = withDomainPending(historicalResult(false), reference);
    const block = (messages[1]!.content as Record<string, unknown>[])[0]!;
    block.arguments = fault === 'v1' ? JSON.parse(formatTaskEnvelope(messages[0]!.content)) :
      createPendingTaskEnvelope(messages[0]!.content, fault === 'null' ? null :
        { ...reference, currentEvidenceId: fault === 'other-reference' ? 'foreign' : 'earlier' });
    messages[2]!.details = result; messages[2]!.content = [{ type: 'text', text: JSON.stringify(result) }];
    const f = taskHistory([...taskMessages('earlier'), ...messages]);
    const originals = await acquireOriginalUserTurns(f.options, f.readers);
    if (fault !== 'none') { await assert.rejects(originals.acquireTaskResults(), /context_unavailable/); continue; }
    const history = await originals.acquireTaskResults();
    assert.deepEqual(history.results.map(row => [row.input.entryId, row.requestId]), [['entry-0', 'earlier'], ['entry-3', 'answer']]);
  }
});

function appendHistory(f: ReturnType<typeof taskHistory>, message: Record<string, unknown>) {
  const i = f.state.messages.length, entry = { entryId: `entry-${i}`, parentId: `entry-${i - 1}`, seq: i + 1, message };
  f.state.messages.push(structuredClone(message)); f.state.page.entries.push(structuredClone(entry));
  f.rawState.raw.events.push({ seq: entry.seq, event: { type: 'message', id: entry.entryId,
    parentId: entry.parentId, message: structuredClone(message) } }); f.rawState.rawSeq = entry.seq;
}

test('Task history retains original native call/result custody and later clearing results in order', async () => {
  const f = taskHistory([...taskMessages('earlier'), ...taskMessages('replacement'), ...taskMessages('cleared', false)]);
  const users = await acquireOriginalUserTurns(f.options, f.readers), history = await users.acquireTaskResults();
  assert.deepEqual(history.results.map(item => [item.requestId, item.toolCallId, item.result.pendingContext !== null]),
    [['earlier', 'call-earlier', true], ['replacement', 'call-replacement', true], ['cleared', 'call-cleared', false]]);
  assert.equal(history.results[0]?.input.text, 'Remind me to buy milk');
  assert(Object.isFrozen(history.results[0]?.result)); assert.equal(f.rawState.reads, 2);
  assert.doesNotThrow(() => history.assertCurrent());
  // Invisible native appends still retire pending custody; they cannot hide a
  // replacement/clear behind an unchanged model-visible context.
  f.rawState.rawSeq++;
  assert.doesNotThrow(() => users.assertCurrent());
  assert.throws(() => history.assertCurrent(), /context_unavailable/);
});

test('positively identified foreign Task inputs cannot supply or clear this requester\'s pending', async () => {
  const foreign = taskMessages('foreign', false), user = foreign[0]!;
  const meta = user.__openclaw as Record<string, unknown>;
  meta.senderId = 'foreign'; (meta.senderIdentity as Record<string, unknown>).id = 'foreign';
  const f = taskHistory([...taskMessages('earlier'), ...foreign]);
  const users = await acquireOriginalUserTurns(f.options, f.readers), history = await users.acquireTaskResults();
  assert.deepEqual(history.results.map(item => item.requestId), ['earlier']);
});

test('native call IDs may repeat across original inputs while call-entry identities remain distinct', async () => {
  const requests = ['earlier', 'later'].flatMap(id => {
    const messages = taskMessages(id);
    (messages[1]!.content as Record<string, unknown>[])[0]!.id = 'reused-native-call';
    messages[2]!.toolCallId = 'reused-native-call'; return messages;
  });
  const f = taskHistory(requests), users = await acquireOriginalUserTurns(f.options, f.readers);
  const history = await users.acquireTaskResults();
  assert.deepEqual(history.results.map(item => [item.requestId, item.callEntryId, item.toolCallId]),
    [['earlier', 'entry-1', 'reused-native-call'], ['later', 'entry-4', 'reused-native-call']]);
});

test('same-input Task clearing is retained, with only the exact currently executing native Task left unsettled', async () => {
  const f = taskHistory();
  const clear = taskMessages('current-clearing', false);
  appendHistory(f, clear[1]!); appendHistory(f, clear[2]!);
  appendHistory(f, { role: 'assistant', content: [{ type: 'toolCall', id: 'current-native-call', name: 'jessica_task',
    arguments: JSON.parse(formatTaskEnvelope(f.original.content)) }] });
  const users = await acquireOriginalUserTurns(f.options, f.readers);
  await assert.rejects(users.acquireTaskResults());
  await assert.rejects(users.acquireTaskResults('foreign-call'));
  await assert.rejects(users.acquireTaskResults('call-earlier'));
  const history = await users.acquireTaskResults('current-native-call');
  assert.deepEqual(history.results.map(item => [item.requestId, item.result.pendingContext !== null]),
    [['earlier', true], ['current', false]]);
  appendHistory(f, { role: 'assistant', content: [{ type: 'toolCall', id: 'other-inflight-call', name: 'reminder_task', arguments: {} }] });
  await assert.rejects(users.acquireTaskResults('current-native-call'));
  assert.throws(() => history.assertCurrent(), /context_unavailable/);
});

for (const fault of ['missing-reader', 'partial', 'bytes', 'header', 'branch', 'reset', 'compaction', 'omitted-result',
  'changed-result', 'duplicate-call', 'duplicate-result', 'missing-call', 'failed-result', 'wrong-domain',
  'wrong-args', 'content-mismatch', 'hidden-result', 'cursor-reset', 'cursor-append', 'version', 'retired'] as const) {
  test(`original Task-result acquisition fails closed: ${fault}`, async () => {
    const f = taskHistory(), users = await acquireOriginalUserTurns(f.options, f.readers);
    const rows = f.rawState.raw.events, call = rows[2]!.event, result = rows[3]!.event;
    if (fault === 'missing-reader') delete (f.readers as { raw?: unknown }).raw;
    if (fault === 'partial') f.rawState.raw.hasMore = true;
    if (fault === 'bytes') f.rawState.raw.serializedBytes = MAX_TRANSCRIPT_HYDRATION_BYTES + 1;
    if (fault === 'header') rows[0]!.event.id = 'foreign-session';
    if (fault === 'branch') call.parentId = null;
    if (fault === 'reset' || fault === 'compaction') call.type = fault;
    if (fault === 'omitted-result') rows.splice(3, 1);
    if (fault === 'changed-result') (result.message as Record<string, unknown>).content = 'changed';
    if (fault === 'hidden-result') { f.state.messages.splice(2, 1); f.state.page.entries.splice(2, 1); }
    if (fault === 'cursor-reset') f.rawState.continuation.kind = 'reset';
    if (fault === 'cursor-append') f.rawState.continuation.events.push({ seq: 5 });
    if (fault === 'version') f.rawState.rawSeq++;
    if (fault === 'retired') f.state.live = false;
    // Corrupt native shapes consistently in every view. Cross-reader equality
    // cannot substitute for original tool pairing and domain validation.
    if (['duplicate-call', 'duplicate-result', 'missing-call', 'failed-result', 'wrong-domain', 'wrong-args', 'content-mismatch'].includes(fault)) {
      const messages = structuredClone(f.state.messages);
      if (fault === 'duplicate-call') (messages[1]!.content as unknown[]).push((messages[1]!.content as unknown[])[0]);
      if (fault === 'duplicate-result') messages.splice(3, 0, structuredClone(messages[2]!));
      if (fault === 'missing-call') messages[1]!.content = [];
      if (fault === 'failed-result') messages[2]!.isError = true;
      if (fault === 'wrong-domain') {
        const details = structuredClone(messages[2]!.details) as Record<string, unknown>;
        details.domain = 'jessica-vacuum'; messages[2]!.details = details;
        messages[2]!.content = [{ type: 'text', text: JSON.stringify(details) }];
      }
      if (fault === 'wrong-args') ((messages[1]!.content as Record<string, unknown>[])[0]!.arguments as Record<string, unknown>).request = 'foreign';
      if (fault === 'content-mismatch') messages[2]!.content = [{ type: 'text', text: '{}' }];
      const corrupted = taskHistory(messages.slice(0, -1));
      const original = await acquireOriginalUserTurns(corrupted.options, corrupted.readers);
      await assert.rejects(original.acquireTaskResults()); return;
    }
    await assert.rejects(users.acquireTaskResults());
  });
}

test('asynchronous raw acquisition cannot grant a snapshot after an invisible append', async () => {
  const f = taskHistory(), users = await acquireOriginalUserTurns(f.options, f.readers);
  f.rawState.duringRead = () => { if (f.rawState.reads === 2) f.rawState.rawSeq++; };
  await assert.rejects(users.acquireTaskResults(), /context_unavailable/);
});

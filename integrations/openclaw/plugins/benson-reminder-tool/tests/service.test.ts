import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadIdentityContract, resolveRoute } from '../../../../../agents/reminder-service/lib/identity.js';
import { executeReminderTool, type Dependencies } from '../../../../../agents/reminder-service/lib/service.js';
import { executeReminderListTask } from '../../../../../agents/reminder-service/lib/task.js';
import { safeListResult, normalizeReminderServiceResult, SERVICE_OPERATIONS } from '../../../../../agents/reminder-service/lib/results.js';
import { plain } from '../../../benson-routing/core/value.js';
import { createCurrentRequestContext } from '../../../benson-routing/core/conversation-context.js';
import { createReminderToolFactory } from '../src/tool.js';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import type { ToolName } from '../../../../../agents/reminder-service/lib/schemas.js';
import { schemaForTool } from '../../../../../agents/reminder-service/lib/tool-contracts.js';
function fixture() {
  const roster: unknown = JSON.parse(readFileSync('agents/reminder-service/config/recipients.json', 'utf8'));
  const identities = loadIdentityContract(roster); assert.ok(plain(roster) && Array.isArray(roster.recipients));
  const person = roster.recipients.find((value: unknown) => plain(value) && value.id === 'oren'); assert.ok(plain(person) && typeof person.to === 'string');
  const route = resolveRoute(identities, { channel: 'whatsapp', accountId: identities.accountId, to: person.to, senderId: person.to }); assert.ok(route);
  let live = true; const abort = new AbortController(), calls: unknown[] = [];
  const records = [1, 2, 3].map(i => ({ schemaVersion: 4, reminderId: `reminder-${i}`, status: 'active', content: `fixture ${i}`, schedules: [{ type: 'one-shot', resolvedTime: '2026-10-18T10:00:00+03:00', timezone: 'Asia/Jerusalem' }] }));
  const state = { result: { status: 'success', operation: 'list', verified: true, matchCount: 3, matches: records, warnings: [] }, taskText: 'Create reminder tomorrow', turns: [{ text: 'Create reminder tomorrow' }] };
  const deps: Dependencies = { identities, route, clock: () => new Date('2026-10-17T12:00:00Z'), authority: { signal: abort.signal, assertCurrent() { if (!live) throw new Error('invocation retired'); } },
    evidence: { async readCurrentUserText() { return state.taskText; }, async readOriginalUserTurns() { return state.turns; } },
    transaction: { async execute(request) { calls.push(request); return structuredClone(state.result); } } };
  const input = { sourceConversation: { type: 'private', id: route.sourceId }, requesterId: 'oren', recipientIds: ['oren'], content: 'contract create',
    schedule: { type: 'one-shot', resolvedTime: '2026-10-18T10:00:00+03:00', timezone: 'Asia/Jerusalem' }, calendar: { requested: false } };
  const provenance = { schemaVersion: 1, contextId: 'fixture-context', revision: 1, createdAt: '2026-10-17T11:59:00Z', expiresAt: '2026-10-17T12:30:00Z',
    sourceConversation: input.sourceConversation, requesterId: 'oren', currentEvidenceId: 'turn-1', evidence: [{ id: 'turn-1', text: state.taskText }],
    fieldEvidence: ['content', 'schedule', 'calendar.requested'].map(field => ({ field, evidenceId: 'turn-1', quote: state.taskText })) };
  return { deps, state, calls, input, provenance, abort, retire: () => { live = false; } };
}
test('raw native Reminder tools preserve existing schemas and whole transactions without child channel context', async () => {
  const f = fixture();
  let expected: unknown;
  const source: Dependencies = { ...f.deps, transaction: { async execute(request, authority) {
    authority.assertCurrent(); f.calls.push(request);
    const operation = SERVICE_OPERATIONS[request.operation];
    expected = operation === 'list' || operation === 'find' ? { ...f.state.result, operation }
      : { operation, status: 'success', transaction: { status: 'success', verified: true },
        data: { reminderIds: ['fixture-only'] }, transport: { deliveries: [] }, warnings: [] };
    return expected;
  } } };
  const context: OpenClawPluginToolContext<2> = { agentId: 'reminder-service', assertInvocationCurrent() {} };
  const payloads: Partial<Record<ToolName, unknown>> = {
    benson_reminder_create: { input: { ...f.input, provenance: f.provenance } },
    benson_reminder_list: { requesterId: 'oren' }, benson_reminder_find: { requesterId: 'oren', text: 'fixture' },
    benson_reminder_update: { requesterId: 'oren', reminderId: 'existing', input: { content: 'updated' } },
    benson_reminder_pause: { requesterId: 'oren', reminderId: 'existing' },
    benson_reminder_resume: { requesterId: 'oren', reminderId: 'existing' },
    benson_reminder_delete: { requesterId: 'oren', reminderId: 'existing' },
  };
  for (const name of [...Object.keys(payloads), 'benson_reminder_create_plan'] as ToolName[]) {
    const create = createReminderToolFactory({ name, source,
      jsonResult: value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }) });
    assert.equal(create({ ...context, agentId: 'main' }), null);
    const tool = create(context); assert(tool && !Array.isArray(tool));
    assert.deepEqual(tool.parameters, schemaForTool(name, f.deps.identities, f.deps.route));
    if (Object.hasOwn(payloads, name)) assert.deepEqual((await tool.execute(name, payloads[name])).details, expected);
  }
  assert.equal(f.calls.length, 7);
});
test('raw Reminder validates operation and transaction before model disclosure, preserving truthful failure effects', async () => {
  for (const fault of ['unverified', 'foreign-operation', 'malformed', 'truthful-failure'] as const) {
    const f = fixture(); let serialized = 0, transactions = 0;
    const raw = fault === 'malformed' ? { status: 'success' } : fault === 'truthful-failure'
      ? { operation: 'delete', status: 'failure', error: { code: 'UNKNOWN_EFFECT', message: 'Reconciliation required', retryable: false },
        transaction: { status: 'unknown', verified: false }, data: { possibleEffectRef: 'original-operation' }, transport: { deliveries: [] } }
      : { operation: fault === 'foreign-operation' ? 'list' : 'delete', status: 'success',
        transaction: { status: 'success', verified: fault !== 'unverified' }, data: { reminderIds: ['existing'] }, transport: { deliveries: [] } };
    const create = createReminderToolFactory({ name: 'benson_reminder_delete', source: { ...f.deps,
      transaction: { async execute(request, authority) { authority.assertCurrent(); assert.equal(request.operation, 'delete-reminder'); transactions++; return raw; } } },
      jsonResult(value) { serialized++; return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; } });
    const tool = create({ agentId: 'reminder-service', assertInvocationCurrent() {} }); assert(tool && !Array.isArray(tool));
    const output = tool.execute('original-call', { requesterId: 'oren', reminderId: 'existing' });
    if (fault === 'truthful-failure') { assert.deepEqual((await output).details, raw); assert.equal(serialized, 1); }
    else { await assert.rejects(output); assert.equal(serialized, 0); }
    assert.equal(transactions, 1);
  }
});
test('raw Reminder source retirement, forged requester and native retirement across evidence await fail closed', async () => {
  for (const mode of ['retired-source', 'foreign-requester', 'retired-child', 'aborted'] as const) {
    const f = fixture(); let live = true;
    const source = { ...f.deps, evidence: { ...f.deps.evidence, async readCurrentUserText() { live = false; return f.state.taskText; } } };
    const create = createReminderToolFactory({ name: 'benson_reminder_create', source,
      jsonResult: value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }) });
    const tool = create({ agentId: 'reminder-service', assertInvocationCurrent() { assert(live, 'child retired'); } }); assert(tool && !Array.isArray(tool));
    if (mode === 'retired-source') f.retire();
    if (mode === 'aborted') f.abort.abort();
    const input = { ...f.input, provenance: f.provenance, ...(mode === 'foreign-requester' ? { requesterId: 'foreign' } : {}) };
    await assert.rejects(tool.execute('blocked', { input })); assert.equal(f.calls.length, 0);
  }
});
test('complete list task preserves full facts/prepared content, direct and observed Code Mode carrier shape', async () => {
  const f = fixture(); const task = async (request: unknown) => executeReminderListTask('native-fixture-call', request, f.deps);
  const carrier = { available: true, result: await task({ operation: 'list' }) };
  assert.equal(carrier.result.executionMode, 'deterministic'); assert.equal(carrier.result.facts.verified, true);
  assert.equal(f.calls.length, 1); assert.equal(carrier.result.kind, 'benson.domain-result');
  assert.equal(carrier.result.effects.status, 'none');
  assert.ok(carrier.result.content?.state === 'usable');
  for (const record of f.state.result.matches) assert.ok(carrier.result.content.text.includes(record.content));
  assert.deepEqual(JSON.parse(JSON.stringify(carrier.result)).facts.data.matches, f.state.result.matches);
  assert.equal(Object.hasOwn(carrier.result, 'runId'), false);
});
test('malformed, duplicate, unknown-version or contradictory lists fail closed without backend diagnostic disclosure', async () => {
  const f = fixture();
  for (const value of [{ ...f.state.result, matchCount: 9 }, { ...f.state.result, verified: false }, { ...f.state.result, error: { code: 'BAD' } },
    { ...f.state.result, matches: [f.state.result.matches[0], f.state.result.matches[0]], matchCount: 2 },
    { ...f.state.result, matches: [{ ...f.state.result.matches[0], schemaVersion: 99 }], matchCount: 1 }]) assert.equal(safeListResult(value).status, 'failure');
  const deps: Dependencies = { ...f.deps, transaction: { async execute() { return { operation: 'list', status: 'failure', verified: false, warnings: [], error: { code: 'REMINDER_AUTOMATION_PARTIAL_STATE', message: 'private backend diagnostic', retryable: false } }; } } };
  const result = await executeReminderListTask('safe-call', { operation: 'list' }, deps);
  assert.equal(result.outcome.disposition, 'failed'); assert.equal(JSON.stringify(result).includes('private backend diagnostic'), false);
  assert.equal(result.failures.handling?.code, 'REMINDER_AUTOMATION_PARTIAL_STATE');
});
test('oversized list rejects without truncating; forged intent and cancellation cannot invoke or disclose', async () => {
  const f = fixture(); const first = f.state.result.matches[0]; assert.ok(first); first.content = 'x'.repeat(100_000);
  await assert.rejects(executeReminderListTask('large', { operation: 'list' }, f.deps)); assert.equal(f.calls.length, 1);
  await assert.rejects(executeReminderListTask('forged', { operation: 'list', requesterId: 'foreign' }, f.deps)); assert.equal(f.calls.length, 1);
  f.retire(); await assert.rejects(executeReminderListTask('closed', { operation: 'list' }, f.deps)); assert.equal(f.calls.length, 1);
  const g = fixture();
  await assert.rejects(executeReminderListTask('await-revoke', { operation: 'list' }, { ...g.deps, transaction: { async execute() { g.retire(); return g.state.result; } } }));
});
test('provenance binds current task, ordered original turns, route, expiry, revision and every semantic field', async () => {
  const f = fixture(); await executeReminderTool('benson_reminder_create', { input: { ...f.input, provenance: f.provenance } }, f.deps); assert.equal(f.calls.length, 1);
  const variants = [{ ...f.provenance, requesterId: 'ilana' }, { ...f.provenance, revision: 2 }, { ...f.provenance, expiresAt: '2026-10-16T00:00:00Z' },
    { ...f.provenance, fieldEvidence: f.provenance.fieldEvidence.slice(1) }, { ...f.provenance, evidence: [{ id: 'turn-1', text: 'invented evidence' }] }];
  for (const provenance of variants) await assert.rejects(executeReminderTool('benson_reminder_create', { input: { ...f.input, provenance } }, f.deps));
  f.state.turns.push({ text: 'new user request' }); await assert.rejects(executeReminderTool('benson_reminder_create', { input: { ...f.input, provenance: f.provenance } }, f.deps));
  assert.equal(f.calls.length, 1);
});
test('current-request projection grounds self-contained Reminder creation without claiming acquired history', async () => {
  const f = fixture();
  const text = 'Remind me to drink water tomorrow at 10:00, without a calendar event.';
  let changed = false, changeAfterRead = false, transactions = 0;
  const context = createCurrentRequestContext({ request: text,
    binding: { conversationRef: 'fixture-context', channel: 'whatsapp', accountId: f.deps.identities.accountId,
      kind: 'direct', peerId: f.deps.route.sourceId, threadId: null, requesterId: f.deps.route.sourceId },
    currentTurn: () => ({ entryId: changed ? 'replacement' : 'turn-1', role: 'user', text,
      sender: { source: 'canonical_peer_binding', id: f.deps.route.sourceId,
        channel: 'whatsapp', accountId: f.deps.identities.accountId }, inputProvenance: { kind: 'external_user' } }),
    assertCurrent: () => f.deps.authority.assertCurrent(),
    assertAuthorized(turn) { assert.equal(turn.sender?.id, f.deps.route.sourceId); },
  });
  const projection = context.projectCurrentRequest(); assert.equal(projection.status, 'available');
  assert(projection.status === 'available');
  const retained = projection;
  function currentText() {
    const value = context.revalidateProjection(retained); assert(value.status === 'available');
    assert.equal(value.context.history.status, 'not_acquired');
    return value.context.current.text;
  }
  const deps: Dependencies = { ...f.deps,
    evidence: {
      async readCurrentUserText() {
        const value = currentText(); await Promise.resolve();
        if (changeAfterRead) changed = true;
        return value;
      },
      // Only this authenticated current turn is available. Prior turns are
      // neither reconstructed nor asserted absent; multi-turn evidence fails.
      async readOriginalUserTurns() { return [{ text: currentText() }]; },
    },
    transaction: { async execute(request, authority) {
      authority.assertCurrent(); currentText(); transactions++;
      assert.equal(request.operation, 'create-intent');
      return { operation: 'create', status: 'success', transaction: { status: 'success', verified: true },
        data: { reminderIds: ['fixture-only'] }, transport: { deliveries: [] }, warnings: [] };
    } },
  };
  const input = { ...f.input, content: 'drink water', provenance: { ...f.provenance,
    evidence: [{ id: 'turn-1', text }], fieldEvidence: [
      { field: 'content', evidenceId: 'turn-1', quote: 'drink water' },
      { field: 'schedule', evidenceId: 'turn-1', quote: 'tomorrow at 10:00' },
      { field: 'calendar.requested', evidenceId: 'turn-1', quote: 'without a calendar event' },
    ] } };
  const result = await executeReminderTool('benson_reminder_create', { input }, deps);
  assert(plain(result)); assert.equal(result.operation, 'create'); assert.equal(transactions, 1);
  const earlier = { ...input, provenance: { ...input.provenance, revision: 2, currentEvidenceId: 'turn-1',
    evidence: [{ id: 'previous', text: 'Use my earlier reminder details' }, ...input.provenance.evidence] } };
  await assert.rejects(executeReminderTool('benson_reminder_create', { input: earlier }, deps));
  assert.equal(transactions, 1);
  changeAfterRead = true;
  await assert.rejects(executeReminderTool('benson_reminder_create', { input }, deps));
  assert.equal(transactions, 1);
});
test('multi-turn/multi-schedule provenance and metadata remain grounded before one whole transaction', async () => {
  const f = fixture(), previous = 'Remind me about coffee'; f.state.taskText = `${previous}\n${f.state.taskText}`; f.state.turns.unshift({ text: previous });
  const schedules = [f.input.schedule, { ...f.input.schedule, resolvedTime: '2026-10-19T10:00:00+03:00' }];
  const { schedule: _schedule, ...base } = f.input;
  const provenance = { ...f.provenance, revision: 2, currentEvidenceId: 'turn-2', evidence: [{ id: 'turn-1', text: previous }, { id: 'turn-2', text: 'Create reminder tomorrow' }],
    fieldEvidence: ['content', 'calendar.requested', 'schedules[0]', 'schedules[1]'].map(field => ({ field, evidenceId: 'turn-2', quote: 'Create reminder tomorrow' })) };
  await executeReminderTool('benson_reminder_create', { input: { ...base, schedules, provenance } }, f.deps);
  assert.equal(f.calls.length, 1);
  await assert.rejects(executeReminderTool('benson_reminder_create', { input: { ...base, schedules } }, f.deps));
  const reverse = { ...provenance, evidence: [...provenance.evidence].reverse(), currentEvidenceId: 'turn-1' };
  await assert.rejects(executeReminderTool('benson_reminder_create', { input: { ...base, schedules, provenance: reverse } }, f.deps));
  const meta = { ...f.input, calendar: { requested: true, summary: { value: 'coffee', evidenceQuote: previous, evidenceId: 'turn-1' } } };
  await assert.rejects(executeReminderTool('benson_reminder_create', { input: meta }, f.deps)); assert.equal(f.calls.length, 1);
});
test('service normalization preserves verified transaction/effects and refuses unverified or foreign results', () => {
  const trusted = { taskId: 'fixture-task', pendingBinding: null, pendingExpiresAt: null };
  const result = { status: 'success', operation: 'create', transaction: { status: 'success', verified: true }, data: { reminderIds: ['r'] },
    transport: { deliveries: [] }, calendar: { requested: true, eventIds: ['event-1'] }, warnings: [] };
  const normalized = normalizeReminderServiceResult('create-intent', result, trusted);
  assert.equal(normalized.verified, true); assert.ok(JSON.stringify(normalized).includes('event-1'));
  assert.throws(() => normalizeReminderServiceResult('pause-reminder', result, trusted));
  assert.throws(() => normalizeReminderServiceResult('create-intent', { ...result, transaction: { status: 'success', verified: false } }, trusted));
});
test('asynchronous assertion callbacks fail closed before reads or mutations', async () => {
  const f = fixture();
  const deps = { ...f.deps, authority: { signal: f.abort.signal, async assertCurrent() {} } };
  await assert.rejects(executeReminderTool('benson_reminder_list', { requesterId: 'oren' }, deps), /synchronous/); assert.equal(f.calls.length, 0);
});

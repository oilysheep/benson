import assert from 'node:assert/strict';
import test from 'node:test';
import { createCurrentRequestContext, createRoutingContextController, reconstructDomainPending, type ConversationEvidence, type ConversationTurn } from '../core/conversation-context.js';
import { validateDomainResultEnvelope, withDomainPending, readDomainFactsData } from '../core/domain-result.js';
import type { AnyDomainResult, ConsumedPending } from '../core/contracts.js';
import type { Pending } from '../core/value.js';
import { ROUTING_TRANSCRIPT_TIERS, MAX_ROUTING_CONTEXT_BYTES } from '../core/request-control.js';
const binding = { conversationRef: 'conversation', channel: 'fixture-channel', accountId: 'account', kind: 'group' as const,
  peerId: 'group', threadId: null, requesterId: 'reader' };
const cutoff = { sessionId: 'session', generation: 'generation', entryId: 'current', effectiveParentId: 'previous-7' };
const message = (id: string, text = id): ConversationTurn => ({ entryId: id, role: 'user', text,
  sender: { source: 'native_metadata', id: 'reader', identity: { type: 'observation', id: 'reader', pluginId: binding.channel, accountId: binding.accountId }, name: null, username: null }, inputProvenance: { kind: 'external_user' } });
function fixture() {
  const state = { live: true, reads: 0, workflows: 0, authorized: [] as string[], denied: new Set<string>(),
    current: message('current', 'exact current request'),
    workflow: { status: 'available', revision: 'revision-1', active: [] as unknown[], pending: [] as unknown[] },
    snapshots: [] as unknown[], afterRead: () => {}, afterWorkflow: () => {} };
  const evidence: ConversationEvidence = { binding, cutoff, request: state.current.text,
    currentTurn: () => state.current,
    assertCurrent() { assert.ok(state.live, 'closed'); },
    assertAuthorized(turn) { assert.ok(!state.denied.has(turn.entryId), 'denied'); state.authorized.push(turn.entryId); },
    async readBefore(tier, signal) {
      assert.deepEqual(tier, ROUTING_TRANSCRIPT_TIERS[state.reads]); signal?.throwIfAborted();
      const snapshot = state.snapshots[state.reads++]; await Promise.resolve(); state.afterRead(); return snapshot;
    },
    async readWorkflow() { state.workflows++; await Promise.resolve(); state.afterWorkflow(); return state.workflow; },
  };
  return { state, evidence, controller: createRoutingContextController(evidence) };
}
function snapshot(entries: unknown[], historyTruncated = false) {
  return { status: 'available', cutoff: { ...cutoff }, beforeCurrent: true, branchSuffix: true, historyTruncated, entries };
}
function workflowReferences(ids: string[]) {
  return { workflowId: 'legacy-workflow', metadata: { marker: 'retained compatibility' }, turnReferences: ids.map(entryId => ({
    entryId, conversationRef: binding.conversationRef, sessionId: cutoff.sessionId, generation: cutoff.generation })) };
}

test('current-request-only preserves exact input without acquiring or inventing history', () => {
  const f = fixture(), controller = createCurrentRequestContext(f.evidence);
  const projection = controller.projectCurrentRequest(); assert(projection.status === 'available');
  assert.equal(projection.scope, 'current-request-only');
  assert.deepEqual(JSON.parse(projection.serialized), { current: f.state.current, conversation: binding, history: { status: 'not_acquired' } });
  assert.equal(projection.serialized, JSON.stringify(projection.context));
  assert.equal(projection.byteLength, Buffer.byteLength(projection.serialized));
  assert(Object.isFrozen(projection.context.current.sender)); assert(Object.isFrozen(projection.context.history));
  assert.equal(f.state.reads, 0); assert.equal(f.state.workflows, 0);
  assert.equal(controller.revalidateProjection(projection), projection);
  assert.equal(controller.revalidateProjection(structuredClone(projection)).status, 'unavailable');
  assert.equal(createCurrentRequestContext(f.evidence).revalidateProjection(projection).status, 'unavailable');
});

test('current-request-only rechecks authority, identity and unchanged input across an await', async () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => { f.state.live = false; },
    (f: ReturnType<typeof fixture>) => { f.state.denied.add('current'); },
    (f: ReturnType<typeof fixture>) => { f.state.current = message('replacement', f.evidence.request); },
    (f: ReturnType<typeof fixture>) => { f.state.current.text = 'changed'; },
    (f: ReturnType<typeof fixture>) => { f.state.current.sender = null; },
    (f: ReturnType<typeof fixture>) => { f.state.current.inputProvenance = null; },
  ]) {
    const f = fixture(), controller = createCurrentRequestContext(f.evidence);
    const projection = controller.projectCurrentRequest(); assert(projection.status === 'available');
    await Promise.resolve(); invalidate(f);
    const result = controller.revalidateProjection(projection);
    assert.equal(result.status, 'unavailable'); assert(!JSON.stringify(result).includes(f.evidence.request));
  }
  const f = fixture(), controller = createCurrentRequestContext(f.evidence);
  const projection = controller.projectCurrentRequest(); assert(projection.status === 'available');
  assert.equal(controller.revalidateProjection(projection, { signal: AbortSignal.abort() }).status, 'unavailable');
});

test('current-request-only rejects foreign provenance, async guards and out-of-bound exact text', async () => {
  for (const field of ['pluginId', 'accountId', 'id']) {
    const f = fixture(); assert(f.state.current.sender?.source === 'native_metadata');
    f.state.current.sender.identity[field] = 'foreign';
    assert.equal(createCurrentRequestContext(f.evidence).projectCurrentRequest().status, 'unavailable');
  }
  for (const key of ['assertCurrent', 'assertAuthorized'] as const) {
    const f = fixture(); f.evidence[key] = async () => { throw new Error('authority unavailable'); };
    assert.equal(createCurrentRequestContext(f.evidence).projectCurrentRequest().status, 'unavailable');
  }
  for (const text of ['א'.repeat(4096), 'א'.repeat(4097)]) {
    const f = fixture(); f.state.current.text = text;
    assert.equal(createCurrentRequestContext({ ...f.evidence, request: text }).projectCurrentRequest().status, text.length === 4096 ? 'available' : 'unavailable');
  }
  const f = fixture(); f.state.current.inputProvenance = { kind: 'external_user', excessive: 'x'.repeat(MAX_ROUTING_CONTEXT_BYTES) };
  assert.equal(createCurrentRequestContext(f.evidence).projectCurrentRequest().status, 'unavailable');
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('normalized ConversationEvidence preserves five exact previous turns, referenced older turns and immutable cutoff', async () => {
  const f = fixture(); f.state.snapshots = [snapshot(Array.from({ length: 7 }, (_, i) => message(`previous-${i + 1}`)))];
  f.state.workflow.active = [workflowReferences(['previous-1', 'previous-7', 'current'])];
  const result = await f.controller.projectRoutingContext(); assert.ok(result.status === 'available');
  assert.deepEqual(result.context.previous.map(turn => turn.entryId), ['previous-3', 'previous-4', 'previous-5', 'previous-6', 'previous-7']);
  assert.deepEqual(result.context.older.map(turn => turn.entryId), ['previous-1']);
  assert.equal(result.context.current.text, 'exact current request'); assert.deepEqual(result.cutoff.admission, cutoff);
  assert.equal(result.serialized, JSON.stringify(result.context)); assert.equal(result.byteLength, Buffer.byteLength(result.serialized));
  assert.ok(Object.isFrozen(result.context.current.sender));
  assert.equal((await f.controller.revalidateProjection(result)).status, 'available');
  assert.equal((await fixture().controller.revalidateProjection(result)).status, 'unavailable');
  assert.equal((await f.controller.revalidateProjection(structuredClone(result))).status, 'unavailable');
});

test('three fixed tiers reuse one cutoff; complete reads and five prior turns stop escalation', async () => {
  for (const stop of ['complete', 'five', 'partial'] as const) {
    const f = fixture();
    f.state.snapshots = [snapshot([message('one')], true), snapshot([message('one'), message('two')], stop !== 'complete'),
      snapshot(Array.from({ length: stop === 'five' ? 5 : 3 }, (_, i) => message(`m${i}`)), true)];
    const result = await f.controller.projectRoutingContext(); assert.ok(result.status === 'available');
    assert.equal(f.state.reads, stop === 'complete' ? 2 : 3);
    assert.equal(result.context.history.historyTruncated, stop !== 'complete');
    assert.deepEqual(result.cutoff.admission, cutoff);
  }
  const f = fixture(); f.state.snapshots = [snapshot(Array.from({ length: 5 }, (_, i) => message(`m${i}`)), true)];
  assert.equal((await f.controller.projectRoutingContext()).status, 'available'); assert.equal(f.state.reads, 1);
});

test('empty available history differs from unavailable history; reset excludes earlier references', async () => {
  const empty = fixture(); empty.state.snapshots = [snapshot([])];
  const result = await empty.controller.projectRoutingContext(); assert.ok(result.status === 'available');
  assert.equal(result.context.previous.length, 0); assert.equal(result.context.history.historyTruncated, false);
  const absent = fixture(); absent.state.snapshots = [{ status: 'unavailable', reason: 'fixture gap' }];
  assert.equal((await absent.controller.projectRoutingContext()).status, 'unavailable');
  const reset = fixture(); reset.state.snapshots = [snapshot([message('earlier'), { kind: 'reset' }, message('later')])];
  reset.state.workflow.active = [workflowReferences(['earlier'])];
  const failed = await reset.controller.projectRoutingContext(); assert.ok(failed.status === 'unavailable'); assert.match(failed.reason, /reference_unavailable/);
});

test('wrong incarnation, missing native suffix/cutoff proof and current/future entries fail closed', async () => {
  for (const change of [{ cutoff: { ...cutoff, generation: 'different' } }, { beforeCurrent: false }, { branchSuffix: false },
    { entries: [message('current')] }, { entries: [message('one'), message('one')] }]) {
    const f = fixture(); f.state.snapshots = [{ ...snapshot([message('previous')]), ...change }];
    assert.equal((await f.controller.projectRoutingContext()).status, 'unavailable');
  }
});

test('request text and requester correlation cannot be substituted by a normalized turn', async () => {
  for (const current of [message('other-current', 'exact current request'), message('current', 'different request'),
    { ...message('current', 'exact current request'), role: 'assistant' },
    { ...message('current', 'exact current request'), sender: { id: 'foreign' } }]) {
    const f = fixture(); f.evidence.currentTurn = () => current;
    assert.equal((await f.controller.projectRoutingContext()).status, 'unavailable'); assert.equal(f.state.reads, 0);
  }
});

test('all included turns are reauthorized and currentness is checked across every awaited read', async () => {
  for (const phase of ['read', 'workflow', 'disclosure'] as const) {
    const f = fixture(); f.state.snapshots = [snapshot([message('previous')])];
    if (phase === 'read') f.state.afterRead = () => { f.state.live = false; };
    if (phase === 'workflow') f.state.afterWorkflow = () => { f.state.live = false; };
    if (phase === 'disclosure') f.state.afterRead = () => { f.state.denied.add('previous'); };
    assert.equal((await f.controller.projectRoutingContext()).status, 'unavailable');
  }
  const f = fixture(); f.state.snapshots = [snapshot([message('previous')])];
  const result = await f.controller.projectRoutingContext(); assert.ok(result.status === 'available');
  f.state.denied.add('previous'); assert.equal((await f.controller.revalidateProjection(result)).status, 'unavailable');
});

test('legacy workflow content changes without a revision invalidate retained projections', async () => {
  const f = fixture(); f.state.snapshots = [snapshot([message('previous')])]; f.state.workflow.active = [workflowReferences(['previous'])];
  const result = await f.controller.projectRoutingContext(); assert.ok(result.status === 'available');
  f.state.workflow.active = [{ ...workflowReferences(['previous']), metadata: { changed: true } }];
  const checked = await f.controller.revalidateProjection(result); assert.ok(checked.status === 'unavailable'); assert.match(checked.reason, /workflow_context_changed/);
});

test('context text is never truncated; byte, reference and metadata bounds preserve their separate budgets', async () => {
  const fits = fixture(); fits.state.snapshots = [snapshot([message('previous', 'x'.repeat(20000))])];
  const result = await fits.controller.projectRoutingContext(); assert.ok(result.status === 'available');
  assert.equal(result.context.previous[0]?.text.length, 20000); assert.ok(result.byteLength <= MAX_ROUTING_CONTEXT_BYTES);
  const huge = fixture(); huge.state.snapshots = [snapshot([message('previous', 'א'.repeat(20000))])];
  const failure = await huge.controller.projectRoutingContext(); assert.ok(failure.status === 'unavailable'); assert.match(failure.reason, /routing_context_bounds/);
  for (const ids of [Array.from({ length: 17 }, (_, i) => `m${i}`), ['missing']]) {
    const f = fixture(); f.state.snapshots = [snapshot([])]; f.state.workflow.active = [workflowReferences(ids)];
    assert.equal((await f.controller.projectRoutingContext()).status, 'unavailable');
  }
  const deep = fixture(); let metadata: unknown = null;
  for (let i = 0; i < 13; i++) metadata = { next: metadata };
  deep.state.workflow.active = [{ ...workflowReferences([]), metadata }]; deep.state.snapshots = [snapshot([])];
  assert.equal((await deep.controller.projectRoutingContext()).status, 'unavailable');
});

test('cancellation and asynchronous authority callbacks cannot disclose context or produce unhandled rejection', async () => {
  const aborted = fixture(); const signal = AbortSignal.abort();
  assert.equal((await aborted.controller.projectRoutingContext({ signal })).status, 'unavailable'); assert.equal(aborted.state.reads, 0);
  for (const assertCurrent of [() => false, async () => { throw new Error('closed'); }]) {
    const f = fixture(); const controller = createRoutingContextController({ ...f.evidence, assertCurrent });
    assert.equal((await controller.projectRoutingContext()).status, 'unavailable'); assert.equal(f.state.reads, 0);
  }
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('group attribution is not permission and malformed sender/channel/account provenance is rejected', async () => {
  for (const sender of [
    { source: 'canonical_peer_binding', id: 'reader', channel: binding.channel, accountId: binding.accountId },
    { source: 'native_metadata', id: 'reader', identity: { type: 'observation', id: 'foreign', pluginId: binding.channel, accountId: binding.accountId }, name: null, username: null },
    { source: 'native_metadata', id: 'reader', identity: { type: 'observation', id: 'reader', pluginId: 'foreign', accountId: binding.accountId }, name: null, username: null },
  ]) {
    const f = fixture(); f.evidence.currentTurn = () => ({ ...f.state.current, sender });
    assert.equal((await f.controller.projectRoutingContext()).status, 'unavailable');
  }
});

const pendingBinding = { requesterId: 'reader', conversationId: 'conversation' };
const pendingTime = new Date('2026-11-02T12:00:00Z');
function domainPending(id: string, revision = 1): Pending {
  return { schemaVersion: 1, binding: { ...pendingBinding }, expiresAt: '2026-11-02T12:20:00Z',
    value: { contextId: 'conversation', revision, currentEvidenceId: id } };
}
function pendingReference(pending: Pending): ConsumedPending {
  return { schemaVersion: 1, domain: 'reminder', binding: { ...pending.binding },
    contextId: String(pending.value.contextId), revision: Number(pending.value.revision), currentEvidenceId: String(pending.value.currentEvidenceId) };
}
function pendingResult(pending: Pending | null, consumed: ConsumedPending | null = null, status = pending ? 'clarification_required' : 'success'): AnyDomainResult {
  const value = validateDomainResultEnvelope({ schemaVersion: 3, kind: 'benson.domain-result', executionMode: 'agentic',
    domain: 'reminder', domainSchemaVersion: 'legacy-unversioned', operation: 'create',
    outcome: { disposition: status === 'failure' ? 'failed' : 'handled', status },
    facts: { verified: status === 'success', verificationScope: status === 'success' ? ['transaction'] : [], data: { question: 'When?' } },
    evidence: { observations: [], gaps: [] }, warnings: [], failures: { domain: status === 'failure' ? { code: 'DENIED' } : null, handling: null },
    effects: { status: 'none', refs: [], details: [], reconciliation: { required: false, reason: null } }, uncertainty: [],
    pendingContext: pending, content: { state: 'unavailable', reason: { code: 'PRESENTATION_REQUIRED', detail: 'Use domain renderer' } } });
  return withDomainPending(value, consumed);
}
function pendingHistory(rows: { input: { entryId: string }; entryId: string; result: AnyDomainResult }[], inputId = 'fresh') {
  const state = { live: true, historyLive: true, clock: new Date(pendingTime) };
  const view = reconstructDomainPending({ results: rows, assertCurrent() { assert(state.historyLive); } }, {
    domain: 'reminder', binding: { ...pendingBinding }, currentInputId: inputId,
    reference: pendingReference,
    replacement(previous, result) { assert(result.pendingContext); assert.equal(Number(result.pendingContext.value.revision), Number(previous.value.revision) + 1); },
    clock: () => state.clock, assertCurrent() { assert(state.live); },
  });
  return { state, view };
}
const pendingRow = (entryId: string, inputId: string, result: AnyDomainResult) => ({ entryId, input: { entryId: inputId }, result });

test('versioned domain facts preserve legacy data and reject unknown or incomplete metadata', () => {
  const value = pendingResult(null);
  assert.equal(readDomainFactsData(value.facts.data).version, 1);
  assert.deepEqual(readDomainFactsData(value.facts.data).value, readDomainFactsData({ question: 'When?' }).value);
  assert.equal(readDomainFactsData({ question: 'When?' }).consumedPending, null);
  for (const data of [
    { kind: 'benson.domain-facts', schemaVersion: 2, value: null, consumedPending: null },
    { kind: 'benson.domain-facts', schemaVersion: 1, value: null },
    { kind: 'benson.domain-facts.future', schemaVersion: 1, value: null, consumedPending: null },
    { kind: 'benson.domain-facts', schemaVersion: 1, value: null, consumedPending: { schemaVersion: 2 } },
  ]) assert.throws(() => validateDomainResultEnvelope({ ...value, facts: { ...value.facts, data } }), /domain_facts/);
  let invoked = false;
  const getter = Object.defineProperty({}, 'kind', { enumerable: true, get() { invoked = true; return 'benson.domain-facts'; } });
  assert.throws(() => readDomainFactsData(getter), /json_object_invalid/);
  assert.equal(invoked, false);
});

test('exact consumed pending preserves unrelated requests and reconstructs identically after reload', () => {
  const pending = Array.from({ length: 5 }, (_, index) => domainPending('original-' + index));
  const rows = pending.map((item, index) => pendingRow('question-' + index, 'input-' + index, pendingResult(item)));
  rows.push(pendingRow('terminal', 'answer', pendingResult(null, pendingReference(pending[2]!))));
  const first = pendingHistory(rows).view;
  const recovered = pendingHistory(JSON.parse(JSON.stringify(rows))).view;
  assert.deepEqual(recovered.pending, first.pending); assert.equal(first.pending.length, 4);
  assert(!first.pending.some(item => item.reference.domain === 'reminder' && item.reference.currentEvidenceId === 'original-2'));
  assert.throws(() => first.select(pendingReference(pending[2]!)), /unavailable/);
  assert.equal(first.select(pendingReference(pending[4]!)).pending.value.currentEvidenceId, 'original-4');
});

test('legacy or unreferenced null never clears pending; exact terminal domain failure does', () => {
  const pending = domainPending('original'); const original = pendingRow('q', 'old', pendingResult(pending));
  const plainResult = pendingResult(null), data = readDomainFactsData(plainResult.facts.data).value;
  const legacy = validateDomainResultEnvelope({ ...plainResult, facts: { ...plainResult.facts, data } });
  assert.equal(pendingHistory([original, pendingRow('legacy', 'answer', legacy)]).view.pending.length, 1);
  assert.equal(pendingHistory([original, pendingRow('null', 'answer', plainResult)]).view.pending.length, 1);
  assert.equal(pendingHistory([original, pendingRow('failure', 'answer', pendingResult(null, pendingReference(pending), 'failure'))]).view.pending.length, 0);
});

test('clarification follow-up consumes exact prior revision and retains the next question', () => {
  const old = domainPending('question', 1), next = domainPending('answer', 2);
  const rows = [pendingRow('q1', 'question', pendingResult(old)), pendingRow('q2', 'answer', pendingResult(next, pendingReference(old)))];
  const { view } = pendingHistory(rows);
  assert.equal(view.pending.length, 1); assert.equal(view.select(pendingReference(next)).pending.value.revision, 2);
  assert.throws(() => view.select(pendingReference(old)), /unavailable/);
  const invalid = domainPending('answer', 4);
  assert.throws(() => pendingHistory([rows[0]!, pendingRow('q2', 'answer', pendingResult(invalid, pendingReference(old)))]));
});

test('pending consumption rejects foreign, missing, stale, conflicting, duplicate and same-input references', () => {
  const pending = domainPending('old'), ref = pendingReference(pending), q = pendingRow('q', 'old-input', pendingResult(pending));
  for (const changed of [
    { ...ref, binding: { ...ref.binding, requesterId: 'foreign' } },
    { ...ref, binding: { ...ref.binding, conversationId: 'other' } },
    { ...ref, currentEvidenceId: 'missing' }, { ...ref, revision: 2 },
  ]) assert.throws(() => pendingHistory([q, pendingRow('r', 'answer', pendingResult(null, changed))]), /pending_/);
  const resolved = pendingRow('r', 'answer', pendingResult(null, ref));
  assert.throws(() => pendingHistory([q, resolved, pendingRow('again', 'later', pendingResult(null, ref))]), /unmatched/);
  assert.throws(() => pendingHistory([q, pendingRow('r', 'old-input', pendingResult(null, ref))]), /same_input/);
  assert.throws(() => pendingHistory([q, q]), /duplicate/);
  assert.throws(() => pendingHistory([q, pendingRow('collision', 'another', pendingResult(pending))]), /identity_conflict/);
  const { view, state } = pendingHistory([q]); state.clock = new Date(pending.expiresAt);
  assert.throws(() => view.select(ref), /unavailable/);
  assert.equal(pendingHistory([q]).view.pending.length, 1);
});

test('completed-input replay and cancellation reject without creating execution authority', () => {
  const pending = domainPending('old'), row = pendingRow('q', 'old-input', pendingResult(pending));
  const { view, state } = pendingHistory([row], 'old-input');
  assert.throws(() => view.assertFreshInput(), /already_completed/);
  assert.throws(() => view.select(pendingReference(pending)), /already_completed/);
  const fresh = pendingHistory([row]); fresh.state.historyLive = false;
  assert.doesNotThrow(() => fresh.view.select(pendingReference(pending)), 'own append may retire acquisition, not retained original-source custody');
  state.live = false;
  assert.throws(() => view.select(pendingReference(pending)));
  assert.throws(() => view.assertFreshInput());
  assert.equal('execute' in view, false);
});

test('Jessica identities survive reload and exact replacement without an invented revision', () => {
  const pending = (id: string): Pending => ({ schemaVersion: 1, binding: { ...pendingBinding },
    expiresAt: '2026-11-02T12:20:00Z', value: { version: '1', clarificationId: id, expiresAt: '2026-11-02T12:20:00Z' } });
  const reference = (value: Pending): ConsumedPending => ({ schemaVersion: 1, domain: 'jessica-vacuum',
    binding: value.binding, clarificationId: String(value.value.clarificationId) });
  const result = (value: Pending | null, consumed: ConsumedPending | null = null) => {
    const original = pendingResult(value), facts = readDomainFactsData(original.facts.data).value;
    return withDomainPending(validateDomainResultEnvelope({ ...original, domain: 'jessica-vacuum', domainSchemaVersion: '1',
      operation: 'clean', facts: { ...original.facts, data: facts } }), consumed);
  };
  const first = pending('first'), second = pending('second'), next = pending('next');
  const rows = [pendingRow('q1', 'input-1', result(first)), pendingRow('q2', 'input-2', result(second)),
    pendingRow('q3', 'answer', result(next, reference(second)))];
  const acquire = (history: typeof rows) => reconstructDomainPending({ results: history, assertCurrent() {} }, {
    domain: 'jessica-vacuum', binding: pendingBinding, currentInputId: 'later', reference,
    replacement(previous, value) { assert.notEqual(value.pendingContext?.value.clarificationId, previous.value.clarificationId); },
    clock: () => pendingTime, assertCurrent() {},
  });
  const view = acquire(JSON.parse(JSON.stringify(rows)));
  assert.deepEqual(view.pending.map(item => item.reference), [reference(first), reference(next)]);
  assert.throws(() => view.select(reference(second)), /unavailable/);
  assert.throws(() => acquire([...rows, pendingRow('reuse', 'later', result(second, reference(next)))]), /identity_conflict/);
  assert.throws(() => acquire([...rows, pendingRow('foreign', 'later', result(null, pendingReference(domainPending('foreign'))))]), /pending_consumption|pending_binding/);
});

test('failed reporting, unresolved effects and missing evidence never carry consumption', () => {
  const reference = pendingReference(domainPending('old')), original = pendingResult(null);
  const data = readDomainFactsData(original.facts.data).value;
  const legacy = validateDomainResultEnvelope({ ...original, facts: { ...original.facts, data } });
  for (const changed of [
    { failures: { domain: null, handling: { code: 'REPORT_INVALID', message: 'Not verified', retryable: false } } },
    { evidence: { observations: [], gaps: [{ code: 'RUN_UNSEALED', path: 'run', detail: 'Missing seal' }] } },
    { effects: { status: 'possible', refs: [], details: [], reconciliation: { required: true, reason: 'CHECK_STATE' } } },
    { uncertainty: [{ code: 'UNRESOLVED' }] },
  ]) assert.throws(() => withDomainPending({ ...legacy, ...changed } as AnyDomainResult, reference));
});

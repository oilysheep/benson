import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoutingContextController, type ConversationEvidence, type ConversationTurn } from '../core/conversation-context.js';
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

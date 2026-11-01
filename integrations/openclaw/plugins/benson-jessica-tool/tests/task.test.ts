import assert from 'node:assert/strict';
import test from 'node:test';
import { plain } from '../../../benson-routing/core/value.js';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { createJessicaTaskToolFactory, createJessicaReadToolFactory } from '../src/tool.js';
import { fixture as domainFixture } from './fixtures/domain-state.js';
import { Compile } from 'typebox/compile';
import { loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.js';
import { validateDomainResult } from '../../../benson-routing/core/domain-result.js';
import { createJessicaExecuteToolFactory } from '../src/execute-tool.js';
import { createCompletionAuthority, acceptAgentCompletion } from '../../../benson-routing/core/completion.js';
import { normalizeLegacyTaskResult } from '../../../benson-routing/core/legacy-response.js';

function fixture() {
  const state = { live: true, reads: 0, revokeRead: false, revokeSerialize: false };
  const context: OpenClawPluginToolContext<2> = { agentId: 'main', requesterSenderId: 'fixture-private',
    deliveryContext: { channel: 'whatsapp', accountId: 'fixture-account', to: 'fixture-private' },
    assertInvocationCurrent() { assert(state.live, 'invocation retired'); } };
  const abort = new AbortController();
  const policy = loadPolicy({ version: '1', defaultDecision: 'deny', rules: ['read', 'control'].map(actionClass => ({ subject: 'reader', actionClass,
    deviceScope: 'jessica-vacuum', decision: 'allow' })) });
  const factory = createJessicaTaskToolFactory({ roster: { accountId: 'fixture-account', approvedIds: ['reader'],
    subjectForRoute: route => route === 'fixture-private' ? 'reader' : null }, policy,
    clock: () => new Date('2026-10-26T08:00:00Z'),
    async read(request, identity, authority) {
      assert.deepEqual(request, { operation: 'status' }); assert(identity); authority.assertCurrent(); state.reads++;
      if (state.revokeRead) state.live = false;
      return validateResult({ schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: 'status', verified: true,
        data: { kind: 'status', observedAt: '2026-10-26T08:00:00Z', sourceUpdatedAt: '2026-10-26T07:59:00Z', freshness: 'fresh',
          state: 'docked', batteryLevel: 90, activeSegments: [], currentSegment: null }, warnings: [], error: null, pendingContext: null }, null,
        new Date('2026-10-26T08:00:00Z'));
    }, jsonResult(value) { if (state.revokeSerialize) state.live = false;
      return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; } });
  const tool = factory(context); assert(tool && !Array.isArray(tool)); return { state, context, abort, factory, tool };
}

for (const fault of ['none', 'forged-intent', 'foreign-source', 'foreign-caller', 'missing-caller', 'changed-source',
  'changed-caller', 'cancelled', 'retired-after-effect', 'changed-at-serialization', 'duplicate'] as const) {
  test(`Main intent entry retains original Jessica mutation custody: ${fault}`, async () => {
    const f = domainFixture(); let changed = false, effects = 0;
    const text = 'Clean the living room';
    const context: OpenClawPluginToolContext<2> = { agentId: 'main', sessionKey: 'actual-main', sessionId: 'actual-main-id',
      requesterSenderId: 'fixture-private', deliveryContext: { channel: 'whatsapp', accountId: 'fixture-account', to: 'fixture-private' },
      assertInvocationCurrent() { f.authority.assertCurrent(); } };
    if (fault === 'missing-caller') delete context.sessionId;
    const create = createJessicaTaskToolFactory({ roster: { accountId: 'fixture-account', approvedIds: [...new Set(loadPolicy(f.policy).rules.map(rule => rule.subject))],
      subjectForRoute: route => route === 'fixture-private' ? 'oren' : null }, policy: loadPolicy(f.policy),
      read: async () => { throw new Error('Intent cannot use the status path'); },
      jsonResult(value) { if (fault === 'changed-at-serialization') changed = true;
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; },
      task: {
        source: () => ({ request: text,
          binding: { conversationRef: 'original-conversation', channel: 'whatsapp', accountId: fault === 'foreign-source' ? 'foreign' : 'fixture-account',
            kind: 'direct', peerId: 'fixture-private', threadId: null, requesterId: 'fixture-private' },
          currentTurn: () => ({ entryId: changed ? 'replacement' : 'original-input', role: 'user', text,
            sender: { source: 'canonical_peer_binding', id: 'fixture-private', channel: 'whatsapp', accountId: 'fixture-account' }, inputProvenance: { kind: 'external_user' } }),
          assertCurrent() { f.authority.assertCurrent(); }, assertAuthorized() { f.authority.assertCurrent(); } }),
        async run(_request, work) {
          assert.equal(work.execution.requestEpoch, 'original-input'); assert.deepEqual(work.execution.identity, f.identity);
          if (fault === 'changed-source') changed = true;
          if (fault === 'changed-caller') context.sessionId = 'replacement';
          if (fault === 'cancelled') f.abort.abort();
          const rawFactory = createJessicaExecuteToolFactory({ registryConfig: f.registry, policyConfig: f.policy,
            roster: { accountId: 'fixture-account', approvedIds: [...new Set(loadPolicy(f.policy).rules.map(rule => rule.subject))], subjectForRoute: () => null },
            source: work.execution, store: f.store, clock: f.clock, wait: async () => {}, pollCounts: { clean: 1 },
            driver: { async read() { return structuredClone(f.evidence); }, async dispatch(_step, guard) {
              await guard.assertMutationCurrent(); guard.assertCurrent(); effects++; f.tick(); const at = f.clock().toISOString();
              f.evidence.status = { observedAt: at, sourceUpdatedAt: at, state: 'cleaning', activeSegments: [f.room.segmentId], currentSegment: null };
              f.evidence.taskStatus = { observedAt: at, sourceUpdatedAt: at, state: 'room_cleaning' };
              if (fault === 'retired-after-effect') f.retire();
              return { accepted: true };
            } }, jsonResult: value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }) });
          const raw = rawFactory({ agentId: 'jessica-vacuum', sessionKey: 'agent:jessica-vacuum:subagent:actual',
            assertInvocationCurrent: work.execution.authority.assertCurrent }); assert(raw && !Array.isArray(raw));
          const value = normalizeLegacyTaskResult((await raw.execute('actual-child-call', f.request)).details,
            { taskId: work.callId, pendingBinding: null, pendingExpiresAt: null });
          assert(plain(value.data) && typeof value.data.operationId === 'string');
          const details = [{ kind: 'jessica-dispatch', operationId: value.data.operationId, verified: true }];
          const facts = { domain: value.domain, domainSchemaVersion: value.domainSchemaVersion, operation: value.operation,
            status: value.status, verified: value.verified, verificationScope: ['room_cleaning'], data: value.data,
            warnings: value.warnings, error: value.error, pendingContext: null, effects: details, uncertainty: [] };
          const binding = { inputId: 'original-input', admissionId: 'original-input', conversationId: 'original-conversation',
            runId: 'actual-child', agentId: 'jessica-vacuum', sessionKey: 'agent:jessica-vacuum:subagent:actual', sessionId: 'actual-child-id',
            domain: 'jessica-vacuum', taskId: work.callId, caller: { runId: 'main-run', agentId: 'main', sessionKey: 'actual-main',
              sessionId: fault === 'foreign-caller' ? 'foreign' : 'actual-main-id' }, completionTarget: 'CALLER', authorizationId: 'original-input',
            parentContinuation: { eligible: true, reason: null }, deliveryPolicy: { eligible: false, reason: null } };
          const authority = createCompletionAuthority({ schemaVersion: 6, kind: 'domain-task', binding, knownFacts: facts,
            results: [], coverage: 'complete', gaps: [], origin: 'agent' }, { assertCurrent: work.execution.authority.assertCurrent });
          const completion = acceptAgentCompletion({ schemaVersion: 6, kind: 'domain-task', facts,
            userResponse: { state: 'unavailable', reason: { code: 'DOMAIN_RENDERING_REQUIRED', detail: 'Use verified domain facts' } } }, authority);
          return { completion, authority, effects: { status: 'known', refs: ['isolated-dispatch'], details, reconciliation: { required: false, reason: null } } };
        },
      } });
    const tool = create(context); assert(tool && !Array.isArray(tool));
    const request = { kind: 'benson.self-contained-request', version: 1, request: fault === 'forged-intent' ? 'replacement' : text };
    const output = tool.execute('original-call', request, f.abort.signal);
    if (fault === 'none' || fault === 'duplicate') {
      const result = validateDomainResult((await output).details); assert.equal(result.executionMode, 'agentic');
      assert.equal(result.facts.verified, true); assert.equal(result.effects.status, 'known'); assert.equal(effects, 1);
      if (fault === 'duplicate') { await assert.rejects(tool.execute('retry', request), /already_started/); assert.equal(effects, 1); }
    } else { await assert.rejects(output); assert.equal(effects, ['foreign-caller', 'retired-after-effect', 'changed-at-serialization'].includes(fault) ? 1 : 0); }
  });
}
test('Main status adapter returns lossless domain facts and prepared content without a child Run', async () => {
  const f = fixture(), output = await f.tool.execute('fixture-call', { operation: 'status' }, f.abort.signal);
  const result = validateDomainResult(output.details), content = output.content[0]; assert(content?.type === 'text');
  assert.deepEqual(JSON.parse(content.text), JSON.parse(JSON.stringify(result))); assert.equal(result.executionMode, 'deterministic');
  assert.equal(result.facts.verified, true); assert.equal(result.effects.status, 'none');
  assert(plain(result.facts.data)); assert.equal(result.facts.data.batteryLevel, 90); assert(result.content?.state === 'usable'); assert.equal(f.state.reads, 1);
});
for (const mode of ['foreign-account', 'missing-route', 'missing-group-sender', 'foreign-group-sender', 'private-mismatch',
  'forged-params', 'mutation', 'closed', 'aborted', 'async-assertion', 'revoke-read', 'revoke-serialize'] as const) {
  test(`Main status refuses ${mode}`, async () => {
    const f = fixture(); let request: unknown = { operation: 'status' };
    if (mode === 'foreign-account') f.context.deliveryContext = { channel: 'whatsapp', accountId: 'foreign', to: 'fixture-private' };
    if (mode === 'missing-route') delete f.context.deliveryContext;
    if (mode === 'missing-group-sender' || mode === 'foreign-group-sender') {
      f.context.deliveryContext = { channel: 'whatsapp', accountId: 'fixture-account', to: 'fixture-group@g.us' };
      f.context.requesterSenderId = mode === 'missing-group-sender' ? '' : 'foreign';
    }
    if (mode === 'private-mismatch') f.context.requesterSenderId = 'foreign';
    if (mode === 'forged-params') request = { operation: 'status', senderId: 'foreign' };
    if (mode === 'mutation') request = { operation: 'clean', target: { kind: 'home' } };
    if (mode === 'closed') f.state.live = false;
    if (mode === 'aborted') f.abort.abort();
    if (mode === 'async-assertion') f.context.assertInvocationCurrent = async () => {};
    if (mode === 'revoke-read') f.state.revokeRead = true;
    if (mode === 'revoke-serialize') f.state.revokeSerialize = true;
    await assert.rejects(f.tool.execute('negative-call', request, f.abort.signal));
    assert.equal(f.state.reads, mode === 'revoke-read' || mode === 'revoke-serialize' ? 1 : 0);
  });
}
test('authorized group sender and optional signal preserve the existing read scope', async () => {
  const f = fixture(); f.context.deliveryContext = { channel: 'whatsapp', accountId: 'fixture-account', to: 'fixture-group@g.us' };
  await f.tool.execute('group-call', { operation: 'status' }); assert.equal(f.state.reads, 1);
  assert.equal(f.factory({ ...f.context, agentId: 'jessica-vacuum' }), null);
  f.state.live = false; await assert.rejects(f.tool.execute('retired-call', { operation: 'status' }));
});
for (const mode of ['success', 'foreign-agent', 'foreign-route', 'forged-input', 'disabled-operation', 'retired-after-read', 'retired-at-serialization', 'foreign-result',
  'missing-route', 'source-without-route', 'retired-source', 'cancelled-source', 'async-native-authority'] as const) {
  test(`domain raw read adapter preserves its existing boundary: ${mode}`, async () => {
    const f = domainFixture(); let live = true, reads = 0;
    const sourceAbort = new AbortController();
    if (mode === 'cancelled-source') sourceAbort.abort();
    const policy = loadPolicy(f.policy);
    const create = createJessicaReadToolFactory({ registryConfig: f.registry, policy, clock: f.clock,
      roster: { accountId: 'fixture-account', approvedIds: [...new Set(policy.rules.map(rule => rule.subject))],
        subjectForRoute: route => route === 'fixture-private' ? 'oren' : null },
      ...(['source-without-route', 'retired-source', 'cancelled-source'].includes(mode) ? {
        source: { identity: f.identity, authority: { signal: sourceAbort.signal,
          assertCurrent() { assert(mode !== 'retired-source', 'original source retired'); } } },
      } : {}),
      async read(request, identity, authority) {
        assert.deepEqual(request, { operation: 'status' }); assert.deepEqual(identity, f.identity); authority.assertCurrent(); reads++;
        await Promise.resolve(); if (mode === 'retired-after-read') live = false;
        return validateResult({ schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: mode === 'foreign-result' ? 'capabilities' : 'status', verified: true,
          data: mode === 'foreign-result' ? { kind: 'capabilities', observedAt: f.clock().toISOString(), sourceUpdatedAt: null, freshness: 'fresh', capabilities: [], inventoryScope: 'accepted_registry_only', liveAvailability: 'not_checked' }
            : { kind: 'status', observedAt: f.clock().toISOString(), sourceUpdatedAt: null, freshness: 'fresh', state: 'docked', batteryLevel: 90, activeSegments: [], currentSegment: null },
          warnings: [], error: null, pendingContext: null }, null, f.clock());
      },
      jsonResult(value) { if (mode === 'retired-at-serialization') live = false; return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; },
    });
    const ctx: OpenClawPluginToolContext<2> = { agentId: mode === 'foreign-agent' ? 'main' : 'jessica-vacuum', requesterSenderId: 'fixture-private',
      deliveryContext: { channel: 'whatsapp', accountId: mode === 'foreign-route' ? 'foreign' : 'fixture-account', to: 'fixture-private' },
      assertInvocationCurrent() { assert(live); } };
    if (['missing-route', 'source-without-route', 'retired-source', 'cancelled-source'].includes(mode)) delete ctx.deliveryContext;
    if (mode === 'async-native-authority') ctx.assertInvocationCurrent = async () => {};
    const tool = create(ctx);
    if (mode === 'foreign-agent') { assert.equal(tool, null); assert.equal(reads, 0); return; }
    assert(tool && !Array.isArray(tool)); const schema = Compile(tool.parameters);
    assert(schema.Check({ operation: 'status' })); assert(!schema.Check({ operation: 'room_settings', room: 'living_room' }));
    const request = mode === 'forged-input' ? { operation: 'status', requesterId: 'oren' } : mode === 'disabled-operation' ? { operation: 'room_settings', room: 'living_room' } : { operation: 'status' };
    const output = tool.execute('raw-read', request);
    if (mode !== 'success' && mode !== 'source-without-route') { await assert.rejects(output); assert.equal(reads, ['retired-after-read', 'retired-at-serialization', 'foreign-result'].includes(mode) ? 1 : 0); return; }
    const result = validateResult((await output).details, null, f.clock());
    assert.equal(result.schemaVersion, '1'); assert.equal(result.operation, 'status'); assert.equal(result.verified, true); assert.equal(reads, 1);
  });
}

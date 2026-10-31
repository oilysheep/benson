import assert from 'node:assert/strict';
import test from 'node:test';
import { plain } from '../../../benson-routing/core/value.js';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { createJessicaTaskToolFactory } from '../src/tool.js';
import { loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.js';
import { validateDomainResult } from '../../../benson-routing/core/domain-result.js';

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

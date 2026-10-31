import assert from 'node:assert/strict';
import test from 'node:test';
import { plain } from '../../../benson-routing/core/value.js';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { createReminderTaskToolFactory } from '../src/tool.js';
import { loadIdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';
import { validateDomainResult } from '../../../benson-routing/core/domain-result.js';

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
  return { state, abort, factory, context, tool, records };
}
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

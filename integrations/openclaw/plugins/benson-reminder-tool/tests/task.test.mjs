import assert from 'node:assert/strict';
import test from 'node:test';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import recipients from '../../../../../agents/reminder-service/config/recipients.json' with { type: 'json' };
import { createReminderTaskToolFactory } from '../dist/contracts.js';

// Installed public SDK schema validation plus host/service fixtures: source
// evidence only, no production reads, native admission or loaded-policy claim.
const { validateJsonSchemaValue } = await import(pathToFileURL(
  `${homedir()}/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/json-schema-runtime.js`));
const reader = recipients.recipients.find(item => recipients.trustedRequesterIds.includes(item.id));
const observedAt = '2026-10-10T10:00:00.000Z';
const record = i => ({ schemaVersion: 4, reminderId: `reminder-${i}`, status: 'active', content: `fixture ${i}`,
  schedules: [{ type: 'one-shot', resolvedTime: '2026-10-11T10:00:00+03:00', timezone: 'Asia/Jerusalem' }] });
function fixture() {
  const state = { live: true, calls: [], result: { status: 'success', operation: 'list', verified: true,
    matchCount: 3, matches: [record(1), record(2), record(3)], warnings: [] } };
  const context = { agentId: 'main', requesterSenderId: reader.to,
    deliveryContext: { channel: 'whatsapp', accountId: recipients.accountId, to: reader.to },
    assertInvocationCurrent() { assert.equal(state.live, true, 'invocation closed'); } };
  const options = { validateJsonSchemaValue, clock: () => new Date(observedAt),
    jsonResult: value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }),
    async runReminderService(params, signal) { state.calls.push({ params, signal }); return structuredClone(state.result); } };
  const factory = createReminderTaskToolFactory(options);
  return { state, context, options, factory, tool: factory(context) };
}

test('list invokes the existing service once with host-resolved requester and renders every match', async () => {
  const f = fixture();
  const result = await f.tool.execute('native-call', { operation: 'list' });
  assert.deepEqual(f.state.calls.map(call => call.params), [{ operation: 'list-reminders', requesterId: reader.id }]);
  assert.equal(result.details.kind, 'benson.no-run');
  assert.equal(result.details.admission.callId, 'native-call');
  assert.equal(result.details.admission.subject, reader.id);
  assert.deepEqual(JSON.parse(JSON.stringify(result.details.evidence.facts)), f.state.result);
  assert.deepEqual(JSON.parse(JSON.stringify(result.details.effects)), { status: 'none', refs: [] });
  assert.equal(result.details.notification, null);
  assert.equal(result.details.runId, undefined);
  for (let i = 1; i <= 3; i++) assert.match(result.content[1].text, new RegExp(`${i}\\. fixture ${i}`));
  assert.equal(result.content[1].text.includes('Asia/Jerusalem'), false);
  assert.equal(result.content[1].text.includes('2026-10-11T'), false);
});

test('empty and repeated lists are complete fresh reads, not historical result reuse', async () => {
  const f = fixture();
  await f.tool.execute('call-1', { operation: 'list' });
  f.state.result.matches = []; f.state.result.matchCount = 0;
  const result = await f.tool.execute('call-2', { operation: 'list' });
  assert.equal(f.state.calls.length, 2);
  assert.equal(result.details.disposition, 'handled');
  assert.equal(result.details.evidence.facts.matchCount, 0);
  assert.match(result.content[1].text, /לא נמצאו/);
});

test('native entry is Main-only and missing/foreign requester or forged intent prevents service reads', async () => {
  const f = fixture();
  for (const agentId of ['reminder-service', 'jessica-vacuum', undefined]) assert.equal(f.factory({ ...f.context, agentId }), null);
  assert.equal(f.factory({ ...f.context, assertInvocationCurrent: undefined }), null);
  for (const change of [{ deliveryContext: undefined }, { requesterSenderId: 'foreign' },
    { deliveryContext: { ...f.context.deliveryContext, accountId: 'foreign' } },
    { deliveryContext: { ...f.context.deliveryContext, to: 'group@g.us' }, requesterSenderId: undefined }]) {
    await assert.rejects(f.factory({ ...f.context, ...change }).execute('call', { operation: 'list' }));
  }
  for (const request of [{ operation: 'create' }, { operation: 'find' },
    { operation: 'list', requesterId: reader.id }, { operation: 'list', grant: 'owner' },
    { operation: 'list', readOnly: true }, { operation: 'list', enabled: false }]) {
    await assert.rejects(f.tool.execute('call', request));
  }
  assert.equal(f.state.calls.length, 0);
});

test('group identity derives from the authenticated sender, not the group route', async () => {
  const f = fixture();
  const result = await f.factory({ ...f.context,
    deliveryContext: { ...f.context.deliveryContext, to: 'group@g.us' } }).execute('call', { operation: 'list' });
  assert.equal(result.details.admission.subject, reader.id);
});

test('aborted/retired invocations fail before service or disclosure', async () => {
  const f = fixture(); const abort = new AbortController(); abort.abort();
  await assert.rejects(f.tool.execute('call', { operation: 'list' }, abort.signal));
  assert.equal(f.state.calls.length, 0);
  f.state.live = false;
  await assert.rejects(f.tool.execute('call', { operation: 'list' }), /invocation closed/);
  f.state.live = true;
  f.options.runReminderService = async () => { f.state.live = false; return f.state.result; };
  await assert.rejects(createReminderTaskToolFactory(f.options)(f.context)
    .execute('call', { operation: 'list' }), /invocation closed/);
});

test('incomplete, contradictory or failed backend results cannot become successful lists', async () => {
  for (const change of [value => value.matchCount++, value => delete value.matches[0].schedules,
    value => value.verified = false, value => value.operation = 'create',
    value => value.matches[1].reminderId = value.matches[0].reminderId,
    value => value.error = { code: 'contradiction' }, value => value.matches[0].schemaVersion = 99,
    value => value.warnings.push({ code: 'UNSUPPORTED_WARNING' })]) {
    const f = fixture(); change(f.state.result);
    const result = await f.tool.execute('call', { operation: 'list' });
    assert.equal(result.details.disposition, 'failed');
    assert.equal(result.details.evidence.facts.verified, false);
    assert.match(result.content[1].text, /לא ניתן לאמת/);
  }
  const f = fixture();
  f.options.runReminderService = async () => { throw Error('private backend diagnostic'); };
  const result = await createReminderTaskToolFactory(f.options)(f.context).execute('call', { operation: 'list' });
  assert.equal(JSON.stringify(result).includes('private backend diagnostic'), false);
  assert.equal(result.details.disposition, 'failed');
});

test('oversized complete lists reject rather than silently truncate or omit matches', async () => {
  const f = fixture(); f.state.result.matches[0].content = 'x'.repeat(100000);
  await assert.rejects(f.tool.execute('call', { operation: 'list' }), /bytes_exceeded|rendered_invalid|depth_exceeded|json_invalid_or_oversized/);
  assert.equal(f.state.calls.length, 1);
});

test('structured service failures preserve safe reason without disclosing backend diagnostics', async () => {
  const f = fixture();
  f.state.result = { operation: 'list', status: 'failure', verified: false, warnings: [],
    error: { code: 'REMINDER_AUTOMATION_PARTIAL_STATE', message: 'private backend diagnostic', retryable: false } };
  const result = await f.tool.execute('call', { operation: 'list' });
  assert.equal(result.details.disposition, 'failed');
  assert.equal(result.details.error.code, 'REMINDER_AUTOMATION_PARTIAL_STATE');
  assert.equal(JSON.stringify(result).includes('private backend diagnostic'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { Compile } from 'typebox/compile';
import { plain } from '../../../benson-routing/core/value.js';
import { PublicSchemas, parseToolName, parseRequest } from '../../../../../agents/reminder-service/lib/schemas.js';
import { loadIdentityContract, resolveRoute } from '../../../../../agents/reminder-service/lib/identity.js';
import { schemaForTool } from '../../../../../agents/reminder-service/lib/tool-contracts.js';
import { buildArgv } from '../src/runner.js';
const roster: unknown = JSON.parse(readFileSync('agents/reminder-service/config/recipients.json', 'utf8'));
const identities = loadIdentityContract(roster);
const legacy: unknown = await import(pathToFileURL(resolve('integrations/openclaw/plugins/benson-reminder-tool/dist/contracts.js')).href);
const sdk: unknown = await import(pathToFileURL(`${homedir()}/.npm-global/lib/node_modules/openclaw/dist/plugin-sdk/json-schema-runtime.js`).href);
assert.ok(plain(legacy) && Array.isArray(legacy.REMINDER_TOOL_DEFINITIONS));
assert.ok(plain(sdk) && typeof sdk.validateJsonSchemaValue === 'function');
// Reuse the existing shell owner's exact data fixtures, without running its shell/Python/runtime work.
const shell = readFileSync('agents/reminder-service/tests/test-v3-contract.sh', 'utf8');
const start = shell.indexOf('const validParameters = {'), end = shell.indexOf('\nfor (const requesterId of ["oren", "ilana", "amit"])', start);
assert.ok(start > 0 && end > start);
const fixtures: unknown = runInNewContext(`${shell.slice(start, end)}\nJSON.stringify(validParameters)`, { structuredClone }, { timeout: 1_000 });
assert.equal(typeof fixtures, 'string');
const payloads: unknown = JSON.parse(String(fixtures)); assert.ok(plain(payloads));
let sample = 0;
function nativeCheck(schema: unknown, value: unknown): boolean {
  assert.ok(plain(sdk) && typeof sdk.validateJsonSchemaValue === 'function');
  const result: unknown = sdk.validateJsonSchemaValue({ schema, value, cacheKey: `ts03-reminder-${sample++}`, applyDefaults: false });
  assert.ok(plain(result) && typeof result.ok === 'boolean'); return result.ok;
}
test('all eight schema-first contracts preserve retained positive/negative native samples and canonical roster enums', () => {
  assert.ok(plain(legacy) && Array.isArray(legacy.REMINDER_TOOL_DEFINITIONS) && plain(payloads));
  let count = 0;
  for (const old of legacy.REMINDER_TOOL_DEFINITIONS) {
    assert.ok(plain(old)); const name = parseToolName(old.name), schema = schemaForTool(name, identities), validator = Compile(schema);
    const positive: unknown = payloads[name]; assert.ok(plain(positive));
    for (const value of [positive, {}, null, [], { ...positive, unsupported: true }]) {
      assert.equal(validator.Check(value), nativeCheck(old.schema, value), `${name} sample ${count++}`);
    }
    assert.equal(validator.Check(positive), true, name);
  }
  assert.equal(count, 40);
  assert.equal(Compile(schemaForTool('benson_reminder_find', identities)).Check({ requesterId: 'oren', recipient: 'invented' }), false);
});
test('Reminder content retains code-point/Python bounds; Jessica/Core UTF-16 limits do not leak into this contract', () => {
  assert.ok(plain(legacy) && Array.isArray(legacy.REMINDER_TOOL_DEFINITIONS) && plain(payloads));
  const old = legacy.REMINDER_TOOL_DEFINITIONS.find((item: unknown) => plain(item) && item.name === 'benson_reminder_create'); assert.ok(plain(old));
  const positive = payloads.benson_reminder_create; assert.ok(plain(positive) && plain(positive.input));
  for (const content of ['x'.repeat(1000), '😀'.repeat(1000), '😀'.repeat(1001), '\ud800'.repeat(1000)]) {
    const value: unknown = { input: { ...positive.input, content } };
    assert.equal(Compile(PublicSchemas.benson_reminder_create).Check(value), nativeCheck(old.schema, value));
  }
});
test('route projections preserve authenticated private/group identity and reject contradictory or foreign routes', () => {
  assert.ok(plain(roster) && Array.isArray(roster.recipients));
  const person = roster.recipients.find((item: unknown) => plain(item) && item.id === 'oren'); assert.ok(plain(person) && typeof person.to === 'string');
  const delivery = { channel: 'whatsapp', accountId: identities.accountId, to: person.to, senderId: person.to };
  const route = resolveRoute(identities, delivery); assert.ok(route);
  assert.equal(route.requesterId, 'oren');
  assert.equal(resolveRoute(identities, { ...delivery, senderId: 'foreign' }), null);
  assert.equal(resolveRoute(identities, { ...delivery, accountId: 'foreign' }), null);
  assert.equal(resolveRoute(identities, { ...delivery, to: 'group@g.us', senderId: '' }), null);
  assert.equal(resolveRoute(identities, { ...delivery, to: 'group@g.us' })?.sourceType, 'group');
  const list = Compile(schemaForTool('benson_reminder_list', identities, route));
  assert.equal(list.Check({ requesterId: 'oren' }), true); assert.equal(list.Check({ requesterId: 'ilana' }), false);
});
test('argv uses only the fixed transaction operation and accepted flags; omitted/null/false semantics remain explicit', () => {
  assert.deepEqual(buildArgv({ operation: 'find-reminders', requesterId: 'oren', jobId: '  job-contract  ', text: '  coffee  ', enabled: false }),
    ['find-reminders', '--requester', 'oren', '--job-id', 'job-contract', '--text', 'coffee', '--enabled', 'false']);
  for (const value of [{ operation: 'shell', requesterId: 'oren' }, { operation: 'list-reminders', requesterId: 'oren', enabled: null },
    { operation: 'update-reminder', reminderId: 'r', requesterId: 'oren', input: { recipientId: 'oren' } },
    { operation: 'find-reminders', requesterId: 'oren', jobId: ' \t ' }]) assert.throws(() => buildArgv(value));
  assert.ok(plain(payloads));
  const params = payloads.benson_reminder_create; assert.ok(plain(params) && plain(params.input));
  const canonical = parseRequest('benson_reminder_create', { input: { ...params.input, calendar: { requested: false, summary: { value: 'unused', evidenceQuote: 'unrelated' } } } });
  assert.equal(canonical.operation, 'create-intent');
  if (canonical.operation !== 'create-intent' || 'items' in canonical.input) throw new Error('fixture type');
  assert.deepEqual(canonical.input.calendar, { requested: false });
});

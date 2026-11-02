import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OpenClawPluginToolFactory, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import entry from '../src/index.js';
import { PublicSchemas } from '../../../../../agents/reminder-service/lib/schemas.js';
import { loadCanonicalIdentityContract } from '../src/identity.js';
import { plain } from '../../../benson-routing/core/value.js';

test('Reminder metadata discovery performs no runtime registration or resource access', () => {
  const register: unknown = entry.register; assert.equal(typeof register, 'function');
  if (typeof register !== 'function') assert.fail('register unavailable');
  for (const registrationMode of ['discovery', 'tool-discovery', 'setup-only', 'setup-runtime', 'cli-metadata']) {
    register({ registrationMode });
  }
});
function fixture() {
  const tools = new Map<string, OpenClawPluginToolFactory<2>['create']>();
  const hooks: string[] = [], disposals: (() => void)[] = [], signal = new AbortController();
  const register: unknown = entry.register; assert.equal(typeof register, 'function');
  if (typeof register !== 'function') assert.fail('register unavailable');
  const resources: string[] = [];
  register({ registrationMode: 'full', resolvePath(input: string) {
    resources.push(input); return resolve('output/typescript/integrations/openclaw/plugins/benson-reminder-tool', input);
  }, lifecycle: { signal: signal.signal,
    onDispose(callback: () => void) { disposals.push(callback); } },
    on(name: string) { hooks.push(name); },
    runtime: { channel: { runtimeContexts: { get() { return undefined; } } } },
    registerTool(factory: OpenClawPluginToolFactory<2>, options: { name: string; optional: boolean }) {
      assert.equal(factory.contextVersion, 2); assert.equal(options.optional, true); assert(!tools.has(options.name));
      tools.set(options.name, factory.create);
    },
  });
  return { tools, hooks, disposals, signal, resources };
}
test('Reminder typed entry registers the exact existing manifest roster and leaves unbound raw tools unavailable', () => {
  const f = fixture();
  assert.deepEqual(f.resources, ['../../../../agents/reminder-service/config/recipients.json',
    '../../../../agents/reminder-service/tools/reminder-service', '../../patches/tool-execution-receipts/manifest.json']);
  const manifest: unknown = JSON.parse(readFileSync('integrations/openclaw/plugins/benson-reminder-tool/openclaw.plugin.json', 'utf8'));
  assert(plain(manifest) && plain(manifest.contracts) && Array.isArray(manifest.contracts.tools));
  assert.deepEqual([...f.tools.keys()].sort(), [...manifest.contracts.tools].sort());
  assert.deepEqual(f.hooks, ['before_tool_call', 'after_tool_call', 'agent_end']);
  for (const name of Object.keys(PublicSchemas)) {
    const factory = f.tools.get(name); assert(factory);
    assert.equal(factory({ agentId: 'main', assertInvocationCurrent() {} }), null);
    assert.equal(factory({ agentId: 'reminder-service', sessionKey: 'agent:reminder-service:subagent:unbound',
      assertInvocationCurrent() {} }), null);
  }
  const create = f.tools.get('reminder_task'); assert(create);
  assert.equal(create({ agentId: 'reminder-service', assertInvocationCurrent() {} }), null);
  for (const dispose of f.disposals) dispose();
});
test('Reminder list and intent reject missing shared native source before transaction or child launch', async () => {
  const f = fixture(), identities = loadCanonicalIdentityContract();
  const roster: unknown = JSON.parse(readFileSync('agents/reminder-service/config/recipients.json', 'utf8'));
  assert(plain(roster) && Array.isArray(roster.recipients));
  const recipient = roster.recipients.find(item => plain(item) && item.id === identities.trustedRequesterIds[0]);
  assert(plain(recipient) && typeof recipient.to === 'string');
  const context: OpenClawPluginToolContext<2> = { agentId: 'main', sessionKey: 'main', sessionId: 'main-id',
    deliveryContext: { channel: 'whatsapp', accountId: identities.accountId, to: recipient.to },
    requesterSenderId: recipient.to, assertInvocationCurrent() {} };
  const create = f.tools.get('reminder_task'); assert(create);
  const tool = create(context); assert(tool && !Array.isArray(tool));
  for (const args of [{ operation: 'list' }, { kind: 'benson.self-contained-request', version: 1, request: 'fixture request' }]) {
    await assert.rejects(tool.execute('call', args), /native_original_source_unavailable/);
  }
  for (const dispose of f.disposals) dispose();
});
test('emitted receipt manifest is the exact canonical pin, with no second configuration owner', () => {
  assert.deepEqual(readFileSync(new URL('../../../patches/tool-execution-receipts/manifest.json', import.meta.url)),
    readFileSync('integrations/openclaw/patches/tool-execution-receipts/manifest.json'));
});

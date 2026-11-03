import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OpenClawPluginToolFactory, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { loadCanonicalIdentityContract } from '../../benson-reminder-tool/src/identity.js';
import { plain } from '../../../benson-routing/core/value.js';
import { validateDomainResultEnvelope } from '../../../benson-routing/core/domain-result.js';
import { VACUUM_ENTITY } from '../../../../../agents/jessica-vacuum/lib/ha-read.js';

// Exercise the actual entry and canonical HA adapter with its existing injected
// ports. Only the test module graph replaces credential/HTTP acquisition.
const port = Symbol.for('benson.test.jessica.entry.transport');
const transportUrl = new URL('../../../../../agents/jessica-vacuum/lib/adapters/ha-transport.js', import.meta.url).href;
const hooks = registerHooks({ load(url, context, next) {
  if (url !== transportUrl) return next(url, context);
  return { format: 'module', shortCircuit: true, source:
    `export * from ${JSON.stringify(transportUrl + '?entry-actual')};
     import {createHaTransport as actual} from ${JSON.stringify(transportUrl + '?entry-actual')};
     export function createHaTransport() { return actual(globalThis[Symbol.for('benson.test.jessica.entry.transport')]); }` };
} });
const entry = (await import('../src/index.js')).default;
hooks.deregister();

function fixture(registrationMode: 'full' | 'tool-discovery' = 'full') {
  const identities = loadCanonicalIdentityContract();
  const config: unknown = JSON.parse(readFileSync('agents/reminder-service/config/recipients.json', 'utf8'));
  assert(plain(config) && Array.isArray(config.recipients));
  const person = config.recipients.find(item => plain(item) && item.id === identities.trustedRequesterIds[0]);
  assert(plain(person) && typeof person.to === 'string');
  const state = { current: true, bound: true, reads: 0, credentials: 0, retireOnRead: false, records: [] as unknown[],
    retained: [] as (() => void)[] };
  const authority = () => assert(state.current, 'native invocation retired');
  const context: OpenClawPluginToolContext<2> = { agentId: 'main', sessionKey: 'main', sessionId: 'main-id',
    deliveryContext: { channel: 'whatsapp', accountId: identities.accountId, to: person.to },
    requesterSenderId: person.to, assertInvocationCurrent: authority };
  Reflect.set(globalThis, port, { async readCredential() { authority(); state.credentials++; return 'synthetic-fixture-only'; },
    async fetchImpl(url: string, options: RequestInit) {
      authority(); assert.equal(options.method, 'GET'); state.reads++;
      const value = url.endsWith(`/api/states/${VACUUM_ENTITY}`)
        ? { entity_id: VACUUM_ENTITY, state: 'docked', attributes: { battery: 90, active_segments: [], current_segment: null },
          last_updated: new Date(Date.now() - 1_000).toISOString() } : [];
      if (state.retireOnRead) state.current = false;
      return new Response(JSON.stringify(value), { status: 200 });
    } });
  const tools = new Map<string, OpenClawPluginToolFactory<2>['create']>();
  const register: unknown = entry.register; assert.equal(typeof register, 'function');
  if (typeof register !== 'function') assert.fail('Missing entry');
  const resources: string[] = [];
  register({ registrationMode, resolvePath: (p: string) => {
    resources.push(p); return resolve('output/typescript/integrations/openclaw/plugins/benson-jessica-tool', p);
  },
    runtime: { channel: { runtimeContexts: { get() { return state.bound ? { current(received: unknown) {
      assert.equal(received, context); return { assertCurrent: authority,
        source() { throw Error('Status must not acquire source history'); },
        originalUserTurns() { throw Error('Status must not acquire history'); },
        caller(received: unknown, callId: string) { authority(); assert.equal(received, context); assert.equal(callId, 'status-call'); },
        record(received: unknown, callId: string, value: unknown, current: () => void) {
          authority(); assert.equal(received, context); assert.equal(callId, 'status-call');
          current(); state.records.push(value); state.retained.push(current);
        } };
    } } : undefined; } } } },
    registerTool(factory: OpenClawPluginToolFactory<2>, options: { name: string; optional: boolean }) {
      assert.equal(factory.contextVersion, 2); assert.equal(options.optional, true);
      assert(!tools.has(options.name)); tools.set(options.name, factory.create);
    } });
  assert.deepEqual(resources, ['../../../../agents/reminder-service/config/recipients.json',
    '../../../../agents/jessica-vacuum/config/policy.v1.json', '../../../../agents/jessica-vacuum/config/registry.v1.json']);
  const create = tools.get('jessica_task'); assert(create);
  const tool = create(context); assert(tool && !Array.isArray(tool));
  return { state, context, tools, tool };
}

test('Jessica discovery has no runtime/resource access; existing manifest roster stays exact', () => {
  const register: unknown = entry.register; assert.equal(typeof register, 'function');
  if (typeof register !== 'function') assert.fail('Missing entry');
  for (const registrationMode of ['discovery', 'setup-only', 'setup-runtime', 'cli-metadata']) register({ registrationMode });
  const f = fixture();
  const manifest: unknown = JSON.parse(readFileSync('integrations/openclaw/plugins/benson-jessica-tool/openclaw.plugin.json', 'utf8'));
  assert(plain(manifest) && plain(manifest.contracts) && Array.isArray(manifest.contracts.tools));
  assert.deepEqual([...f.tools.keys()].sort(), [...manifest.contracts.tools].sort());
  for (const name of ['jessica_read', 'jessica_execute', 'jessica_validate_completion']) {
    assert.equal(f.tools.get(name)?.({ ...f.context, agentId: 'jessica-vacuum' }), null);
  }
  assert.equal(f.state.credentials, 0); assert.equal(f.state.reads, 0);
});

test('Jessica tool-discovery registers inert schemas and retains live Response authority', async () => {
  const f = fixture('tool-discovery');
  assert.equal(f.state.credentials, 0); assert.equal(f.state.reads, 0);
  assert.deepEqual(f.tool.parameters, fixture().tool.parameters);
  f.state.bound = false;
  await assert.rejects(f.tool.execute('status-call', { operation: 'status' }), /native_original_source_unavailable/);
  assert.equal(f.state.credentials, 0); assert.equal(f.state.reads, 0);
  f.state.bound = true;
  const result = validateDomainResultEnvelope((await f.tool.execute('status-call', { operation: 'status' })).details);
  assert.equal(result.outcome.status, 'success'); assert.equal(f.state.reads, 2);
  f.state.current = false;
  await assert.rejects(f.tool.execute('status-call', { operation: 'status' }), /retired/);
  assert.equal(f.state.reads, 2);
});

test('Jessica status composes canonical HA read, authorization, domain result and retained Response custody', async () => {
  const f = fixture();
  const carrier = await f.tool.execute('status-call', { operation: 'status' });
  const result = validateDomainResultEnvelope(carrier.details);
  assert.equal(result.executionMode, 'deterministic'); assert.equal(result.outcome.status, 'success');
  assert.equal(result.facts.verified, true); assert.equal(result.effects.status, 'none');
  assert.equal(f.state.reads, 2); assert.equal(f.state.credentials, 2);
  assert.deepEqual(f.state.records, [result]); assert.equal(f.state.retained.length, 1);
  f.state.retained[0]!(); f.state.current = false; assert.throws(f.state.retained[0]!, /retired/);
});

for (const fault of ['missing-source', 'untrusted', 'retired', 'retired-during-read', 'history-v1', 'history-v2'] as const) {
  test(`Jessica assembled entry fails closed: ${fault}`, async () => {
    const f = fixture();
    if (fault === 'missing-source') f.state.bound = false;
    if (fault === 'untrusted') f.context.requesterSenderId = 'foreign';
    if (fault === 'retired') f.state.current = false;
    if (fault === 'retired-during-read') f.state.retireOnRead = true;
    const args = fault.startsWith('history') ? { kind: 'benson.self-contained-request', version: fault === 'history-v2' ? 2 : 1,
      ...fault === 'history-v2' ? { pending: null } : {}, request: 'Clean a room' } : { operation: 'status' };
    await assert.rejects(f.tool.execute('status-call', args));
    assert.equal(f.state.reads, fault === 'retired-during-read' ? 1 : 0);
    assert.equal(f.state.records.length, 0);
  });
}

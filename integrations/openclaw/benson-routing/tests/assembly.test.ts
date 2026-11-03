import assert from 'node:assert/strict';
import test from 'node:test';
import { currentNativeTurn, registerResponseController, type ResponseHost } from '../adapters/openclaw/response.js';
import { loadIdentityContract } from '../../../../agents/reminder-service/lib/identity.js';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { plain } from '../core/value.js';
import entry from '../src/index.js';
import { loadCanonicalIdentityContract } from '../../plugins/benson-reminder-tool/src/identity.js';
import { REMINDER_SERVICE_PATH } from '../../plugins/benson-reminder-tool/src/runner.js';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCurrentRequestContext } from '../core/conversation-context.js';
import { normalizeToolParameterSchema } from '@openclaw/ai/internal/tool-schema';
import Value from 'typebox/value';
import { JESSICA_TASK_ENTRY_SCHEMA } from '../../../../agents/jessica-vacuum/lib/task.js';
import { REMINDER_TASK_ENTRY_SCHEMA } from '../../../../agents/reminder-service/lib/task.js';
import { createTaskEnvelope, createPendingTaskEnvelope } from '../core/task-envelope.js';

test('native parameter normalization preserves both Task versions and the deterministic read branches', () => {
  for (const [schema, operation, domain] of [
    [JESSICA_TASK_ENTRY_SCHEMA, 'status', 'jessica-vacuum'],
    [REMINDER_TASK_ENTRY_SCHEMA, 'list', 'reminder'],
  ] as const) {
    const parameters = normalizeToolParameterSchema(schema, { modelProvider: 'fixture-local', modelId: 'correlation' });
    const binding = { requesterId: 'requester', conversationId: 'conversation' };
    const reference = domain === 'jessica-vacuum'
      ? { schemaVersion: 1 as const, domain, binding, clarificationId: 'question' }
      : { schemaVersion: 1 as const, domain, binding, contextId: 'context', revision: 1, currentEvidenceId: 'earlier' };
    for (const value of [{ operation }, createTaskEnvelope('fixture'), createPendingTaskEnvelope('fixture', null),
      createPendingTaskEnvelope('fixture', reference)]) {
      assert.equal(Value.Check(parameters, value), true, `${domain}: ${JSON.stringify(value)}`);
    }
  }
});

test('emitted routing identity resource is byte-identical and loadable', () => {
  const original = readFileSync(resolve('agents/reminder-service/config/recipients.json'));
  const emitted = readFileSync(new URL('../../../../agents/reminder-service/config/recipients.json', import.meta.url));
  assert.deepEqual(emitted, original);
  assert.doesNotThrow(() => loadCanonicalIdentityContract());
});

test('release package roots select only emitted entries and exact canonical manifests', () => {
  for (const plugin of ['benson-routing', 'plugins/benson-jessica-tool', 'plugins/benson-reminder-tool']) {
    const directory = `integrations/openclaw/${plugin}`;
    const packagePath = resolve('output/typescript', directory, 'package.json');
    const pkg: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    assert(plain(pkg) && plain(pkg.openclaw) && plain(pkg.peerDependencies));
    assert.deepEqual(pkg.openclaw.extensions, ['./src/index.js']);
    assert.equal(pkg.peerDependencies.openclaw, '2026.10.4');
    assert(existsSync(resolve('output/typescript', directory, 'src/index.js')));
    assert.deepEqual(readFileSync(resolve('output/typescript', directory, 'openclaw.plugin.json')),
      readFileSync(resolve(directory, 'openclaw.plugin.json')));
  }
});

test('emitted Reminder runner reaches the canonical executable and preserves its resource/state root', () => {
  const canonical = resolve('agents/reminder-service/tools/reminder-service');
  assert(lstatSync(REMINDER_SERVICE_PATH).isSymbolicLink());
  assert.equal(realpathSync(REMINDER_SERVICE_PATH), realpathSync(canonical));
  for (const dependency of ['tools/reminder-service', 'libexec/reminder-service-core', 'lib/reminder_discovery.py']) {
    const info = statSync(resolve('agents/reminder-service', dependency));
    assert(info.isFile() && (info.mode & 0o111) !== 0);
  }
  assert.equal(existsSync(new URL('../../../../agents/reminder-service/state', import.meta.url)), false);
});

// This host double proves adapter custody only. It does not establish native
// hook propagation, effective tool policy or assembled loader acceptance.
function host() {
  let binding: unknown;
  const abort = new AbortController(), disposals: (() => unknown)[] = [];
  const hooks = new Map<string, unknown>();
  const api: ResponseHost = {
    lifecycle: { signal: abort.signal, onDispose(callback) { disposals.push(callback); return () => {
      const index = disposals.indexOf(callback); if (index >= 0) disposals.splice(index, 1);
    }; } },
    runtime: { channel: { runtimeContexts: {
      get<T>() { return binding as T | undefined; },
      register(input) {
        assert.equal(input.channelId, 'whatsapp'); assert.equal(input.accountId, 'test');
        assert.equal(input.capability, 'benson.response-controller.v1'); assert.equal(input.abortSignal, abort.signal);
        binding = input.context;
        return { dispose() { if (binding === input.context) binding = undefined; } };
      },
    } } },
    on(name, handler) { hooks.set(name, handler); },
  };
  const identities = loadIdentityContract({ accountId: 'test', trustedRequesterIds: ['operator'],
    recipients: [{ id: 'operator', type: 'person', channel: 'whatsapp', to: '+15550000001' }] });
  registerResponseController(api, identities);
  return { api, abort, replace(value: unknown) { binding = value; },
    dispose() { for (const callback of disposals) callback(); },
    hook(name: string, event: unknown, context: unknown) {
      const handler = hooks.get(name); assert.equal(typeof handler, 'function');
      if (typeof handler === 'function') return handler(event, context);
      throw new Error('Missing hook');
    },
    turn(requestId = 'request-1', from = '+15550000001') {
      assert(plain(binding) && typeof binding.createTurn === 'function');
      const ctx = { Provider: 'whatsapp', Surface: 'whatsapp', AccountId: 'test', SenderId: '+15550000001',
        From: from, To: '+15550000002', MessageSid: requestId, SessionKey: 'agent:main:main', RawBody: 'בדיקה' };
      const result: unknown = binding.createTurn({ ctx, replyOptions: {} });
      assert(isController(result));
      return { ctx, controller: result };
    },
  };
}
interface Controller {
  resolve(resolve: () => Promise<unknown>, handoff: unknown): Promise<unknown>;
  beforeNativeDeliver<T>(payload: T, info: { kind: string }): T | null;
}
function isController(value: unknown): value is Controller {
  return plain(value) && typeof value.resolve === 'function' && typeof value.beforeNativeDeliver === 'function';
}
const context = (): OpenClawPluginToolContext<2> => ({ agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'session-main',
  deliveryContext: { channel: 'whatsapp', accountId: 'test', to: '+15550000001' }, requesterSenderId: '+15550000001',
  assertInvocationCurrent() {} });
const runContext = { agentId: 'main', sessionKey: 'agent:main:main', sessionId: 'session-main', runId: 'run-main' };
const payload = () => ({ text: 'תשובה מבוקרת' });

for (const mode of ['original', 'missing', 'foreign-sender', 'repeated-identical'] as const) {
  test(`group current source requires its own original native sender: ${mode}`, async () => {
    const h = host(), turn = h.turn('group-request', 'fixture-group@g.us');
    const tool = { ...context(), deliveryContext: { channel: 'whatsapp', accountId: 'test', to: turn.ctx.From } };
    await turn.controller.resolve(async () => {
      const message = { role: 'user', content: turn.ctx.RawBody, idempotencyKey: 'group-native-key',
        __openclaw: { senderId: turn.ctx.SenderId, senderIdentity: { type: 'observation',
          id: mode === 'foreign-sender' ? '+15550000003' : turn.ctx.SenderId, pluginId: 'whatsapp', accountId: 'test' },
          transport: { channel: 'whatsapp', conversationRef: turn.ctx.From, messageId: turn.ctx.MessageSid } } };
      if (mode !== 'missing') h.hook('before_message_write', { message }, runContext);
      if (mode === 'repeated-identical') h.hook('before_message_write', { message: structuredClone(message) }, runContext);
      const evidence = currentNativeTurn(h.api, tool).source(tool);
      const projection = createCurrentRequestContext(evidence).projectCurrentRequest();
      if (mode === 'original' || mode === 'repeated-identical') {
        assert.equal(projection.status, 'available');
        assert.equal(projection.context.conversation.kind, 'group');
        assert.equal(projection.context.conversation.peerId, turn.ctx.From);
        assert.equal(projection.context.current.sender?.source, 'native_metadata');
        assert.equal(projection.context.current.sender?.id, turn.ctx.SenderId);
      } else assert.equal(projection.status, 'unavailable');
      h.hook('agent_end', { success: true }, runContext); return payload();
    }, Object.freeze({ ctx: { ...turn.ctx }, abortSignal: new AbortController().signal }));
    h.dispose();
  });
}

test('registration requires lifecycle and refuses another owner', () => {
  const h = host();
  assert.throws(() => registerResponseController(h.api, loadIdentityContract({ accountId: 'test', trustedRequesterIds: ['x'],
    recipients: [{ id: 'x', type: 'person', channel: 'whatsapp', to: '+15550000001' }] })), /already_owned/);
  assert.throws(() => currentNativeTurn(h.api, context()), /source_unavailable/);
  h.dispose();
});

test('native metadata and discovery modes create no runtime registration or configuration reads', () => {
  const register: unknown = entry.register; assert.equal(typeof register, 'function');
  if (typeof register !== 'function') throw new Error('Missing native entry');
  for (const registrationMode of ['discovery', 'tool-discovery', 'setup-only', 'setup-runtime', 'cli-metadata']) {
    register({ registrationMode });
  }
});

test('concurrent native resolver scopes cannot borrow each other\'s original request', async () => {
  const h = host(), a = h.turn('request-a'), b = h.turn('request-b');
  let release: (() => void) | undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const execute = async (turn: typeof a, expected: string) => turn.controller.resolve(async () => {
    await barrier;
    const source = currentNativeTurn(h.api, context()).source(context()).currentTurn();
    assert(plain(source)); assert.equal(source.entryId, expected);
    h.hook('agent_end', { success: true }, { ...runContext, runId: expected });
    return payload();
  }, Object.freeze({ ctx: { ...turn.ctx }, abortSignal: new AbortController().signal }));
  const first = execute(a, 'request-a'), second = execute(b, 'request-b');
  assert(release); release();
  const resolved = await Promise.all([first, second]);
  assert.deepEqual(a.controller.beforeNativeDeliver(resolved[0], { kind: 'final' }), payload());
  assert.deepEqual(b.controller.beforeNativeDeliver(resolved[1], { kind: 'final' }), payload());
  h.dispose();
});

test('original source crosses async work and retires after resolution; final delivery keeps independent native custody', async () => {
  const h = host(), turn = h.turn(), abort = new AbortController(), tool = context();
  let retained: ReturnType<typeof currentNativeTurn> | undefined;
  const result = await turn.controller.resolve(async () => {
    await Promise.resolve();
    retained = currentNativeTurn(h.api, tool);
    const source = retained.source(tool).currentTurn(); assert(plain(source));
    assert.equal(source.entryId, 'request-1');
    assert.throws(() => retained?.source({ ...tool, requesterSenderId: '+15550000003' }), /source_mismatch/);
    h.hook('agent_end', { success: true }, runContext);
    return payload();
  }, Object.freeze({ ctx: { ...turn.ctx }, abortSignal: abort.signal }));
  assert(retained); const retired = retained;
  assert.throws(() => retired.source(tool), /source_mismatch/);
  assert.deepEqual(result, payload());
  assert.deepEqual(turn.controller.beforeNativeDeliver(result, { kind: 'final' }), payload());
  assert.equal(turn.controller.beforeNativeDeliver(result, { kind: 'final' }), null);
  h.dispose();
});

for (const failure of ['abort', 'dispose', 'replace', 'source-change', 'native-context-change'] as const) {
  test(`authority is checked again before native delivery: ${failure}`, async () => {
    const h = host(), turn = h.turn(), abort = new AbortController(), native = { ...turn.ctx };
    const result = await turn.controller.resolve(async () => {
      h.hook('agent_end', { success: true }, runContext); return payload();
    }, Object.freeze({ ctx: native, abortSignal: abort.signal }));
    if (failure === 'abort') abort.abort();
    if (failure === 'dispose') h.dispose();
    if (failure === 'replace') h.replace({});
    if (failure === 'source-change') turn.ctx.RawBody = 'changed';
    if (failure === 'native-context-change') native.From = '+15550000003';
    assert.equal(turn.controller.beforeNativeDeliver(result, { kind: 'final' }), null);
    h.dispose();
  });
}

test('missing task settlement cannot become an ordinary reply', async () => {
  const h = host(), turn = h.turn(), abort = new AbortController();
  await assert.rejects(turn.controller.resolve(async () => {
    h.hook('before_tool_call', { toolName: 'jessica_task', toolCallId: 'call-1', runId: runContext.runId },
      { ...runContext, toolCallId: 'call-1' });
    const native = currentNativeTurn(h.api, context());
    assert.deepEqual(native.caller(context(), 'call-1'), runContext);
    assert.throws(() => native.caller(context(), 'forged'), /call_unbound/);
    h.hook('agent_end', { success: true }, runContext); return payload();
  }, Object.freeze({ ctx: turn.ctx, abortSignal: abort.signal })), /result_missing/);
  h.dispose();
});

for (const failure of ['missing-write', 'malformed-write', 'duplicate-write', 'changed-repeat', 'foreign-session'] as const) {
  test(`resolver history cannot accept unverifiable write custody: ${failure}`, async () => {
    const h = host(), turn = h.turn(), tool = context();
    await turn.controller.resolve(async () => {
      const message = { role: 'user', content: turn.ctx.RawBody, idempotencyKey: 'native-key',
        __openclaw: { senderId: turn.ctx.SenderId, senderIdentity: { type: 'observation', id: turn.ctx.SenderId,
          pluginId: 'whatsapp', accountId: 'test' }, transport: { channel: 'whatsapp',
          conversationRef: 'native-conversation', messageId: turn.ctx.MessageSid } } };
      if (failure === 'malformed-write') message.content += 'changed';
      const writeContext = { ...runContext, sessionKey: failure === 'foreign-session' ? 'foreign' : runContext.sessionKey };
      if (failure !== 'missing-write') h.hook('before_message_write', { message }, writeContext);
      if (failure === 'duplicate-write' || failure === 'changed-repeat') {
        const conflicting = { ...message, ...failure === 'duplicate-write' ? { idempotencyKey: 'different-native-key' } : { content: message.content + 'changed' } };
        h.hook('before_message_write', { message: conflicting }, writeContext);
        h.hook('before_message_write', { message }, writeContext); // A later valid observation cannot restore retired custody.
      }
      await assert.rejects(currentNativeTurn(h.api, tool).originalUserTurns(tool), /context_unavailable/);
      h.hook('agent_end', { success: true }, runContext); return payload();
    }, Object.freeze({ ctx: turn.ctx, abortSignal: new AbortController().signal }));
    h.dispose();
  });
}

for (const failure of ['missing-terminal', 'foreign-handoff', 'pre-aborted', 'extra-handoff-field'] as const) {
  test(`invalid native resolver evidence blocks before candidate delivery: ${failure}`, async () => {
    const h = host(), turn = h.turn(), abort = new AbortController();
    if (failure === 'pre-aborted') abort.abort();
    const ctx = failure === 'foreign-handoff' ? { ...turn.ctx, AccountId: 'foreign' } : turn.ctx;
    await assert.rejects(turn.controller.resolve(async () => payload(), Object.freeze({ ctx, abortSignal: abort.signal,
      ...failure === 'extra-handoff-field' ? { injected: true } : {} })));
    assert.equal(turn.controller.beforeNativeDeliver(payload(), { kind: 'final' }), null);
    h.dispose();
  });
}

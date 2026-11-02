import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { OpenClawPluginApi, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { copyReplyPayloadMetadata } from 'openclaw/plugin-sdk/reply-payload';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-runtime';
import { createMainResponseDelivery } from '../../core/response-control.js';
import { createResponseEnvelope, createResponseV4Envelope } from '../../core/legacy-response.js';
import { validateDomainResultEnvelope } from '../../core/domain-result.js';
import { MAX_RESPONSE_RESULTS, plain, synchronous, fail } from '../../core/value.js';
import type { AnyDomainResult } from '../../core/contracts.js';
import type { CurrentRequestEvidence } from '../../core/conversation-context.js';
import type { Binding6 } from '../../core/completion-contracts.js';
import { resolveRoute, type IdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';
import { renderReminderDomainResult } from '../../../../../agents/reminder-service/lib/presentation.js';
import { renderJessicaDomainResult } from '../../../../../agents/jessica-vacuum/lib/presentation.js';
import { acquireOriginalUserTurns, retainOriginalUserWrite, type NativeOriginalUserTurns } from './conversation.js';

const capability = 'benson.response-controller.v1';
type ToolContext = OpenClawPluginToolContext<2>;
type Caller = NonNullable<Binding6['caller']>;
type Registry = OpenClawPluginApi['runtime']['channel']['runtimeContexts'];
export type ResponseHost = {
  lifecycle: Pick<OpenClawPluginApi['lifecycle'], 'signal' | 'onDispose'>;
  runtime: { channel: { runtimeContexts: Pick<Registry, 'get' | 'register'> } };
  on: OpenClawPluginApi['on'];
};
/** Private cross-plugin view of the original native resolver invocation. It is
 * never serialized, retained for restart, or obtained from model arguments.
 */
export interface NativeTurn {
  source(context: ToolContext): CurrentRequestEvidence;
  originalUserTurns(context: ToolContext): Promise<NativeOriginalUserTurns>;
  caller(context: ToolContext, callId: string): Caller;
  record(context: ToolContext, callId: string, result: unknown, assertCurrent: () => void): void;
  assertCurrent(): void;
}
function nativeTurn(value: unknown): value is NativeTurn {
  return plain(value) && typeof value.source === 'function' && typeof value.caller === 'function' &&
    typeof value.record === 'function' && typeof value.assertCurrent === 'function' && typeof value.originalUserTurns === 'function';
}
export function currentNativeTurn(api: ResponseHost, context: ToolContext): NativeTurn {
  const accountId = context.deliveryContext?.accountId;
  if (!accountId) fail('native_original_source_unavailable');
  const binding: unknown = api.runtime.channel.runtimeContexts.get({ channelId: 'whatsapp', accountId, capability });
  if (!plain(binding) || typeof binding.current !== 'function') fail('native_original_source_unavailable');
  const turn: unknown = synchronous(binding.current(context), 'native_original_source_must_be_synchronous');
  if (!nativeTurn(turn)) fail('native_original_source_unavailable');
  return turn;
}

export function registerResponseController(api: ResponseHost, identities: IdentityContract): void {
  const signal = api.lifecycle.signal, dispose = api.lifecycle.onDispose;
  if (!signal || !dispose) fail('native_plugin_lifecycle_unavailable');
  signal.throwIfAborted();
  const scope = new AsyncLocalStorage<NativeTurn>();
  const key = { channelId: 'whatsapp', accountId: identities.accountId, capability };
  if (api.runtime.channel.runtimeContexts.get(key) !== undefined) fail('native_response_binding_already_owned');
  let live = true;
  type RunContext = { agentId?: string; sessionKey?: string; sessionId?: string; runId?: string };
  const binders = new WeakMap<NativeTurn, (context: RunContext, callId?: string, name?: string) => void>();
  const terminals = new WeakMap<NativeTurn, (context: RunContext, success: boolean) => void>();
  const writes = new WeakMap<NativeTurn, { observe(message: unknown, context: RunContext): void }>();
  const binding = Object.freeze({
    current(context: ToolContext) {
      const turn = scope.getStore();
      if (!turn) fail('native_original_source_unavailable');
      turn.source(context); return turn;
    },
    createTurn(input: { ctx: unknown; replyOptions: unknown }) {
      if (!plain(input.ctx) || !plain(input.replyOptions)) fail('native_response_context_invalid');
      const ctx = input.ctx, captured = Object.freeze(Object.fromEntries(
        ['Provider', 'Surface', 'AccountId', 'SenderId', 'From', 'To', 'MessageSid', 'SessionKey', 'RawBody'].map(name => [name, ctx[name]])));
      const text = (name: string) => { const value = captured[name]; if (typeof value !== 'string' || !value.trim()) fail('native_response_context_invalid'); return value; };
      if (text('Provider') !== 'whatsapp' || text('Surface') !== 'whatsapp' || text('AccountId') !== identities.accountId) fail('native_response_route_invalid');
      const route = resolveRoute(identities, { channel: 'whatsapp', accountId: identities.accountId, to: text('From'), senderId: text('SenderId') });
      if (!route) fail('native_response_requester_untrusted');
      const requestId = text('MessageSid'), sessionKey = text('SessionKey');
      let handoff: { ctx: Record<string, unknown>; abortSignal: AbortSignal } | undefined;
      let executionLive = true, started = false, main: Caller | undefined, terminal: boolean | undefined;
      const calls = new Map<string, string>();
      const results = new Map<string, { value: AnyDomainResult; current(): void }>();
      const current = () => {
        signal.throwIfAborted(); handoff?.abortSignal.throwIfAborted();
        if (!live || !handoff || api.runtime.channel.runtimeContexts.get(key) !== binding) fail('native_response_authority_retired');
        for (const name of Object.keys(captured)) {
          if (ctx[name] !== captured[name] || handoff.ctx[name] !== captured[name]) fail('native_response_source_changed');
        }
      };
      const invocation = (context: ToolContext) => {
        current();
        if (!executionLive || context.agentId !== 'main' || context.sessionKey !== sessionKey ||
          context.deliveryContext?.channel !== 'whatsapp' || context.deliveryContext.accountId !== identities.accountId ||
          context.deliveryContext.to !== route.sourceId || context.requesterSenderId !== route.senderId) fail('native_original_source_mismatch');
        synchronous(context.assertInvocationCurrent(), 'native_original_source_authority_must_be_synchronous');
      };
      const turn: NativeTurn = Object.freeze({
        assertCurrent: current,
        source(context: ToolContext): CurrentRequestEvidence {
          invocation(context);
          return { request: text('RawBody'),
            binding: { conversationRef: sessionKey, channel: 'whatsapp', accountId: identities.accountId,
              kind: route.sourceType === 'group' ? 'group' : 'direct', peerId: route.sourceId, threadId: null, requesterId: route.senderId },
            currentTurn() {
              invocation(context);
              let sender: unknown = { source: 'canonical_peer_binding', id: route.senderId, channel: 'whatsapp', accountId: identities.accountId };
              if (route.sourceType === 'group') {
                // A group peer is not its sender. Reuse the exact native
                // observation already validated against this resolver input.
                const metadata = originalWrite?.message.__openclaw;
                if (writeUnavailable || !plain(metadata) || !plain(metadata.senderIdentity)) fail('native_original_source_unavailable');
                sender = { source: 'native_metadata', id: route.senderId, identity: structuredClone(metadata.senderIdentity),
                  name: metadata.senderName ?? null, username: metadata.senderUsername ?? null };
              }
              return { entryId: requestId, role: 'user', text: text('RawBody'), sender,
                inputProvenance: { kind: 'external_user' } };
            },
            assertCurrent() { invocation(context); },
            assertAuthorized() { invocation(context); },
          };
        },
        async originalUserTurns(context: ToolContext) {
          invocation(context);
          if (!context.sessionId || !originalWrite || writeUnavailable) fail('native_original_context_unavailable');
          const source = turn.source(context);
          const history = await acquireOriginalUserTurns({ target: { agentId: 'main', sessionKey, sessionId: context.sessionId },
            binding: source.binding, request: text('RawBody'), write: originalWrite, assertCurrent: current });
          invocation(context); return history;
        },
        caller(context: ToolContext, callId: string) {
          invocation(context);
          if (!main || main.sessionId !== context.sessionId || !calls.has(callId)) fail('native_task_call_unbound');
          return Object.freeze({ ...main });
        },
        record(context: ToolContext, callId: string, raw: unknown, assertCurrent: () => void) {
          invocation(context); assertCurrent();
          if (!calls.has(callId) || results.has(callId) || results.size >= MAX_RESPONSE_RESULTS) fail('native_task_result_unbound');
          const value = validateDomainResultEnvelope(raw);
          const expected = calls.get(callId) === 'jessica_task' ? 'jessica-vacuum' : 'reminder';
          if (value.domain !== expected) fail('native_task_domain_mismatch');
          results.set(callId, { value, current: assertCurrent });
        },
      });
      let originalWrite: ReturnType<typeof retainOriginalUserWrite> | undefined, writeUnavailable = false;
      writes.set(turn, { observe(message, context) {
        if (!plain(message) || message.role !== 'user') return;
        if (writeUnavailable) return;
        try {
          current();
          if (context.sessionKey !== sessionKey) fail('native_original_context_unavailable');
          const observed = retainOriginalUserWrite(message, { requestId, request: text('RawBody'),
            senderId: route.senderId, accountId: identities.accountId });
          // Native admission and runtime persistence may observe the same
          // original write. Repeated observation is not another original input;
          // retain one exact identity/carrier and permanently reject conflicts.
          if (originalWrite && !isDeepStrictEqual(originalWrite, observed)) fail('native_original_context_unavailable');
          originalWrite ??= observed;
        } catch { writeUnavailable = true; }
      } });
      binders.set(turn, (context, callId, name) => {
        current();
        if (context.agentId !== 'main' || context.sessionKey !== sessionKey || !context.sessionId || !context.runId) fail('native_main_run_unbound');
        const candidate = { agentId: 'main', sessionKey, sessionId: context.sessionId, runId: context.runId };
        if (main && JSON.stringify(main) !== JSON.stringify(candidate)) fail('native_main_run_changed');
        main = candidate;
        if (callId && name) { if (calls.has(callId) || calls.size >= MAX_RESPONSE_RESULTS) fail('native_task_call_duplicate'); calls.set(callId, name); }
      });
      terminals.set(turn, (context, success) => { binders.get(turn)?.(context); if (terminal !== undefined) fail('native_main_terminal_duplicate'); terminal = success; });
      const response = createMainResponseDelivery({ mode: 'native-resolver', requestId, agentId: 'main',
        runId() { if (!main) fail('native_main_run_unbound'); return main.runId; }, assertCurrent: current,
        responseFor(payload) {
          current(); if (!main || terminal === undefined || !plain(payload) || typeof payload.text !== 'string') fail('native_main_terminal_unbound');
          if (calls.size) {
            if (results.size !== calls.size) fail('native_task_result_missing');
            return createResponseV4Envelope({ messageCandidate: null }, { requestId, source: { type: 'main', agentId: 'main', runId: main.runId },
              results: [...results.values()].map(item => item.value), lifecycle: { domainExecution: 'attempted', failure: terminal ? null : 'MAIN_RUN_FAILED' },
              responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic'] } });
          }
          return createResponseEnvelope({ messageCandidate: terminal ? { text: payload.text, language: 'he' } : null }, {
            requestId, source: { type: 'main', agentId: 'main', runId: main.runId }, status: terminal ? 'success' : 'failure', results: [], pendingContext: null,
            provenance: { executionVerified: 'not_applicable', completionCorrelated: false }, lifecycle: { domainExecution: 'none', failure: terminal ? null : 'MAIN_RUN_FAILED' },
            responsePolicy: { preferredMode: terminal ? 'pass_through' : 'safe_failure', allowedModes: terminal ? ['pass_through'] : ['safe_failure'] } });
        }, presentation: { language: 'he', timezone: 'Asia/Jerusalem', get now() { return new Date().toISOString(); },
          assertResponseCurrent() { current(); for (const item of results.values()) item.current(); },
          renderDomainResult(result, options) { return result.domain === 'jessica-vacuum' ? renderJessicaDomainResult(result, options) : renderReminderDomainResult(result, options); } },
      });
      return Object.freeze({
        beforeNativeDeliver: response.beforeNativeDeliver,
        async resolve(resolve: () => Promise<unknown>, raw: unknown) {
          if (started || !plain(raw) || !Object.isFrozen(raw) || !plain(raw.ctx) ||
            Reflect.ownKeys(raw).length !== 2 || !(raw.abortSignal instanceof AbortSignal)) fail('native_response_handoff_invalid');
          const nativeSignal = raw.abortSignal;
          started = true; handoff = { ctx: raw.ctx, abortSignal: nativeSignal }; current();
          try {
            return await scope.run(turn, () => response.resolveNativeCandidate({ resolve, signal: nativeSignal,
              copyMetadata: (source, approved) => copyReplyPayloadMetadata(source as ReplyPayload, approved) }));
          } finally { executionLive = false; binders.delete(turn); terminals.delete(turn); writes.delete(turn); }
        },
      });
    },
  });
  api.on('before_message_write', (event, context) => {
    const turn = scope.getStore();
    if (turn && context.agentId === 'main') writes.get(turn)?.observe(event.message, context);
  });
  api.on('before_tool_call', (event, context) => {
    const turn = scope.getStore();
    if (turn && context.agentId === 'main' && ['jessica_task', 'reminder_task'].includes(event.toolName)) {
      if (!context.toolCallId || event.toolCallId !== context.toolCallId || event.runId !== context.runId) fail('native_task_hook_unbound');
      binders.get(turn)?.(context, context.toolCallId, event.toolName);
    }
  });
  api.on('agent_end', (event, context) => { const turn = scope.getStore(); if (turn && context.agentId === 'main') terminals.get(turn)?.(context, event.success); });
  const lease = api.runtime.channel.runtimeContexts.register({ ...key, context: binding, abortSignal: signal });
  dispose(() => { live = false; lease.dispose(); scope.disable(); });
}

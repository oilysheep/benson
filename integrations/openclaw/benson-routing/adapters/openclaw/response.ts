import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { OpenClawPluginApi, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { getPluginRuntimeGatewayRequestScope } from 'openclaw/plugin-sdk/plugin-runtime';
import { copyReplyPayloadMetadata } from 'openclaw/plugin-sdk/reply-payload';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-runtime';
import { createMainResponseDelivery } from '../../core/response-control.js';
import { createResponseEnvelope, createResponseV4Envelope } from '../../core/legacy-response.js';
import { validateDomainResultEnvelope } from '../../core/domain-result.js';
import { MAX_RESPONSE_RESULTS, plain, synchronous, fail } from '../../core/value.js';
import type { AnyDomainResult } from '../../core/contracts.js';
import type { CurrentRequestEvidence } from '../../core/conversation-context.js';
import type { Binding6 } from '../../core/completion-contracts.js';
import type { IdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';
import { createNativeMainRequestAdmission } from './request.js';
import { renderReminderDomainResult } from '../../../../../agents/reminder-service/lib/presentation.js';
import { PublicSchemas } from '../../../../../agents/reminder-service/lib/schemas.js';
import { renderJessicaDomainResult } from '../../../../../agents/jessica-vacuum/lib/presentation.js';
import { acquireOriginalUserTurns, retainOriginalUserWrite, type NativeOriginalUserTurns } from './conversation.js';

const capability = 'benson.response-controller.v1';
type ToolContext = OpenClawPluginToolContext<2>;
type Caller = NonNullable<Binding6['caller']>;
type Registry = OpenClawPluginApi['runtime']['channel']['runtimeContexts'];
export type ResponseHost = {
  registrationMode?: OpenClawPluginApi['registrationMode'];
  logger?: Pick<OpenClawPluginApi['logger'], 'warn'>;
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
/** Read-only projection, never authority. At before_main this is the selected
 * channel dispatch registry; at source_refusal native Tool scope may replace it.
 * Fingerprints compare technical source/registration identities without paths.
 */
export function projectNativeRegistrySelection(value: unknown) {
  if (!plain(value)) return { registry: value === undefined ? 'absent' : 'unavailable' };
  if (!Array.isArray(value.plugins) || !Array.isArray(value.tools)) return { registry: 'unavailable' };
  const plugins: unknown[] = value.plugins, tools: unknown[] = value.tools;
  const fingerprint = (input: string) => createHash('sha256').update(input).digest('hex');
  const project = (id: string, names: readonly string[]) => {
    const records = plugins.filter(record => plain(record) && record.id === id);
    if (records.length !== 1) return { record: records.length ? 'multiple' : 'absent' };
    const record = records[0];
    if (!plain(record)) return { record: 'unavailable' };
    const registrations = tools.filter(tool => plain(tool) && tool.pluginId === id);
    const groups = new Map<string, number>();
    let valid = registrations.length <= 32;
    for (const registration of registrations) {
      if (!plain(registration) || !Array.isArray(registration.names) || registration.names.length === 0 || registration.names.length > 32 ||
        typeof registration.optional !== 'boolean' || registration.names.some(name => typeof name !== 'string' || !names.includes(name))) {
        valid = false; break;
      }
      // Same declared identity and multiplicity as native tool adoption.
      const identity = JSON.stringify([registration.optional, [...new Set(registration.names)].sort()]);
      groups.set(identity, (groups.get(identity) ?? 0) + 1);
    }
    return { record: 'one', state: record.status === 'loaded' ? record.enabled === true ? 'loaded_enabled' : 'loaded_disabled' : 'other',
      source: typeof record.source === 'string' && record.source.length > 0 && record.source.length <= 16384
        ? fingerprint(record.source) : 'unavailable',
      tools: valid ? fingerprint(JSON.stringify([...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) : 'unavailable' };
  };
  return { registry: 'present',
    jessica: project('benson-jessica-tool', ['jessica_task', 'jessica_read', 'jessica_execute', 'jessica_validate_completion']),
    reminder: project('benson-reminder-tool', ['reminder_task', ...Object.keys(PublicSchemas)]),
  };
}
function registrationOwnerDiagnostics(api: ResponseHost, phase: 'before_main' | 'gateway_start', registrationOwner: unknown, selected?: unknown): void {
  try {
    api.logger?.warn(`benson.native_registration_owner ${JSON.stringify({ phase,
      sameRegistryAsSelected: registrationOwner === undefined || selected === undefined ? 'unavailable' : registrationOwner === selected,
      ...projectNativeRegistrySelection(registrationOwner),
    })}`);
  } catch { /* Observation cannot change admission or source refusal. */ }
}
function registryDiagnostics(api: ResponseHost, phase: 'before_main' | 'source_refusal', registrationOwner?: unknown): void {
  try {
    const scope = getPluginRuntimeGatewayRequestScope();
    api.logger?.warn(`benson.native_registry_selection ${JSON.stringify({ phase, scope: scope ? 'present' : 'absent',
      ...projectNativeRegistrySelection(scope?.pluginRegistry) })}`);
    if (phase === 'before_main') registrationOwnerDiagnostics(api, phase, registrationOwner, scope?.pluginRegistry);
  } catch {
    // Observability cannot grant authority or change the original refusal.
    try { api.logger?.warn(`benson.native_registry_selection ${JSON.stringify({ phase, scope: 'unavailable', registry: 'unavailable' })}`); } catch { /* No raw exception. */ }
  }
}
function sourceUnavailable(api: ResponseHost, reason: 'account_missing' | 'binding_missing' |
  'binding_invalid' | 'resolver_scope_missing' | 'turn_invalid' | 'group_metadata_missing'): never {
  // Only closed enums: distinguish discovery ownership from retired lifecycle
  // without exposing context, source text, identifiers or runtime objects.
  const mode = api.registrationMode === 'full' || api.registrationMode === 'tool-discovery'
    ? api.registrationMode : api.registrationMode === undefined ? 'unknown' : 'other';
  const lifecycle = api.lifecycle.signal ? api.lifecycle.signal.aborted ? 'aborted' : 'active' : 'unavailable';
  try { api.logger?.warn(`benson.native_original_source_unavailable reason=${reason} registration_mode=${mode} lifecycle=${lifecycle}`); } catch { /* Refuse below. */ }
  registryDiagnostics(api, 'source_refusal');
  return fail('native_original_source_unavailable');
}
export function currentNativeTurn(api: ResponseHost, context: ToolContext): NativeTurn {
  const accountId = context.deliveryContext?.accountId;
  if (!accountId) sourceUnavailable(api, 'account_missing');
  const binding: unknown = api.runtime.channel.runtimeContexts.get({ channelId: 'whatsapp', accountId, capability });
  if (binding === undefined) sourceUnavailable(api, 'binding_missing');
  if (!plain(binding) || typeof binding.current !== 'function') sourceUnavailable(api, 'binding_invalid');
  const turn: unknown = synchronous(binding.current(context), 'native_original_source_must_be_synchronous');
  if (!nativeTurn(turn)) sourceUnavailable(api, 'turn_invalid');
  return turn;
}

export function registerResponseController(api: ResponseHost, identities: IdentityContract): void {
  const signal = api.lifecycle.signal, dispose = api.lifecycle.onDispose;
  if (!signal || !dispose) fail('native_plugin_lifecycle_unavailable');
  signal.throwIfAborted();
  // Observation only: preserve the public registration frame for comparison
  // with the later dispatch selection. This reference never grants authority.
  let diagnosticRegistrationOwner: unknown;
  try { diagnosticRegistrationOwner = getPluginRuntimeGatewayRequestScope()?.pluginRegistry; } catch { /* UNKNOWN, never a fallback. */ }
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
      if (!turn) sourceUnavailable(api, 'resolver_scope_missing');
      turn.source(context); return turn;
    },
    createTurn(input: { ctx: unknown; replyOptions: unknown }) {
      if (!plain(input.ctx) || !plain(input.replyOptions)) fail('native_response_context_invalid');
      let handoff: { ctx: Record<string, unknown>; abortSignal: AbortSignal } | undefined;
      let executionLive = true, started = false, main: Caller | undefined, terminal: boolean | undefined;
      const calls = new Map<string, string>();
      const results = new Map<string, { value: AnyDomainResult; current(): void }>();
      const nativeCurrent = () => {
        signal.throwIfAborted(); handoff?.abortSignal.throwIfAborted();
        if (!live || !handoff || api.runtime.channel.runtimeContexts.get(key) !== binding) fail('native_response_authority_retired');
      };
      const request = createNativeMainRequestAdmission(identities, input.ctx, nativeCurrent);
      const { route, requestId, sessionKey } = request;
      const current = request.assertSourceCurrent;
      const invocation = (context: ToolContext) => {
        current();
        if (!executionLive || context.agentId !== 'main' || context.sessionKey !== sessionKey ||
          context.deliveryContext?.channel !== 'whatsapp' || context.deliveryContext.accountId !== identities.accountId ||
          context.deliveryContext.to !== route.sourceId || context.requesterSenderId !== route.senderId) fail('native_original_source_mismatch');
        request.assertCurrent();
        synchronous(context.assertInvocationCurrent(), 'native_original_source_authority_must_be_synchronous');
      };
      const turn: NativeTurn = Object.freeze({
        assertCurrent: current,
        source(context: ToolContext): CurrentRequestEvidence {
          invocation(context);
          return { request: request.request,
            binding: { conversationRef: sessionKey, channel: 'whatsapp', accountId: identities.accountId,
              kind: route.sourceType === 'group' ? 'group' : 'direct', peerId: route.sourceId, threadId: null, requesterId: route.senderId },
            currentTurn() {
              invocation(context);
              let sender: unknown = { source: 'canonical_peer_binding', id: route.senderId, channel: 'whatsapp', accountId: identities.accountId };
              if (route.sourceType === 'group') {
                // A group peer is not its sender. Reuse the exact native
                // observation already validated against this resolver input.
                const metadata = originalWrite?.message.__openclaw;
                if (writeUnavailable || !plain(metadata) || !plain(metadata.senderIdentity)) sourceUnavailable(api, 'group_metadata_missing');
                sender = { source: 'native_metadata', id: route.senderId, identity: structuredClone(metadata.senderIdentity),
                  name: metadata.senderName ?? null, username: metadata.senderUsername ?? null };
              }
              return { entryId: requestId, role: 'user', text: request.request, sender,
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
            binding: source.binding, request: request.request, write: originalWrite, assertCurrent: current });
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
          const observed = retainOriginalUserWrite(message, { requestId, request: request.request,
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
          started = true; handoff = { ctx: raw.ctx, abortSignal: nativeSignal };
          try {
            request.admit(raw.ctx); current();
            registryDiagnostics(api, 'before_main', diagnosticRegistrationOwner);
            return await scope.run(turn, () => response.resolveNativeCandidate({ resolve, signal: nativeSignal,
              copyMetadata: (source, approved) => copyReplyPayloadMetadata(source as ReplyPayload, approved) }));
          } finally { executionLive = false; request.retire(); binders.delete(turn); terminals.delete(turn); writes.delete(turn); }
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
  api.on('gateway_start', () => {
    if (!live || signal.aborted) return;
    let selected: unknown;
    try { selected = getPluginRuntimeGatewayRequestScope()?.pluginRegistry; } catch { /* UNKNOWN observation. */ }
    registrationOwnerDiagnostics(api, 'gateway_start', diagnosticRegistrationOwner, selected);
  });
  const lease = api.runtime.channel.runtimeContexts.register({ ...key, context: binding, abortSignal: signal });
  dispose(() => {
    diagnosticRegistrationOwner = undefined;
    live = false; lease.dispose(); scope.disable();
  });
}

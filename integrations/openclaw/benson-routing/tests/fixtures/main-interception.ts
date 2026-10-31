import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { OpenClawPluginApi, OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';
import { createReplyDispatcher, dispatchInboundMessage, getReplyFromConfig, settleReplyDispatcher,
  type ReplyPayload } from 'openclaw/plugin-sdk/reply-runtime';
import { copyReplyPayloadMetadata } from 'openclaw/plugin-sdk/reply-payload';
import { createResponseEnvelope, createResponseV3Envelope } from '../../core/legacy-response.js';
import { controlResponse, createMainResponseDelivery } from '../../core/response-control.js';
import { createCurrentRequestContext, type ConversationTurn } from '../../core/conversation-context.js';
import { createJessicaTaskToolFactory } from '../../../plugins/benson-jessica-tool/src/tool.js';
import { createReminderTaskToolFactory } from '../../../plugins/benson-reminder-tool/src/tool.js';
import { loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.js';
import { loadIdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';
import { validateDomainResult } from '../../core/domain-result.js';
import { renderJessicaDomainResult } from '../../../../../agents/jessica-vacuum/lib/presentation.js';
import { renderReminderDomainResult } from '../../../../../agents/reminder-service/lib/presentation.js';
import { isolated, worker, writeReport } from './native-correlation.js';

type CaseName = 'takeover' | 'hook-error' | 'before-dispatch' | 'pre-aborted';
type Probe = { name: CaseName; hookCalls: number; defaultCalls: number; runStarts: number; replyStarts: number;
  gateChecks: number; rejected: boolean; rejection: string | null; nativeRunIds: string[]; sink: { text: string | undefined }[];
  atReturn: { runStarts: number; sinkCount: number } | null };
type OutboundCase = 'native-main' | 'invalid-response' | 'sending-hook-error' | 'early-reply' | 'takeover-fallback' | 'resolver-block' | 'sending-hook-timeout';
type OutboundProbe = { name: OutboundCase; runIds: string[]; defaultCalls: number; takeoverCalls: number; gateChecks: number;
  hookEvents: { kind: string; runId: string | null; sessionKey: string | null; messageId: string | null; text: string | null }[];
  rejected: string[]; sink: (string | undefined)[] };
type TerminalProbe = { name: 'provider-error' | 'native-timeout' | 'partial-abort' | 'native-fallback' | 'bounded-success' | 'handled-tool-failure' | 'bounded-hook-error' | 'bounded-hook-timeout' | 'bounded-hook-rejected'; toolFailures: number; runIds: string[];
  terminalOutcomes: string[]; agentEnds: { runId: string | null; runIdSource: string; success: boolean; error: string | null }[];
  partials: number; abortIssued: boolean; outbound: { kind: string; runId: string | null; text: string | null; isError: boolean }[];
  sink: (string | undefined)[]; dispatchError: string | null; settledCalls: number;
  responseChecks: number; responseErrors: string[] };

function responseFor(text: string, requestId: string, runId: string) {
  return createResponseEnvelope({ messageCandidate: { text, language: 'en' } }, {
    requestId, source: { type: 'main', agentId: 'main', runId }, status: 'success', results: [], pendingContext: null,
    provenance: { executionVerified: 'not_applicable', completionCorrelated: false },
    lifecycle: { domainExecution: 'none', failure: null },
    responsePolicy: { preferredMode: 'pass_through', allowedModes: ['pass_through', 'safe_failure'] },
  });
}
const renderOptions = () => ({ language: 'en' as const, now: new Date().toISOString(), timezone: 'UTC' });

// Explicit supported terminal-text profile. No observer callback sends output.
const terminalTextProfile = Object.freeze({ disableBlockStreaming: true,
  suppressToolProgressMessages: true, suppressDefaultToolProgressMessages: true,
  allowToolLifecycleWhenProgressHidden: false, reasoningPayloadsEnabled: false,
  commentaryPayloadsEnabled: false, commentaryProgressEnabled: false, progressPreambleEnabled: false });
type NativeResolver = NonNullable<Parameters<typeof dispatchInboundMessage>[0]['replyResolver']>;
function controlledNativeResolver(delivery: ReturnType<typeof createMainResponseDelivery>, dispatcher: ReturnType<typeof createReplyDispatcher>, abort: AbortController,
  errors: string[], afterResolution: () => void | Promise<void> = () => {}) : NativeResolver {
  return async (ctx, options, configOverride) => {
    try {
      // dispatchInboundMessage has installed its native hooks before invoking us.
      // Append the Controller gate on the original public dispatcher, after them.
      assert.equal(typeof dispatcher.appendBeforeDeliver, 'function');
      dispatcher.appendBeforeDeliver!(delivery.beforeNativeDeliver);
      // Forward opaque native admission/lifecycle fields unchanged, including
      // fields not exported individually. No nested dispatch or reconstructed options.
      const result = await getReplyFromConfig(ctx, options, configOverride);
      abort.signal.throwIfAborted();
      const candidates = (Array.isArray(result) ? result : result ? [result] : [])
        .filter(payload => payload.isFallbackNotice !== true);
      assert.equal(candidates.length, 1, 'Exactly one terminal candidate is required');
      const payload = candidates[0]; assert(payload);
      const approved = delivery.prepare(payload);
      // Preserve the native session-writer guard; native admission is never
      // inferred from the replacement text or used as domain business authority.
      const native = copyReplyPayloadMetadata(payload, approved);
      await afterResolution(); abort.signal.throwIfAborted();
      return native;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      abort.abort(error); // Native may shadow this signal: the installed gate also rejects fallback.
      return undefined;
    }
  };
}

/** Cleanup observes settlement; it is not a pre-delivery terminal authorization barrier. */
async function provePublicSettlementBoundary() {
  const sink: (string | undefined)[] = [];
  const dispatcher = createReplyDispatcher({ deliver: async payload => { sink.push(payload.text); } });
  let lateQueued = false; let settledCalls = 0;
  const initialReceipt = await settleReplyDispatcher({ dispatcher, onSettled: () => {
    settledCalls++;
    lateQueued = dispatcher.sendFinalReply({ text: 'Post-settlement fixture payload.' });
  } });
  const lateReceipt = await dispatcher.waitForIdle();
  assert(initialReceipt); assert(lateReceipt); assert.equal(settledCalls, 1); assert(lateQueued);
  assert.deepEqual(sink, ['Post-settlement fixture payload.']);
  assert.equal(initialReceipt.counts.final.delivered, 0);
  assert.equal(lateReceipt.counts.final.delivered, 1);
  return { settledCalls, lateQueued, initialReceipt, lateReceipt,
    limits: 'A cleanup callback can enqueue after the captured receipt; it supplies no terminal cause, eligibility or durable reply obligation.' };
}

/** Public native pre-handoff semantics only; no fixture value is an authorization grant. */
async function proveLocalDeliveryBoundary() {
  const cases = [];
  for (const kind of ['tool', 'block', 'final'] as const) {
    for (const mode of ['allow', 'cancel', 'throw', 'timeout'] as const) {
      const sink: (string | undefined)[] = [], errors: string[] = [];
      let checks = 0;
      const dispatcher = createReplyDispatcher({
        beforeDeliver: payload => {
          checks++;
          if (mode === 'cancel') return null;
          if (mode === 'throw') throw new Error('Deliberate native boundary failure');
          if (mode === 'timeout') return new Promise<never>(() => {});
          return payload;
        },
        // Exercise the native deadline itself, not a guessed wait for an outcome.
        beforeDeliverOptions: { timeoutMs: 20 },
        deliver: async payload => { sink.push(payload.text); },
        onError: error => { errors.push(error instanceof Error ? error.message : String(error)); },
      });
      const payload = { text: `Local ${kind} ${mode} fixture.` };
      const enqueued = kind === 'tool' ? dispatcher.sendToolResult(payload)
        : kind === 'block' ? dispatcher.sendBlockReply(payload) : dispatcher.sendFinalReply(payload);
      assert(enqueued); // Admission is deliberately not interpreted as delivery success.
      await settleReplyDispatcher({ dispatcher });
      const receipt = await dispatcher.waitForIdle(); assert(receipt);
      const expected = { delivered: 0, deliveredNotVisible: 0, cancelled: 0, failedBeforeSend: 0, failedAfterSend: 0 };
      expected[mode === 'allow' ? 'delivered' : mode === 'cancel' ? 'cancelled' : 'failedBeforeSend'] = 1;
      assert.deepEqual(receipt.counts[kind], expected);
      for (const other of ['tool', 'block', 'final'] as const) {
        if (other !== kind) assert(Object.values(receipt.counts[other]).every(count => count === 0));
      }
      assert.equal(checks, 1); assert.equal(receipt.anyVisibleDelivered, mode === 'allow');
      assert.equal(receipt.hasPendingDelivery, undefined);
      assert.deepEqual(sink, mode === 'allow' ? [payload.text] : []);
      assert.equal(errors.length, mode === 'throw' || mode === 'timeout' ? 1 : 0);
      if (mode === 'timeout') assert.match(errors[0] ?? '', /beforeDeliver timed out after 20ms/);
      cases.push({ kind, mode, checks, sink, errors, receipt });
    }
  }
  // A local gate is not immutable final-payload custody: a later public stage can modify it.
  const checked: (string | undefined)[] = [], sink: (string | undefined)[] = [];
  const dispatcher = createReplyDispatcher({
    beforeDeliver: payload => { checked.push(payload.text); return payload; },
    deliver: async payload => { sink.push(payload.text); },
  });
  assert(dispatcher.appendBeforeDeliver);
  dispatcher.appendBeforeDeliver(payload => ({ ...payload, text: 'Changed after local check.' }));
  assert(dispatcher.sendFinalReply({ text: 'Checked fixture payload.' }));
  await settleReplyDispatcher({ dispatcher });
  const receipt = await dispatcher.waitForIdle(); assert(receipt);
  assert.deepEqual(checked, ['Checked fixture payload.']); assert.deepEqual(sink, ['Changed after local check.']);
  assert.equal(receipt.counts.final.delivered, 1);
  return { cases, laterTransformation: { checked, sink, receipt },
    limits: 'Local native receipts are not durable request outcomes, current Response authority or recovery enforcement.' };
}

/** Only a disposable plugin variant in the isolated fixture; never runtime registration. */
export default {
  id: 'benson-jessica-tool',
  register(api: OpenClawPluginApi) {
    isolated();
    if (process.env.BENSON_NATIVE_MAIN_HOOK_SURFACE_ONLY === '1') {
      let hookCalls = 0, resolverCalls = 0, runStarts = 0;
      const requestId = 'main-hook-surface', sessionKey = `agent:main:${requestId}`;
      api.on('reply_dispatch', (event, ctx) => {
        assert.equal(event.ctx.SessionKey, sessionKey);
        assert.equal(event.ctx.MessageSid, requestId);
        assert.equal(ctx.dispatchKind, 'agent');
        assert.equal(event.shouldRouteToOriginating, false);
        assert.equal(event.sendPolicy, 'allow');
        assert.equal(typeof ctx.dispatcher.sendFinalReply, 'function');
        // The optional public method exists on the original dispatcher, but the
        // installed host wrapper does not expose it at this integration point.
        assert.equal(ctx.dispatcher.appendBeforeDeliver, undefined);
        hookCalls++;
        return { handled: true, queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
      api.on('gateway_start', async () => {
        try {
          const sink: unknown[] = [];
          const dispatcher = createReplyDispatcher({ deliver: async payload => { sink.push(payload); } });
          assert.equal(typeof dispatcher.appendBeforeDeliver, 'function');
          await dispatchInboundMessage({ cfg: api.config, dispatcher,
            ctx: { Body: 'Inspect the native hook surface without generating a reply.', From: 'fixture-operator',
              To: 'fixture-sink', AgentId: 'main', SessionKey: sessionKey, MessageSid: requestId,
              Provider: 'fixture', Surface: 'fixture', ChatType: 'direct', SenderId: 'fixture-operator' },
            replyOptions: { onAgentRunStart() { runStarts++; } },
            replyResolver: async () => { resolverCalls++; throw new Error('Hook surface proof must not resolve a reply'); },
          });
          const receipt = await dispatcher.waitForIdle();
          assert.equal(hookCalls, 1); assert.equal(resolverCalls, 0); assert.equal(runStarts, 0);
          assert.deepEqual(sink, []); assert(receipt);
          for (const counts of Object.values(receipt.counts)) assert(Object.values(counts).every(count => count === 0));
          writeReport({ probe: 'PASS', G3: 'BLOCKED', mainHookSurfaceOnly: true,
            originalAppendBeforeDeliver: true, hookAppendBeforeDeliver: false, hookCalls, resolverCalls, runStarts,
            sinkCalls: sink.length, receipt,
            limits: 'Installed public hook surface only. No source authority, pinned route, final handoff, model Run or delivery is established.' });
        } catch (error) { writeReport({ probe: 'FAIL', error: error instanceof Error ? error.message : String(error) }); }
      });
      return;
    }
    let supportedHookBehavior: 'error' | 'timeout' | 'mutation' | 'rich' | null = null;
    api.on('reply_payload_sending', event => {
      if (supportedHookBehavior === 'error') throw Error('Deliberate supported-path hook error');
      if (supportedHookBehavior === 'timeout') return new Promise<never>(() => {});
      if (supportedHookBehavior === 'mutation') return { payload: { text: 'Unapproved hook mutation' } };
      if (supportedHookBehavior === 'rich') return { payload: { ...event.payload,
        location: { latitude: 1, longitude: 2, name: 'Unapproved hook location' },
        channelData: { fixture: { text: 'Unapproved rich content' } } } };
      return;
    }, { timeoutMs: 20 });
    let active: Probe | undefined;
    const outboundProbes: OutboundProbe[] = [];
    const terminalProbes: TerminalProbe[] = [];
    const terminalFor = (sessionKey: string | undefined) => terminalProbes.find(probe =>
      sessionKey === `agent:main:g3-terminal-${probe.name}`);
    api.registerTool({ contextVersion: 2, create(ctx) {
      return { name: 'jessica_read', label: 'Isolated harmless failure', description: 'Fail the disposable read without external effects.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute(_callId, params) {
          ctx.assertInvocationCurrent(); assert.deepEqual(params, {});
          const probe = terminalFor(ctx.sessionKey); assert(probe);
          assert.equal(probe.name, 'handled-tool-failure'); probe.toolFailures++;
          throw new Error('Isolated harmless read failure');
        } };
    } });
    const readValues: ReturnType<typeof validateDomainResult>[] = [];
    const readCalls: { runId: string; callId: string; sessionKey: string }[] = [];
    const codeModeCalls: { runId: string; callId: string; sessionKey: string }[] = [];
    // Observational custody for this isolated fixture only, never a host authority registry.
    const readIngress = new Map<string, { request: string; entryId: string; channel: string; accountId: string; peerId: string; requesterId: string }>();
    api.on('reply_dispatch', event => {
      const inbound = event.ctx, key = inbound.SessionKey;
      if (!key?.startsWith('agent:main:read-admission-')) return;
      assert.equal(inbound.ChatType, 'direct');
      assert(typeof inbound.Body === 'string' && typeof inbound.MessageSid === 'string');
      assert(typeof inbound.Provider === 'string' && typeof inbound.AccountId === 'string');
      assert(typeof inbound.To === 'string' && typeof inbound.SenderId === 'string');
      assert(!readIngress.has(key));
      readIngress.set(key, { request: inbound.Body, entryId: inbound.MessageSid, channel: inbound.Provider,
        accountId: inbound.AccountId, peerId: inbound.To, requesterId: inbound.SenderId });
    });
    const retainedReadTools: { sessionKey: string; name: string; assertCurrent(): void; replay(): unknown; projectionCurrent(): string }[] = [];
    function observeReadLifetime(create: OpenClawPluginToolFactory<2>['create']): OpenClawPluginToolFactory<2>['create'] {
      return context => {
        const tool = create(context);
        if (!tool || Array.isArray(tool)) return tool;
        return { ...tool, async execute(...args: Parameters<typeof tool.execute>) {
          assert(context.sessionKey);
          const inbound = readIngress.get(context.sessionKey); assert(inbound);
          assert.equal(context.deliveryContext?.channel, inbound.channel);
          assert.equal(context.deliveryContext?.accountId, inbound.accountId);
          assert.equal(context.deliveryContext?.to, inbound.peerId);
          assert.equal(context.requesterSenderId, inbound.requesterId);
          const current: ConversationTurn = { entryId: inbound.entryId, role: 'user', text: inbound.request,
            sender: { source: 'canonical_peer_binding', id: inbound.requesterId, channel: inbound.channel, accountId: inbound.accountId },
            inputProvenance: { kind: 'external_user' } };
          const controller = createCurrentRequestContext({ request: inbound.request,
            binding: { conversationRef: `${inbound.channel}:${inbound.accountId}:${inbound.peerId}`, channel: inbound.channel,
              accountId: inbound.accountId, kind: 'direct', peerId: inbound.peerId, threadId: null, requesterId: inbound.requesterId },
            currentTurn: () => current, assertCurrent: () => context.assertInvocationCurrent(),
            assertAuthorized(entry) {
              context.assertInvocationCurrent(); assert.equal(readIngress.get(context.sessionKey!), inbound);
              assert.equal(JSON.stringify(entry), JSON.stringify(current));
            } });
          const projection = controller.projectCurrentRequest(); assert(projection.status === 'available');
          assert.equal(projection.scope, 'current-request-only');
          assert.deepEqual(projection.context.history, { status: 'not_acquired' });
          // Retain the exact source closure and native guard used by this call.
          // This instrumentation supplies no authority and never touches a backend.
          retainedReadTools.push({ sessionKey: context.sessionKey, name: tool.name,
            assertCurrent: () => context.assertInvocationCurrent(), replay: () => tool.execute(...args),
            projectionCurrent: () => controller.revalidateProjection(projection).status });
          const result = await tool.execute(...args);
          assert.equal(controller.revalidateProjection(projection), projection);
          return result;
        } };
      };
    }
    api.on('before_tool_call', (event, ctx) => {
      if (event.toolName === 'exec') {
        assert.equal(event.toolKind, 'code_mode_exec');
        assert.equal(event.toolInputKind, 'javascript');
        assert(ctx.runId && ctx.toolCallId && ctx.sessionKey);
        codeModeCalls.push({ runId: ctx.runId, callId: ctx.toolCallId, sessionKey: ctx.sessionKey });
      }
      if (!['jessica_task', 'reminder_task'].includes(event.toolName)) return;
      assert(ctx.runId && ctx.toolCallId && ctx.sessionKey);
      assert.equal(event.runId, ctx.runId); assert.equal(event.toolCallId, ctx.toolCallId);
      readCalls.push({ runId: ctx.runId, callId: ctx.toolCallId, sessionKey: ctx.sessionKey });
    });
    let statusReads = 0, listReads = 0;
    // Select disposable backend outcomes only; this is never an authority input.
    let readProfile: 'success' | 'jessica-failure' | 'reminder-failure' | 'qualified' = 'success';
    const readJson = (value: ReturnType<typeof validateDomainResult>) => {
      readValues.push(value); return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value };
    };
    api.registerTool({ contextVersion: 2, create: observeReadLifetime(createJessicaTaskToolFactory({
      roster: { accountId: 'fixture-account', approvedIds: ['reader'], subjectForRoute: route => route === 'fixture-private' ? 'reader' : null },
      policy: loadPolicy({ version: '1', defaultDecision: 'deny', rules: ['read', 'control'].map(actionClass => ({
        subject: 'reader', actionClass, deviceScope: 'jessica-vacuum', decision: 'allow' })) }),
      async read(_request, _identity, authority) { authority.assertCurrent(); statusReads++;
        const at = new Date().toISOString();
        if (readProfile === 'jessica-failure') return validateResult({ schemaVersion: '1', status: 'failure',
          domain: 'jessica-vacuum', operation: 'status', verified: false, data: null, warnings: [], pendingContext: null,
          error: { code: 'READ_UNAVAILABLE', stage: 'verification', retryable: true, retryMode: 'read_only',
            sideEffects: 'none', message: 'Jessica read is unavailable' } }, null, new Date(at));
        return validateResult({ schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: 'status', verified: true,
          data: { kind: 'status', observedAt: at, sourceUpdatedAt: at, freshness: 'fresh', state: 'docked',
            batteryLevel: 90, activeSegments: [], currentSegment: null }, warnings: readProfile === 'qualified'
              ? [{ code: 'REQUIRES_DOMAIN_PRESENTATION', message: 'Fixture qualification must not disappear.' }] : [],
          error: null, pendingContext: null }, null, new Date(at));
      }, jsonResult: readJson,
    })) });
    api.registerTool({ contextVersion: 2, create: observeReadLifetime(createReminderTaskToolFactory({
      identities: loadIdentityContract({ accountId: 'fixture-account', trustedRequesterIds: ['reader'],
        recipients: [{ id: 'reader', type: 'person', channel: 'whatsapp', to: 'fixture-private' }] }),
      transaction: { async execute(request, authority) { authority.assertCurrent(); assert.equal(request.operation, 'list-reminders');
        assert.equal(request.requesterId, 'reader'); listReads++;
        if (readProfile === 'reminder-failure') throw new Error('Fixture private transaction diagnostic');
        return { operation: 'list', status: 'success', verified: true, warnings: [], matchCount: 3,
          matches: [1, 2, 3].map(i => ({ schemaVersion: 4, reminderId: `fixture-read-${i}`, status: 'active', content: `Fixture reminder ${i}`,
            schedules: [{ type: 'one-shot', resolvedTime: '2026-10-28T10:00:00+02:00', timezone: 'Asia/Jerusalem' }] })) };
      } }, jsonResult: readJson,
    })) });
    api.on('agent_end', (event, ctx) => {
      const probe = terminalFor(ctx.sessionKey);
      if (probe) probe.agentEnds.push({ runId: event.runId ?? ctx.runId ?? null,
        runIdSource: event.runId ? 'event' : ctx.runId ? 'context' : 'missing', success: event.success, error: event.error ?? null });
    });
    const outboundFor = (sessionKey: string | undefined) => outboundProbes.find(probe =>
      sessionKey === `agent:main:g3-outbound-${probe.name}`);
    api.on('before_dispatch', event => event.sessionKey === 'agent:main:g3-before-dispatch' || event.sessionKey === 'agent:main:g3-outbound-early-reply'
      ? { handled: true, text: 'Early fixture reply.' } : undefined);
    api.on('reply_payload_sending', (event, ctx) => {
      const terminal = terminalFor(event.sessionKey);
      if (terminal) {
        terminal.outbound.push({ kind: event.kind, runId: event.runId ?? null,
          text: event.payload.text ?? null, isError: event.payload.isError === true });
        if ((terminal.name === 'bounded-hook-error' || terminal.name === 'bounded-hook-rejected')) throw new Error('Deliberate bounded hook failure');
        if (terminal.name === 'bounded-hook-timeout') return new Promise<never>(() => {});
        // Observation only: authorization is in the host-owned deliver callback,
        // after the native beforeDeliver chain, independently of global hook policy.
        return;

      }
      const probe = outboundFor(event.sessionKey);
      if (!probe) return;
      probe.hookEvents.push({ kind: event.kind, runId: event.runId ?? null,
        sessionKey: event.sessionKey ?? null, messageId: ctx.messageId ?? null, text: event.payload.text ?? null });
      // Deliberately escape the adapter to characterize the SDK hook failure policy.
      if (probe.name === 'sending-hook-error') throw new Error('Deliberate fixture sending-hook failure');
      if (probe.name === 'sending-hook-timeout') return new Promise<never>(() => {});
      try {
        // The existing v2 Main response requires an actual native Run. Do not mint
        // a Run or a no-Run authority for early/fallback/progress fixture payloads.
        assert.equal(probe.runIds.length, 1, 'Native Main response custody unavailable');
        assert.equal(event.runId, probe.runIds[0]);
        assert.equal(event.sessionKey, `agent:main:g3-outbound-${probe.name}`);
        assert.equal(ctx.messageId, `g3-outbound-${probe.name}`);
        assert.equal(event.kind, 'final');
        assert.equal(event.payload.text, 'Native Main fixture reply.');
        const runId = probe.runIds[0]; assert(runId);
        const response = responseFor(event.payload.text, ctx.messageId, runId);
        probe.gateChecks++;
        const controlled = controlResponse(probe.name === 'invalid-response'
          ? { ...response, schemaVersion: 999 } : response, renderOptions());
        assert(controlled.rendered);
        return { payload: { ...event.payload, text: controlled.rendered.message } };
      } catch (error) {
        probe.rejected.push(error instanceof Error ? error.message : 'Response rejected');
        return { cancel: true, reason: 'isolated_response_rejected' };
      }
    }, { timeoutMs: 20 });
    api.on('reply_dispatch', async (event, ctx) => {
      const outbound = outboundFor(event.sessionKey ?? event.ctx.SessionKey);
      if (outbound) {
        outbound.takeoverCalls++;
        if (outbound.name === 'takeover-fallback') throw new Error('Deliberate fixture takeover failure');
        return;
      }
      const probe = active;
      if (!probe || event.ctx.SessionKey !== `agent:main:g3-${probe.name}`) return;
      probe.hookCalls++;
      if (probe.name === 'hook-error') throw new Error('Deliberate fixture takeover failure');
      assert.equal(ctx.dispatchKind, 'agent');
      assert.equal(event.ctx.AgentId, 'main');
      assert.equal(event.shouldRouteToOriginating, false);
      assert.equal(event.sendPolicy, 'allow');
      assert.equal(event.suppressUserDelivery, false);
      let queuedFinal = false;
      try {
        ctx.abortSignal?.throwIfAborted();
        // Forward the actual host handles without widening SDK declarations or casting.
        // The public hook exposes the transcript preparer even though GetReplyOptions
        // lists only the remaining subset; structural options retain that handle.
        const options = {
          ...(event.runId ? { runId: event.runId } : {}),
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
          ...(ctx.onReplyStart ? { onReplyStart: ctx.onReplyStart } : {}),
          ...(ctx.onAgentRunStart ? { onAgentRunStart: ctx.onAgentRunStart } : {}),
          ...(ctx.userTurnTranscriptRecorder ? { userTurnTranscriptRecorder: ctx.userTurnTranscriptRecorder } : {}),
          ...(ctx.prepareAssistantTranscriptMessage ? { prepareAssistantTranscriptMessage: ctx.prepareAssistantTranscriptMessage } : {}),
          disableTools: true, disableBlockStreaming: true,
        };
        const reply = await getReplyFromConfig(event.ctx, options, ctx.cfg);
        ctx.abortSignal?.throwIfAborted();
        const payloads = reply === undefined ? [] : Array.isArray(reply) ? reply : [reply];
        assert.equal(payloads.length, 1, 'This bounded proof expects one text-only Main reply');
        const payload = payloads[0]; assert(payload);
        assert.equal(payload.text, 'Native Main fixture reply.');
        assert.equal(probe.nativeRunIds.length, 1);
        assert.equal(probe.nativeRunIds[0], event.runId);
        // Fixture/system-origin Main response, with no domain execution or Completion.
        assert(event.ctx.MessageSid); assert(probe.nativeRunIds[0]);
        const response = responseFor(payload.text, event.ctx.MessageSid, probe.nativeRunIds[0]);
        probe.gateChecks++;
        const controlled = controlResponse(response, renderOptions());
        assert(controlled.rendered);
        const outbound: ReplyPayload = { text: controlled.rendered.message };
        ctx.abortSignal?.throwIfAborted();
        queuedFinal = ctx.dispatcher.sendFinalReply(outbound);
        ctx.recordProcessed('completed', { reason: 'isolated_response_controlled' });
        ctx.markIdle('isolated_response_complete');
      } catch (error) {
        // Local fail-closed handling is part of this fixture, not a production repair.
        probe.rejected = true;
        probe.rejection = error instanceof Error ? error.message : 'rejected';
        ctx.recordProcessed('error', { reason: 'isolated_response_rejected', error: error instanceof Error ? error.message : 'rejected' });
        ctx.markIdle('isolated_response_rejected');
      }
      return { handled: true, queuedFinal, counts: ctx.dispatcher.getQueuedCounts() };
    });
    async function proveReadAdmissions(codeModeOnly: boolean, nativeResolver = false) {
      const readAdmissionCases = [];
      for (const [domain, marker, domains, denied, profile] of [
        ['jessica-vacuum', 'G3_MAIN_READ_JESSICA', ['jessica-vacuum'], false, 'success'],
        ['reminder', 'G3_MAIN_READ_REMINDER', ['reminder'], false, 'success'],
        ['multi', 'G3_MAIN_READ_MULTI', ['jessica-vacuum', 'reminder'], false, 'success'],
        ['blocked', 'G3_MAIN_READ_BLOCKED', ['jessica-vacuum'], true, 'success'],
        ['jessica-failure', 'G3_MAIN_READ_JESSICA_FAILURE_MULTI', ['jessica-vacuum', 'reminder'], false, 'jessica-failure'],
        ['reminder-failure', 'G3_MAIN_READ_REMINDER_FAILURE_MULTI', ['jessica-vacuum', 'reminder'], false, 'reminder-failure'],
        ['qualified', 'G3_MAIN_READ_QUALIFIED_MULTI', ['jessica-vacuum', 'reminder'], false, 'qualified'],
        ['code-multi', 'G3_MAIN_READ_CODE_MULTI', ['jessica-vacuum', 'reminder'], false, 'success'],
        ['code-denied', 'G3_MAIN_READ_CODE_DENIED', ['jessica-vacuum', 'reminder'], true, 'success'],
        ['code-jessica-failure', 'G3_MAIN_READ_CODE_JESSICA_FAILURE_MULTI', ['jessica-vacuum', 'reminder'], false, 'jessica-failure'],
        ['code-reminder-failure', 'G3_MAIN_READ_CODE_REMINDER_FAILURE_MULTI', ['jessica-vacuum', 'reminder'], false, 'reminder-failure'],
        ['code-qualified', 'G3_MAIN_READ_CODE_QUALIFIED_MULTI', ['jessica-vacuum', 'reminder'], false, 'qualified'],
      ] as const) {
        const codeMode = domain.startsWith('code-');
        if (codeMode !== codeModeOnly) continue;
        readProfile = profile;
        const firstResult = readValues.length;
        const firstInvocation = retainedReadTools.length;
        const runIds: string[] = [], outcomes: string[] = [], errors: string[] = [], sink: unknown[] = [];
        const requestId = `read-admission-${domain}`, sessionKey = `agent:main:${requestId}`;
        const abort = new AbortController();
        const delivery = createMainResponseDelivery({ requestId, agentId: 'main', runId() { assert.equal(runIds.length, 1); return runIds[0]!; },
          assertCurrent() { abort.signal.throwIfAborted(); assert.equal(outcomes.at(-1), 'completed'); },
          responseFor: () => createResponseV3Envelope({ messageCandidate: null }, {
            requestId, source: { type: 'main', agentId: 'main', runId: runIds[0] }, results: readValues.slice(firstResult),
            responsePolicy: { preferredMode: 'deterministic', allowedModes: ['deterministic'] },
            lifecycle: { domainExecution: 'attempted', failure: null },
          }), presentation: { language: 'he', get now() { return new Date().toISOString(); }, timezone: 'Asia/Jerusalem',
            assertResponseCurrent(response) {
              assert(!denied, 'Fixture authority denied'); assert.equal(response.requestId, requestId);
              assert.equal(response.source.type, 'main'); assert.equal(runIds.length, 1);
              const calls = readCalls.filter(call => call.runId === runIds[0]);
              const values = readValues.slice(firstResult);
              assert.equal(calls.length, domains.length); assert.equal(new Set(calls.map(call => call.callId)).size, calls.length);
              assert.deepEqual(values.map(value => value.domain), domains); assert.deepEqual(response.results, values);
              calls.forEach((call, index) => { assert.equal(call.sessionKey, sessionKey);
                assert.equal(values[index]?.evidence.observations[0]?.ref, call.callId); });
            }, renderDomainResult: (result, options) => result.domain === 'jessica-vacuum'
              ? renderJessicaDomainResult(result, options) : renderReminderDomainResult(result, options),
          }, ...nativeResolver ? { mode: 'native-resolver' as const } : { deliver: async (payload: Readonly<{ text: string }>) => { sink.push(payload); } } });
        const dispatcher = createReplyDispatcher({ deliver: nativeResolver ? async payload => { sink.push({ text: payload.text }); } : (payload, info) => delivery.deliver(payload, info),
          onError: error => { errors.push(String(error)); } });
        try {
          await dispatchInboundMessage({ cfg: api.config, dispatcher,
            ...nativeResolver ? { replyResolver: controlledNativeResolver(delivery, dispatcher, abort, errors) } : {},
            ctx: { Body: marker, From: 'fixture-private', To: 'fixture-private', SenderId: 'fixture-private',
              AccountId: 'fixture-account', AgentId: 'main', SessionKey: sessionKey,
              Provider: 'whatsapp', Surface: 'whatsapp', ChatType: 'direct', MessageSid: requestId, CommandAuthorized: true },
            replyOptions: { disableTools: false, disableBlockStreaming: true,
              ...nativeResolver ? { ...terminalTextProfile, abortSignal: abort.signal } : {},
              onAgentRunStart: runId => { runIds.push(runId); }, onAgentRunTerminalOutcome: outcome => { outcomes.push(outcome); } },
          });
        } finally { await settleReplyDispatcher({ dispatcher }); }
        const receipt = await dispatcher.waitForIdle(); assert(receipt);
        assert.equal(receipt.counts.final.delivered, denied || profile === 'qualified' ? 0 : 1);
        assert.equal(receipt.counts.tool.delivered + receipt.counts.block.delivered, 0);
        const values = readValues.slice(firstResult);
        assert.equal(runIds.length, 1); assert.deepEqual(outcomes, ['completed']);
        assert.equal(values.length, domains.length);
        const execCalls = codeModeCalls.filter(call => call.runId === runIds[0]);
        assert.equal(execCalls.length, codeMode ? 1 : 0);
        if (codeMode) {
          assert.equal(execCalls[0]?.sessionKey, sessionKey);
          const nested = readCalls.filter(call => call.runId === runIds[0]);
          assert.equal(nested.length, 2); assert(nested.every(call => call.callId !== execCalls[0]?.callId));
        }
        const texts = values.map(value => { validateDomainResult(value);
          const failed = profile === 'jessica-failure' && value.domain === 'jessica-vacuum' ||
            profile === 'reminder-failure' && value.domain === 'reminder';
          assert.equal(value.executionMode, 'deterministic'); assert.equal(value.effects.status, 'none');
          assert.equal(value.facts.verified, !failed); assert.equal(value.outcome.status, failed ? 'failure' : 'success');
          assert.equal(value.outcome.disposition, failed ? 'failed' : 'handled');
          assert.equal(value.warnings.length, profile === 'qualified' && value.domain === 'jessica-vacuum' ? 1 : 0);
          assert(value.content?.state === 'usable'); return value.content.text; });
        assert(!JSON.stringify({ values, sink }).includes('Fixture private transaction diagnostic'));
        if (profile === 'jessica-failure') assert(texts[0]?.includes('לא ניתן לאמת כעת את מצב Jessica'));
        if (profile === 'reminder-failure') assert(texts[1]?.includes('לא ניתן לאמת כעת את רשימת התזכורות'));
        if (denied || profile === 'qualified') { assert.deepEqual(sink, []); assert(errors.length >= 1); assert.equal(delivery.snapshot().outcome, 'blocked'); }
        else { assert.deepEqual(errors, []); assert.equal(delivery.snapshot().outcome, nativeResolver ? 'prepared' : 'delivered');
          assert.deepEqual(sink, [{ text: texts.length === 1 ? texts[0] : texts.map((text, index) => `${index + 1}. ${text}`).join('\n\n') }]); }
        const retired = retainedReadTools.slice(firstInvocation);
        assert.deepEqual(retired.map(tool => tool.name), domains.map(name => name === 'reminder' ? 'reminder_task' : 'jessica_task'));
        const beforeReplay = { statusReads, listReads, serialized: readValues.length };
        for (const tool of retired) {
          assert.equal(tool.sessionKey, sessionKey);
          assert.throws(() => tool.assertCurrent(), 'Native invocation guard must reject after completed dispatch');
          assert.equal(tool.projectionCurrent(), 'unavailable', 'Retained current projection cannot outlive native invocation authority');
          await assert.rejects(async () => { await tool.replay(); }, 'Retained source tool must reject before another read');
        }
        assert.deepEqual({ statusReads, listReads, serialized: readValues.length }, beforeReplay,
          'Retired calls must cause no backend read or serialized result');
        const retiredInvocations = retired.map(tool => ({ tool: tool.name, guardRejected: true, replayRejected: true }));
        readAdmissionCases.push({ domain, marker, codeMode, profile, runIds, outcomes, values, sink, delivery: delivery.snapshot(), receipt, nativeResolver, execCalls, retiredInvocations,
          currentRequestContext: { count: retired.length, scope: 'current-request-only', history: 'not_acquired',
            revalidatedBeforeReturn: true, retiredProjectionRejected: true },
          nativeBindings: readCalls.filter(call => call.runId === runIds[0]),
          limits: 'Source v3 with native tool/Run mapping, complete carrier comparison and retired native read-tool refusal. Retired tool authority cannot authorize a later Main reply. Code Mode uses native exec/catalog/JSON bridge; direct cases remain direct. Route, roster, backends and response authorization are disposable fixture inputs, not production authority or Domain Completion custody.' });
      }
      assert.equal(statusReads, codeModeOnly ? 5 : 6); assert.equal(listReads, 5);
      return readAdmissionCases;
    }
    api.on('gateway_start', async () => {
      const probes: Probe[] = [];
      try {
        if (process.env.BENSON_NATIVE_SUPPORTED_RESPONSE_ONLY === '1') {
          const readAdmissionCases = await proveReadAdmissions(false, true);
          const supportedTerminalCases = [];
          for (const [name, marker] of [
            ['success', 'G3_SUPPORTED_SUCCESS'], ['tool-failure', 'G3_HANDLED_TOOL_FAILURE'],
            ['provider-error', 'G3_TERMINAL_PROVIDER_ERROR'], ['timeout', 'G3_TERMINAL_NATIVE_TIMEOUT'],
            ['fallback', 'G3_TERMINAL_NATIVE_FALLBACK'], ['denied', 'G3_SUPPORTED_DENIED'],
            ['malformed', 'G3_SUPPORTED_MALFORMED'], ['cancelled', 'G3_SUPPORTED_CANCELLED'],
            ['hook-error', 'G3_SUPPORTED_HOOK_ERROR'], ['hook-timeout', 'G3_SUPPORTED_HOOK_TIMEOUT'],
            ['hook-mutation', 'G3_SUPPORTED_HOOK_MUTATION'], ['hook-rich', 'G3_SUPPORTED_HOOK_RICH'],
            ['writer-replaced', 'G3_SUPPORTED_WRITER_REPLACED'],
          ] as const) {
            const abort = new AbortController(), runIds: string[] = [], outcomes: string[] = [], errors: string[] = [], sink: unknown[] = [];
            const requestId = 'supported-' + name;
            supportedHookBehavior = name === 'hook-error' ? 'error' : name === 'hook-timeout' ? 'timeout' : name === 'hook-mutation' ? 'mutation' : name === 'hook-rich' ? 'rich' : null;
            const replacementSink: unknown[] = [];
            let replacementDone = Promise.resolve();
            const probe: TerminalProbe = { name: 'handled-tool-failure', toolFailures: 0, runIds, terminalOutcomes: outcomes,
              agentEnds: [], partials: 0, abortIssued: false, outbound: [], sink: [], dispatchError: null,
              settledCalls: 0, responseChecks: 0, responseErrors: [] };
            // The harmless failing tool already belongs to this existing fixture.
            if (name === 'tool-failure') terminalProbes.push(probe);
            const delivery = createMainResponseDelivery({ mode: 'native-resolver', requestId, agentId: 'main',
              runId: () => { assert.equal(runIds.length, 1); return runIds[0]!; },
              assertCurrent() { abort.signal.throwIfAborted(); assert.notEqual(name, 'denied'); },
              responseFor(payload) {
                if (name === 'malformed') return { schemaVersion: 999 };
                assert(payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string');
                assert.equal(runIds.length, 1); const runId = runIds[0]!;
                if (outcomes.includes('failed') || name === 'tool-failure' || ('isError' in payload && payload.isError)) {
                  return createResponseEnvelope({ messageCandidate: null }, {
                    requestId, source: { type: 'main', agentId: 'main', runId }, status: 'failure', results: [], pendingContext: null,
                    provenance: { executionVerified: false, completionCorrelated: false },
                    lifecycle: { domainExecution: 'uncertain', failure: { code: 'RUN_OUTCOME_UNRESOLVED' } },
                    responsePolicy: { preferredMode: 'safe_failure', allowedModes: ['safe_failure'] },
                  });
                }
                assert.deepEqual(outcomes, ['completed']);
                return responseFor(payload.text, requestId, runId);
              }, presentation: renderOptions() });
            const dispatcher = createReplyDispatcher({ deliver: async (payload, info) => {
              sink.push({ kind: info.kind, text: payload.text });
            }, onError: error => { errors.push(String(error)); } });
            // Use the original session for the existing harmless failing-tool owner.
            const sessionKey = name === 'tool-failure' ? 'agent:main:g3-terminal-handled-tool-failure' : 'agent:main:' + requestId;
            await dispatchInboundMessage({ cfg: api.config, dispatcher,
              ctx: { Body: marker, From: 'fixture-operator', To: 'fixture-sink', AgentId: 'main', SessionKey: sessionKey,
                Provider: 'webchat', Surface: 'webchat', ChatType: 'direct', SenderId: 'fixture-operator', MessageSid: requestId,
                CommandAuthorized: true },
              replyOptions: { ...terminalTextProfile, disableTools: name !== 'tool-failure', abortSignal: abort.signal,
                timeoutOverrideMs: name === 'timeout' ? 1000 : 5000,
                onAgentRunStart: id => { runIds.push(id); }, onAgentRunTerminalOutcome: outcome => { outcomes.push(outcome); } },
              replyResolver: controlledNativeResolver(delivery, dispatcher, abort, errors, async () => {
                if (name === 'cancelled') abort.abort(new Error('Isolated cancellation after native resolution'));
                if (name === 'writer-replaced') {
                  replacementDone = (async () => {
                  const replacement = createReplyDispatcher({ deliver: async payload => { replacementSink.push(payload.text); } });
                  await dispatchInboundMessage({ cfg: api.config, dispatcher: replacement,
                    ctx: { Body: '/new', CommandBody: '/new', From: 'fixture-operator', To: 'fixture-sink', AgentId: 'main',
                      SessionKey: sessionKey, Provider: 'webchat', Surface: 'webchat', ChatType: 'direct', SenderId: 'fixture-operator',
                      MessageSid: requestId + '-new', CommandAuthorized: true },
                    replyOptions: { ...terminalTextProfile, disableTools: true } });
                  })();
                  await replacementDone;
                }
              }) });
            await replacementDone;
            const receipt = await dispatcher.waitForIdle(); assert(receipt); assert.equal(runIds.length, 1);
            const rejected = name === 'denied' || name === 'malformed' || name === 'cancelled';
            const blocked = rejected || name === 'hook-mutation' || name === 'hook-rich' || name === 'writer-replaced';
            assert.equal(sink.length, blocked ? 0 : 1, name + ': no uncontrolled native output');
            assert.equal(receipt.counts.final.delivered, blocked ? 0 : 1);
            assert.equal(receipt.counts.tool.delivered + receipt.counts.block.delivered, 0);
            if (rejected) { assert(abort.signal.aborted); assert(errors.length > 0); }
            else if (blocked) { assert.deepEqual(errors, []);
              if (name === 'hook-mutation' || name === 'hook-rich') assert.equal(delivery.snapshot().outcome, 'blocked');
              else { assert.equal(delivery.snapshot().outcome, 'prepared'); assert(replacementSink.length > 0); }
            }
            else { assert.deepEqual(errors, []); assert.equal(delivery.snapshot().outcome, 'prepared');
              const item = sink[0]; assert(item && typeof item === 'object' && 'text' in item);
              if (name === 'tool-failure' || name === 'provider-error' || name === 'timeout') assert.match(String(item.text), /may have had effects/);
              else assert.equal(item.text, 'Native Main fixture reply.');
              assert.throws(() => delivery.prepare({}), /already_settled/);
            }
            supportedTerminalCases.push({ name, runIds, outcomes, errors, sink, replacementSink, receipt, preparation: delivery.snapshot(), aborted: abort.signal.aborted });
          }
          writeReport({ probe: 'PASS', G3: 'BLOCKED', supportedNativeOnly: true, readAdmissionCases, supportedTerminalCases,
            limits: 'Actual native resolver admission and terminal text delivery only; fixture-owned ingress/route/backend custody, no production channel, universal late enforcement or recovery proof.' });
          return;
        }
        if (process.env.BENSON_NATIVE_CODE_MODE_ONLY === '1') {
          const readAdmissionCases = await proveReadAdmissions(true);
          writeReport({ probe: 'PASS', G3: 'BLOCKED', codeModeOnly: true, readAdmissionCases,
            limits: 'Isolated native Node Code Mode with full bounded values only; no production authority, Domain Completion or universal carrier guarantee.' });
          return;
        }
        const localDeliveryBoundary = await proveLocalDeliveryBoundary();
        // Isolate native generation/provider availability from takeover ownership.
        // This standalone baseline has no outer dispatch operation to adopt.
        const baselineRunIds: string[] = [], baselineSink: (string | undefined)[] = [];
        const baselineReply = await getReplyFromConfig({ Body: 'Return a short fixture reply.', From: 'fixture-operator', To: 'fixture-sink',
          AgentId: 'main', SessionKey: 'agent:main:g3-baseline', Provider: 'webchat', Surface: 'webchat',
          ChatType: 'direct', SenderId: 'fixture-operator', MessageSid: 'g3-baseline', CommandAuthorized: true }, {
          disableTools: true, disableBlockStreaming: true, onAgentRunStart: runId => { baselineRunIds.push(runId); },
        }, api.config);
        const baselinePayloads = baselineReply === undefined ? [] : Array.isArray(baselineReply) ? baselineReply : [baselineReply];
        assert.equal(baselineRunIds.length, 1); assert.equal(baselinePayloads.length, 1);
        const baselinePayload = baselinePayloads[0], baselineRunId = baselineRunIds[0];
        assert(baselinePayload && baselineRunId); assert.equal(baselinePayload.text, 'Native Main fixture reply.');
        const baselineResponse = responseFor(baselinePayload.text, 'g3-baseline', baselineRunId);
        assert.throws(() => controlResponse({ ...baselineResponse, schemaVersion: 999 }, renderOptions()));
        const controlled = controlResponse(baselineResponse, renderOptions()); assert(controlled.rendered);
        const baselineDispatcher = createReplyDispatcher({ deliver: async payload => { baselineSink.push(payload.text); } });
        assert(baselineDispatcher.sendFinalReply({ text: controlled.rendered.message }));
        await settleReplyDispatcher({ dispatcher: baselineDispatcher });
        assert.deepEqual(baselineSink, ['Native Main fixture reply.']);
        const baseline = { nativeRunId: baselineRunId, responses: baselineSink, invalidVersionRejected: true,
          limit: 'Standalone native generation/controller/dispatcher, outside reply_dispatch takeover.' };
        for (const name of ['takeover', 'hook-error', 'before-dispatch', 'pre-aborted'] as const) {
          const probe: Probe = { name, hookCalls: 0, defaultCalls: 0, runStarts: 0, replyStarts: 0,
            gateChecks: 0, rejected: false, rejection: null, nativeRunIds: [], sink: [], atReturn: null };
          active = probe;
          const abort = new AbortController(); if (name === 'pre-aborted') abort.abort();
          const dispatcher = createReplyDispatcher({ deliver: async payload => {
            probe.sink.push({ text: payload.text });
          } });
          try {
            await dispatchInboundMessage({ cfg: api.config, dispatcher,
              ctx: { Body: 'Return a short fixture reply.', From: 'fixture-operator', To: 'fixture-sink',
                AgentId: 'main', SessionKey: `agent:main:g3-${name}`, Provider: 'webchat', Surface: 'webchat',
                ChatType: 'direct', SenderId: 'fixture-operator', MessageSid: `g3-${name}`, CommandAuthorized: true },
              replyOptions: { runId: randomUUID(), abortSignal: abort.signal,
                onReplyStart: () => { probe.replyStarts++; },
                onAgentRunStart: runId => { probe.runStarts++; probe.nativeRunIds.push(runId); } },
              // Only the negative fallback probe may use this synthetic resolver.
              replyResolver: async () => { probe.defaultCalls++; return { text: 'Uncontrolled fallback fixture reply.' }; },
            });
          } finally { await settleReplyDispatcher({ dispatcher }); }
          probe.atReturn = { runStarts: probe.runStarts, sinkCount: probe.sink.length };
          probes.push(probe);
        }
        const [takeover, failed, early, aborted] = probes;
        assert(takeover && failed && early && aborted);
        assert.equal(takeover.hookCalls, 1); assert.equal(takeover.defaultCalls, 0);
        assert.equal(takeover.gateChecks, 0); assert.equal(takeover.rejected, true); assert.equal(takeover.sink.length, 0);
        assert.match(takeover.rejection ?? '', /expects one text-only Main reply/);
        assert.equal(failed.hookCalls, 1); assert.equal(failed.defaultCalls, 1);
        assert.deepEqual(failed.sink.map(item => item.text), ['Uncontrolled fallback fixture reply.']);
        assert.equal(failed.gateChecks, 0);
        assert.equal(early.hookCalls, 0); assert.equal(early.defaultCalls, 0); assert.equal(early.gateChecks, 0);
        assert.deepEqual(early.sink.map(item => item.text), ['Early fixture reply.']);
        assert.equal(aborted.sink.length, 0); assert.equal(aborted.defaultCalls, 0); assert.equal(aborted.runStarts, 0);
        active = undefined;
        for (const name of ['native-main', 'invalid-response', 'sending-hook-error', 'early-reply', 'takeover-fallback', 'resolver-block', 'sending-hook-timeout'] as const) {
          const probe: OutboundProbe = { name, runIds: [], defaultCalls: 0, takeoverCalls: 0,
            gateChecks: 0, hookEvents: [], rejected: [], sink: [] };
          outboundProbes.push(probe);
          const dispatcher = createReplyDispatcher({ deliver: async payload => { probe.sink.push(payload.text); } });
          try {
            await dispatchInboundMessage({ cfg: api.config, dispatcher,
              ctx: { Body: 'Return a short fixture reply.', From: 'fixture-operator', To: 'fixture-sink',
                AgentId: 'main', SessionKey: `agent:main:g3-outbound-${name}`, Provider: 'webchat', Surface: 'webchat',
                ChatType: 'direct', SenderId: 'fixture-operator', MessageSid: `g3-outbound-${name}`, CommandAuthorized: true },
              replyOptions: { disableTools: true, disableBlockStreaming: true,
                onAgentRunStart: runId => { probe.runIds.push(runId); } },
              // Omission exercises native default generation/admission. The other
              // resolver is synthetic and makes no claim about a native Agent Run.
              ...name === 'native-main' || name === 'invalid-response' ? {} : {
                replyResolver: async (_ctx, options) => {
                  probe.defaultCalls++;
                  if (name === 'resolver-block') await options?.onBlockReply?.({ text: 'Synthetic resolver block.' });
                  return { text: 'Synthetic resolver final.' };
                },
              },
            });
          } finally { await settleReplyDispatcher({ dispatcher }); }
        }
        const [nativeMain, invalid, sendingFailure, earlyControlled, fallbackControlled, blockControlled, sendingTimeout] = outboundProbes;
        assert(nativeMain && invalid && sendingFailure && earlyControlled && fallbackControlled && blockControlled && sendingTimeout);
        assert.equal(nativeMain.runIds.length, 1, 'native-main Run starts'); assert.equal(nativeMain.defaultCalls, 0);
        assert.equal(nativeMain.gateChecks, 1, 'native-main Response checks'); assert.equal(nativeMain.rejected.length, 0);
        assert.deepEqual(nativeMain.sink, ['Native Main fixture reply.']);
        assert.equal(invalid.runIds.length, 1); assert.equal(invalid.gateChecks, 1);
        assert.equal(invalid.rejected[0], 'response_invalid');
        assert.equal(invalid.rejected.length, invalid.hookEvents.length); assert.deepEqual(invalid.sink, []);
        assert.equal(sendingFailure.hookEvents.length, 1); assert.equal(sendingFailure.gateChecks, 0);
        assert.deepEqual(sendingFailure.sink, ['Synthetic resolver final.']);
        assert.equal(sendingTimeout.hookEvents.length, 1); assert.equal(sendingTimeout.gateChecks, 0);
        assert.deepEqual(sendingTimeout.sink, ['Synthetic resolver final.']);
        for (const rejected of [earlyControlled, fallbackControlled, blockControlled]) {
          assert.equal(rejected.runIds.length, 0); assert.equal(rejected.gateChecks, 0);
          assert(rejected.hookEvents.length > 0); assert.equal(rejected.rejected.length, rejected.hookEvents.length);
          assert.deepEqual(rejected.sink, []);
        }
        assert.equal(earlyControlled.takeoverCalls, 0); assert.equal(earlyControlled.defaultCalls, 0);
        assert.equal(fallbackControlled.takeoverCalls, 1); assert.equal(fallbackControlled.defaultCalls, 1);
        assert.equal(blockControlled.hookEvents[0]?.kind, 'block');
        assert(blockControlled.hookEvents.length >= 2);
        assert(blockControlled.hookEvents.slice(1).every(event => event.kind === 'final'));
        const terminalCases = [];
        for (const [name, marker] of [['provider-error', 'G3_TERMINAL_PROVIDER_ERROR'],
          ['native-timeout', 'G3_TERMINAL_NATIVE_TIMEOUT'], ['partial-abort', 'G3_TERMINAL_PARTIAL_ABORT'],
          ['native-fallback', 'G3_TERMINAL_NATIVE_FALLBACK'], ['bounded-success', 'G3_BOUNDED_SUCCESS'],
          ['handled-tool-failure', 'G3_HANDLED_TOOL_FAILURE'], ['bounded-hook-error', 'G3_BOUNDED_HOOK_ERROR'],
          ['bounded-hook-timeout', 'G3_BOUNDED_HOOK_TIMEOUT'], ['bounded-hook-rejected', 'G3_BOUNDED_HOOK_REJECTED']] as const) {
          const probe: TerminalProbe = { name, toolFailures: 0, runIds: [], terminalOutcomes: [], agentEnds: [], partials: 0,
            abortIssued: false, outbound: [], sink: [], dispatchError: null, settledCalls: 0,
            responseChecks: 0, responseErrors: [] };
          terminalProbes.push(probe);
          const abort = new AbortController();
          const delivery = createMainResponseDelivery({
            requestId: `g3-terminal-${name}`, agentId: 'main',
            runId: () => { assert.equal(probe.runIds.length, 1); return probe.runIds[0]!; },
            assertCurrent: () => { isolated(); assert.notEqual(name, 'bounded-hook-rejected'); assert(!abort.signal.aborted); assert.equal(probe.runIds.length, 1); },
            responseFor: payload => {
              assert(payload && typeof payload === 'object' && 'text' in payload && typeof payload.text === 'string');
              probe.responseChecks++;
              const runId = probe.runIds[0]; assert(runId);
              if (probe.terminalOutcomes.includes('failed') || probe.toolFailures > 0 || ('isError' in payload && payload.isError === true)) {
                return createResponseEnvelope({ messageCandidate: null }, {
                  requestId: `g3-terminal-${name}`, source: { type: 'main', agentId: 'main', runId }, status: 'failure',
                  results: [], pendingContext: null, provenance: { executionVerified: false, completionCorrelated: false },
                  lifecycle: { domainExecution: 'uncertain', failure: { code: 'RUN_OUTCOME_UNRESOLVED' } },
                  responsePolicy: { preferredMode: 'safe_failure', allowedModes: ['safe_failure'] },
                });
              }
              assert(probe.terminalOutcomes.includes('completed'));
              return responseFor(payload.text, `g3-terminal-${name}`, runId);
            }, presentation: renderOptions(), deliver: async payload => { probe.sink.push(payload.text); },
          });
          const deliveryErrors: string[] = [];
          const dispatcher = createReplyDispatcher({ deliver: delivery.deliver,
            beforeDeliver: payload => payload.isFallbackNotice ? null : payload,
            onError: error => { deliveryErrors.push(error instanceof Error ? error.message : String(error)); } });
          try {
            await dispatchInboundMessage({ cfg: api.config, dispatcher,
              onSettled: () => { probe.settledCalls++; },
              ctx: { Body: marker, From: 'fixture-operator', To: 'fixture-sink', AgentId: 'main',
                SessionKey: `agent:main:g3-terminal-${name}`, Provider: 'webchat', Surface: 'webchat', ChatType: 'direct',
                SenderId: 'fixture-operator', MessageSid: `g3-terminal-${name}`, CommandAuthorized: true },
              replyOptions: { disableTools: name !== 'handled-tool-failure', disableBlockStreaming: true, abortSignal: abort.signal,
                timeoutOverrideMs: name === 'native-timeout' ? 1000 : 5000,
                onAgentRunStart: runId => { probe.runIds.push(runId); },
                onAgentRunTerminalOutcome: outcome => { probe.terminalOutcomes.push(outcome); },
                onPartialReply: () => {
                  probe.partials++;
                  if (name === 'partial-abort' && !abort.signal.aborted) {
                    probe.abortIssued = true; abort.abort(new Error('Isolated causal partial abort'));
                  }
                  // Observation is not operator-visible delivery (ProgressCallbackResult).
                  return false;
                },
              },
            });
          } catch (error) { probe.dispatchError = error instanceof Error ? error.message : String(error); }
          finally { await settleReplyDispatcher({ dispatcher }); }
          const receipt = await dispatcher.waitForIdle(); assert(receipt);
          assert.equal(probe.settledCalls, 1, `${name}: public cleanup observes settlement`);
          assert.equal(probe.dispatchError, null, `${name}: unexpected dispatch error`);
          assert.equal(probe.runIds.length, 1, `${name}: actual native Main Run`);
          for (const event of probe.outbound) assert.equal(event.runId, probe.runIds[0]);
          for (const end of probe.agentEnds) assert.equal(end.runId, probe.runIds[0]);
          if (name === 'partial-abort') {
            assert(probe.partials > 0); assert(probe.abortIssued);
            assert.deepEqual(probe.terminalOutcomes, []); assert.deepEqual(probe.outbound, []);
            assert.deepEqual(probe.sink, []); assert.equal(delivery.snapshot().outcome, 'pending');
          } else if (name === 'bounded-hook-rejected') {
            assert.deepEqual(probe.sink, []); assert.equal(probe.responseChecks, 0);
            assert.equal(delivery.snapshot().outcome, 'blocked'); assert(deliveryErrors.length > 0);
            assert.equal(receipt.counts.final.delivered, 0);
          } else {
            assert.equal(probe.sink.length, 1, name + ': one authorized response');
            assert.equal(probe.responseChecks, 1); assert.equal(delivery.snapshot().outcome, 'delivered');
            assert.equal(receipt.counts.final.delivered, 1); assert(receipt.anyVisibleDelivered);
            if (name === 'provider-error' || name === 'native-timeout' || name === 'handled-tool-failure') {
              assert.match(probe.sink[0]!, /may have had effects/);
              assert.match(probe.sink[0]!, /will not repeat it automatically/);
              if (name === 'handled-tool-failure') assert.equal(probe.toolFailures, 1);
              else assert.deepEqual(probe.terminalOutcomes, ['failed']);
            } else assert.deepEqual(probe.sink, ['Native Main fixture reply.']);
          }
          // Exercise the existing failure renderer separately from authorization.
          // Unknown effects are a conservative fixture projection, not inferred
          // from a terminal hook or a manufactured domain Completion/result.
          const runId = probe.runIds[0]; assert(runId);
          const uncertain = createResponseEnvelope({ messageCandidate: null }, {
            requestId: `g3-terminal-${name}`, source: { type: 'main', agentId: 'main', runId }, status: 'failure',
            results: [], pendingContext: null, provenance: { executionVerified: false, completionCorrelated: false },
            lifecycle: { domainExecution: 'uncertain', failure: { code: 'RUN_OUTCOME_UNRESOLVED' } },
            responsePolicy: { preferredMode: 'safe_failure', allowedModes: ['safe_failure'] },
          });
          const response = controlResponse(uncertain, renderOptions());
          assert.equal(response.mode, 'safe_failure'); assert(response.rendered);
          assert.match(response.rendered.message, /may have had effects/);
          assert.match(response.rendered.message, /will not repeat it automatically/);
          terminalCases.push({ ...probe, receipt, boundedDelivery: delivery.snapshot(), deliveryErrors, conservativeFailureRendering: response,
            limits: 'Request-local text-only Response integration; disposable fixture custody only. No production grant, durable recovery or universal channel boundary.' });
        }
        const readAdmissionCases = await proveReadAdmissions(false);
        const publicSettlementBoundary = await provePublicSettlementBoundary();
        writeReport({ probe: 'PASS', G3: 'BLOCKED', baseline, cases: probes, outboundCases: outboundProbes,
          localDeliveryBoundary, terminalCases, readAdmissionCases, publicSettlementBoundary,
          observedGaps: ['Nested public getReplyFromConfig returns no synchronous Main result in this pre-dispatch composition',
            'A throwing reply_dispatch hook permits default resolver/output without Response',
            'before_dispatch handled output precedes reply_dispatch',
            'Suppressing an ordinary reply may trigger an additional native fallback payload; every observed payload is checked separately',
            'Public reply_payload_sending observes and can cancel early/fallback output, but an unhandled hook failure or registered deadline permits delivery'],
          unproven: ['all lifecycle callbacks', 'progress and alternate sends', 'trusted production destination/currentness',
            'mid-run cancellation and replacement', 'restart and durable recovery', 'single/multi-domain critical semantics', 'channel delivery'],
          limits: 'The host-owned raw-delivery adapter covers only the isolated terminal text paths in terminalCases. Historical hook probes retain fail-open evidence. No authentic production grant, universal enforcement, durable recovery or real channel delivery is accepted.' });
      } catch (error) { writeReport({ probe: 'BLOCKED', error: error instanceof Error ? error.message : 'G3 fixture failed',
        stack: error instanceof Error ? error.stack : null, probes, active, outboundCases: outboundProbes, terminalProbes }); }
    }, { timeoutMs: 100_000 });
  },
};

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--worker') {
  void worker('main-interception').catch(error => { console.error(error); process.exitCode = 1; });
}

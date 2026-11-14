import Type from 'typebox';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { OpenClawPluginToolFactory, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { executeJessicaStatusTask, bindJessicaTaskPending, JESSICA_TASK_SCHEMA, JESSICA_TASK_ENTRY_SCHEMA } from '../../../../../agents/jessica-vacuum/lib/task.js';
import { resolveTrustedIdentity, assertRosterPolicyAgreement, type FamilyRoutes } from '../../../../../agents/jessica-vacuum/lib/identity.js';
import { authorize, type loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { DOMAIN_RESULT_OUTPUT_SCHEMA, DOMAIN_RESULT_V3_OUTPUT_SCHEMA, createCompletionDomainResult, createCompletionDomainResultV3 } from '../../../benson-routing/core/domain-result.js';
import type { TaskEnvelope, Effects, AnyDomainResult } from '../../../benson-routing/core/contracts.js';
import { assertInvocationCurrent } from '../../../benson-routing/core/invocation.js';
import { boundedCopy, synchronous, fail } from '../../../benson-routing/core/value.js';
import { createCurrentRequestContext, type CurrentRequestEvidence, type CurrentRequestProjection } from '../../../benson-routing/core/conversation-context.js';
import { validateCompletion, type CompletionAuthority } from '../../../benson-routing/core/completion.js';
import type { ExecutionContext } from '../../../../../agents/jessica-vacuum/lib/executor.js';
import { READ_REQUEST_SCHEMA, parseReadRequest } from '../../../../../agents/jessica-vacuum/lib/schemas.js';
import { loadRegistry } from '../../../../../agents/jessica-vacuum/lib/registry.js';
import { validateResult, type Result } from '../../../../../agents/jessica-vacuum/lib/results.js';
import { validateTaskEnvelope } from '../../../benson-routing/core/task-envelope.js';

type Tool = Exclude<NonNullable<ReturnType<OpenClawPluginToolFactory<2>['create']>>, unknown[]>;
type ToolResult = Awaited<ReturnType<Tool['execute']>>;
type TaskDependencies = Parameters<typeof executeJessicaStatusTask>[2];
/** K11's version-pinned SDK projection. Stock hosts lack these optional fields.
 * Native handles are used in-process only; this is not an authority registry.
 */
type NativeRequesterContext = OpenClawPluginToolContext<2> & {
  captureRequesterDelegation?: (scope: { agentId: string; tools: readonly string[]; signal: AbortSignal;
    assertSourceCurrent(): void }) => unknown;
  delegatedRequester?: {
    contract: 'openclaw.requester-delegation.v1';
    parent: { agentId: string; sessionKey: string; sessionId: string; runId: string; toolCallId: string; toolName: string };
    child: { agentId: string; sessionKey: string; sessionId: string; runId: string };
    requester: { senderId: string; deliveryContext: { channel: string; accountId: string; to: string } };
    signal: AbortSignal; assertCurrent(): void;
  };
};
type DelegatedReadSource = Pick<TaskDependencies, 'identity' | 'authority'> & {
  observeRead?(callId: string, result: Pick<Result, 'operation' | 'status' | 'verified'>): void;
};
/** Call only after the existing Main task owner has authorized the original
 * request. The host, rather than these arguments, determines the principal.
 */
export function captureJessicaRequesterDelegation(context: OpenClawPluginToolContext<2>, authority: TaskDependencies['authority']) {
  assertInvocationCurrent(authority);
  const native = context as NativeRequesterContext;
  if (context.agentId !== 'main' || !context.sessionKey || !context.sessionId || typeof native.captureRequesterDelegation !== 'function')
    throw new Error('jessica_native_requester_delegation_unavailable');
  return native.captureRequesterDelegation({ agentId: 'jessica-vacuum', tools: ['jessica_read'], signal: authority.signal,
    assertSourceCurrent() { assertInvocationCurrent(authority); synchronous(context.assertInvocationCurrent(), 'jessica_requester_authority_must_be_synchronous'); } });
}
/** Resolve the original requester through the host's exact child capability.
 * Copies of these facts never replace its live native assertion.
 */
export function resolveJessicaRequesterDelegation(context: OpenClawPluginToolContext<2>, roster: FamilyRoutes,
  log?: (message: string) => void): DelegatedReadSource | undefined {
  const native = (context as NativeRequesterContext).delegatedRequester;
  if (!native) return undefined;
  if (native.contract !== 'openclaw.requester-delegation.v1' || context.agentId !== 'jessica-vacuum' ||
    native.parent.agentId !== 'main' || native.parent.toolName !== 'jessica_task' || !native.parent.toolCallId ||
    !native.parent.runId || native.child.agentId !== context.agentId || native.child.sessionKey !== context.sessionKey ||
    native.child.sessionId !== context.sessionId || native.child.sessionId === native.parent.sessionId ||
    native.child.runId === native.parent.runId || typeof native.assertCurrent !== 'function' || !(native.signal instanceof AbortSignal))
    throw new Error('jessica_native_requester_binding_invalid');
  const identity = resolveTrustedIdentity({ ...native.requester.deliveryContext, senderId: native.requester.senderId }, roster);
  const authority = { signal: native.signal, assertCurrent() {
    synchronous(context.assertInvocationCurrent(), 'jessica_requester_authority_must_be_synchronous');
    synchronous(native.assertCurrent(), 'jessica_requester_authority_must_be_synchronous');
  } };
  return { identity, authority, observeRead(callId, result) {
    // Owner-only diagnostic facts, never a grant, receipt or settlement seal.
    // Recheck the live native scope before projecting its private binding.
    // Missing/failed logging leaves proof unavailable; it cannot change access.
    try {
      assertInvocationCurrent(authority);
      const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
      const execution = (value: typeof native.child) => ({ agentId: value.agentId,
        sessionKeySha256: fingerprint(value.sessionKey), sessionIdSha256: fingerprint(value.sessionId),
        runIdSha256: fingerprint(value.runId) });
      log?.(`benson.jessica_g1b ${JSON.stringify({ version: 1, phase: 'read_validated',
        parent: { ...execution(native.parent), toolName: native.parent.toolName, toolCallIdSha256: fingerprint(native.parent.toolCallId) },
        child: { ...execution(native.child), toolName: 'jessica_read', toolCallIdSha256: fingerprint(callId) },
        requester: { senderIdSha256: fingerprint(native.requester.senderId),
          channel: native.requester.deliveryContext.channel, accountIdSha256: fingerprint(native.requester.deliveryContext.accountId),
          toSha256: fingerprint(native.requester.deliveryContext.to) },
        read: { operation: result.operation, status: result.status, verified: result.verified },
      })}`);
    } catch { /* No raw exception, context, authority handle or request content. */ }
  } };
}
/** Candidate replacement for the existing domain-only raw read registration.
 * Transport and state remain injected through the existing domain reader.
 */
export function createJessicaReadToolFactory(options: {
  roster: FamilyRoutes; policy: ReturnType<typeof loadPolicy>; registryConfig: unknown;
  read: TaskDependencies['read'];
  jsonResult(value: Result, callId: string, assertCompletion: (args: unknown, value: unknown) => void): ToolResult;
  clock?: () => Date;
  /** Adapter-private original source, using the existing domain task port.
   * A child invocation need not inherit the originating channel route.
   */
  source?: DelegatedReadSource;
}): OpenClawPluginToolFactory<2>['create'] {
  assertRosterPolicyAgreement(options.roster, options.policy);
  const registry = loadRegistry(options.registryConfig);
  const operations = ['status', 'rooms', 'capabilities', 'maintenance', 'statistics', 'operation_status']
    .filter(operation => registry.capabilities.some(capability => capability.name === `read_${operation}` && capability.support !== 'disabled'));
  if (!operations.length) throw new Error('Jessica read scope is unavailable');
  const parameters = { allOf: [READ_REQUEST_SCHEMA, { type: 'object', properties: { operation: { enum: operations } } }] };
  return context => {
    if (context.agentId !== 'jessica-vacuum' || typeof context.assertInvocationCurrent !== 'function') return null;
    return { name: 'jessica_read', label: 'Jessica read', catalogMode: 'direct-only',
      description: 'Read Jessica status, rooms, accepted capabilities, maintenance, lifetime statistics, or an enabled known dispatch operation. No device action.',
      parameters, executionMode: 'sequential',
      async execute(callId, raw, signal) {
        const authority = { signal: AbortSignal.any([...(signal ? [signal] : []), ...(options.source ? [options.source.authority.signal] : [])]),
          assertCurrent() {
            synchronous(context.assertInvocationCurrent(), 'jessica_read_authority_must_be_synchronous');
            if (options.source) assertInvocationCurrent(options.source.authority);
          } };
        assertInvocationCurrent(authority);
        const route = context.deliveryContext;
        const identity = options.source ? options.source.identity : (() => {
          if (typeof route?.channel !== 'string' || typeof route.accountId !== 'string' || typeof route.to !== 'string') throw new TypeError('jessica_read_requester_untrusted');
          return resolveTrustedIdentity({ channel: route.channel, accountId: route.accountId, to: route.to,
            senderId: typeof context.requesterSenderId === 'string' ? context.requesterSenderId : '' }, options.roster);
        })();
        authorize(options.policy, identity, 'read');
        const request = parseReadRequest(raw);
        if (!operations.includes(request.operation)) throw new TypeError('jessica_read_operation_disabled');
        const value = await options.read(request, identity, authority);
        assertInvocationCurrent(authority);
        const result = validateResult(value, null, (options.clock ?? (() => new Date()))());
        if (result.operation !== request.operation) throw new TypeError('jessica_read_result_mismatch');
        const captured = boundedCopy(result), capturedRequest = boundedCopy(request);
        const serialized = synchronous(options.jsonResult(result, callId, (args, value) => {
          if (options.source) assertInvocationCurrent(options.source.authority);
          else synchronous(context.assertInvocationCurrent(), 'jessica_read_authority_must_be_synchronous');
          authorize(options.policy, identity, 'read');
          if (!isDeepStrictEqual(boundedCopy(parseReadRequest(args)), capturedRequest) ||
            !isDeepStrictEqual(boundedCopy(value), captured)) fail('jessica_read_evidence_mismatch');
        }), 'jessica_read_serialization_must_be_synchronous');
        // Only a validated/serialized result can produce this diagnostic. The
        // final live guard still owns release, including observer side effects.
        try { options.source?.observeRead?.(callId, result); } catch { /* Observation is not authorization. */ }
        assertInvocationCurrent(authority);
        return serialized;
      },
    };
  };
}
/** Source candidate for the existing jessica_task registration; no HA I/O defaults. */
export function createJessicaTaskToolFactory(options: {
  roster: FamilyRoutes; policy: ReturnType<typeof loadPolicy>; read: TaskDependencies['read'];
  jsonResult(value: AnyDomainResult, callId: string, assertCompletion?: () => void): ToolResult;
  clock?: () => Date; resultVersion?: 2 | 3;
  task?: {
    source(context: OpenClawPluginToolContext<2>): CurrentRequestEvidence;
    history?(context: OpenClawPluginToolContext<2>, callId: string): Promise<Parameters<typeof bindJessicaTaskPending>[1] & { assertRetainedCurrent(): void }>;
    run(request: TaskEnvelope, work: { callId: string; source: CurrentRequestProjection; execution: ExecutionContext;
      pending?: ReturnType<typeof bindJessicaTaskPending> }):
      Promise<{ completion: unknown; authority: CompletionAuthority; effects: Effects }>;
  };
}): OpenClawPluginToolFactory<2>['create'] {
  const project = options.resultVersion === 3 ? createCompletionDomainResultV3 :
    options.resultVersion === undefined || options.resultVersion === 2 ? createCompletionDomainResult : fail('domain_result_version');
  assertRosterPolicyAgreement(options.roster, options.policy);
  const released = new WeakSet<CompletionAuthority>();
  return context => {
    if (context.agentId !== 'main' || typeof context.assertInvocationCurrent !== 'function') return null;
    let taskStarted = false;
    return {
      name: 'jessica_task', label: 'Jessica task', catalogMode: 'direct-only',
      description: options.task ? 'Delegate self-contained Jessica intent to its domain; structured status executes deterministically.'
        : 'Delegate a Jessica status task to its deterministic domain entry. No device action or child Run.',
      parameters: options.task ? JESSICA_TASK_ENTRY_SCHEMA : JESSICA_TASK_SCHEMA,
      outputSchema: options.resultVersion === 3 ? Type.Union([DOMAIN_RESULT_OUTPUT_SCHEMA, DOMAIN_RESULT_V3_OUTPUT_SCHEMA]) : DOMAIN_RESULT_OUTPUT_SCHEMA, executionMode: 'sequential',
      async execute(callId, request, signal) {
        const authority = { signal: signal ?? AbortSignal.any([]), assertCurrent: () => context.assertInvocationCurrent() };
        assertInvocationCurrent(authority);
        const route = context.deliveryContext;
        if (typeof route?.channel !== 'string' || typeof route.accountId !== 'string' || typeof route.to !== 'string') {
          throw new TypeError('jessica_task_requester_untrusted');
        }
        const identity = resolveTrustedIdentity({ channel: route.channel, accountId: route.accountId, to: route.to,
          senderId: typeof context.requesterSenderId === 'string' ? context.requesterSenderId : '' }, options.roster);
        authorize(options.policy, identity, 'read');
        let result: AnyDomainResult;
        let assertResultCurrent = () => assertInvocationCurrent(authority);
        let assertCompletionCurrent: (() => void) | undefined;
        if (request !== null && typeof request === 'object' && 'operation' in request) {
          result = await executeJessicaStatusTask(callId, request, { identity, authority, read: options.read,
            ...options.clock ? { clock: options.clock } : {} });
        } else {
          if (!options.task) throw new Error('jessica_task_source_unavailable');
          const callerSessionKey = context.sessionKey, callerSessionId = context.sessionId;
          if (!callerSessionKey || !callerSessionId) throw new Error('jessica_task_caller_unavailable');
          const task = validateTaskEnvelope(request);
          const evidence = synchronous(options.task.source(context), 'jessica_task_source_must_be_synchronous');
          const current = createCurrentRequestContext({ ...evidence, assertCurrent() {
            assertInvocationCurrent(authority); return evidence.assertCurrent();
          } });
          const source = current.projectCurrentRequest({ signal: authority.signal });
          if (source.status !== 'available') throw new Error('jessica_task_source_unavailable');
          const binding = source.context.conversation;
          const senderId = context.requesterSenderId, channel = route.channel, accountId = route.accountId, to = route.to;
          if (task.request !== source.context.current.text || !source.context.current.entryId || binding.channel !== 'whatsapp' ||
            binding.accountId !== accountId || binding.peerId !== to || binding.requesterId !== (senderId || to) ||
            binding.kind !== identity.channelKind) throw new Error('jessica_task_source_mismatch');
          let pending: ReturnType<typeof bindJessicaTaskPending> | undefined;
          const assertSource = () => {
            assertInvocationCurrent(authority);
            if (context.sessionKey !== callerSessionKey || context.sessionId !== callerSessionId ||
              context.requesterSenderId !== senderId || context.deliveryContext?.channel !== channel ||
              context.deliveryContext.accountId !== accountId || context.deliveryContext.to !== to) throw new Error('jessica_task_caller_changed');
            if (current.revalidateProjection(source, { signal: authority.signal }).status !== 'available') throw new Error('jessica_task_source_retired');
            const fresh = resolveTrustedIdentity({ channel, accountId, to, senderId: senderId ?? '' }, options.roster);
            if (fresh.senderId !== identity.senderId || fresh.channelKind !== identity.channelKind) throw new Error('jessica_task_identity_changed');
            authorize(options.policy, fresh, 'read');
          };
          const assertCurrent = () => { assertSource(); pending?.assertCurrent(); };
          assertResultCurrent = assertCurrent;
          assertCurrent();
          if (taskStarted) throw new Error('jessica_task_already_started');
          taskStarted = true;
          if (options.task.history) {
            const history = await options.task.history(context, callId); assertSource();
            pending = bindJessicaTaskPending(task, history, source, options.clock ?? (() => new Date()), () => history.assertRetainedCurrent());
          } else if (task.version === 2) fail('jessica_pending_history_unavailable');
          assertCurrent();
          const handoff = await options.task.run(task, { callId, source, ...pending ? { pending } : {},
            execution: { identity, requestEpoch: source.context.current.entryId, authority: { signal: authority.signal, assertCurrent } } });
          assertCurrent();
          if (released.has(handoff.authority)) throw new Error('jessica_completion_already_released');
          const completion = validateCompletion(handoff.completion, handoff.authority);
          if (completion.schemaVersion !== 6 || completion.kind !== 'domain-task' || completion.binding.domain !== 'jessica-vacuum' ||
            completion.binding.agentId !== 'jessica-vacuum' || completion.binding.inputId !== source.context.current.entryId ||
            completion.binding.taskId !== callId || completion.binding.conversationId !== binding.conversationRef ||
            completion.binding.caller?.agentId !== 'main' || completion.binding.caller.sessionKey !== callerSessionKey ||
            completion.binding.caller.sessionId !== callerSessionId || completion.binding.completionTarget !== 'CALLER') throw new Error('jessica_task_completion_binding');
          result = project(completion, handoff.authority, { projectEffects: () => handoff.effects });
          if (pending) result = pending.project(result);
          const retainedPending = pending;
          assertCompletionCurrent = () => { validateCompletion(handoff.completion, handoff.authority); retainedPending?.assertCurrent(); };
          assertCurrent(); released.add(handoff.authority);
        }
        const serialized = synchronous(options.jsonResult(result, callId, assertCompletionCurrent), 'jessica_task_serialization_must_be_synchronous');
        assertResultCurrent();
        return serialized;
      },
    };
  };
}

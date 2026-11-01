import Type from 'typebox';
import type { OpenClawPluginToolFactory, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { executeJessicaStatusTask, JESSICA_TASK_SCHEMA, JESSICA_TASK_ENTRY_SCHEMA } from '../../../../../agents/jessica-vacuum/lib/task.js';
import { resolveTrustedIdentity, assertRosterPolicyAgreement, type FamilyRoutes } from '../../../../../agents/jessica-vacuum/lib/identity.js';
import { authorize, type loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { DOMAIN_RESULT_OUTPUT_SCHEMA, DOMAIN_RESULT_V3_OUTPUT_SCHEMA, createCompletionDomainResult, createCompletionDomainResultV3 } from '../../../benson-routing/core/domain-result.js';
import { TaskEnvelopeSchema, type TaskEnvelope, type Effects, type AnyDomainResult } from '../../../benson-routing/core/contracts.js';
import { assertInvocationCurrent } from '../../../benson-routing/core/invocation.js';
import { decode, synchronous, fail } from '../../../benson-routing/core/value.js';
import { createCurrentRequestContext, type CurrentRequestEvidence, type CurrentRequestProjection } from '../../../benson-routing/core/conversation-context.js';
import { validateCompletion, type CompletionAuthority } from '../../../benson-routing/core/completion.js';
import type { ExecutionContext } from '../../../../../agents/jessica-vacuum/lib/executor.js';
import { READ_REQUEST_SCHEMA, parseReadRequest } from '../../../../../agents/jessica-vacuum/lib/schemas.js';
import { loadRegistry } from '../../../../../agents/jessica-vacuum/lib/registry.js';
import { validateResult, type Result } from '../../../../../agents/jessica-vacuum/lib/results.js';

type Tool = Exclude<NonNullable<ReturnType<OpenClawPluginToolFactory<2>['create']>>, unknown[]>;
type ToolResult = Awaited<ReturnType<Tool['execute']>>;
type TaskDependencies = Parameters<typeof executeJessicaStatusTask>[2];
/** Candidate replacement for the existing domain-only raw read registration.
 * Transport and state remain injected through the existing domain reader.
 */
export function createJessicaReadToolFactory(options: {
  roster: FamilyRoutes; policy: ReturnType<typeof loadPolicy>; registryConfig: unknown;
  read: TaskDependencies['read']; jsonResult(value: Result): ToolResult; clock?: () => Date;
  /** Adapter-private original source, using the existing domain task port.
   * A child invocation need not inherit the originating channel route.
   */
  source?: Pick<TaskDependencies, 'identity' | 'authority'>;
}): OpenClawPluginToolFactory<2>['create'] {
  assertRosterPolicyAgreement(options.roster, options.policy);
  const registry = loadRegistry(options.registryConfig);
  const operations = ['status', 'rooms', 'capabilities', 'maintenance', 'statistics', 'operation_status']
    .filter(operation => registry.capabilities.some(capability => capability.name === `read_${operation}` && capability.support !== 'disabled'));
  if (!operations.length) throw new Error('Jessica read scope is unavailable');
  const parameters = { allOf: [READ_REQUEST_SCHEMA, { type: 'object', properties: { operation: { enum: operations } } }] };
  return context => {
    if (context.agentId !== 'jessica-vacuum' || typeof context.assertInvocationCurrent !== 'function') return null;
    return { name: 'jessica_read', label: 'Jessica read',
      description: 'Read Jessica status, rooms, accepted capabilities, maintenance, lifetime statistics, or an enabled known dispatch operation. No device action.',
      parameters, executionMode: 'sequential',
      async execute(_callId, raw, signal) {
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
        const serialized = synchronous(options.jsonResult(result), 'jessica_read_serialization_must_be_synchronous');
        assertInvocationCurrent(authority);
        return serialized;
      },
    };
  };
}
/** Source candidate for the existing jessica_task registration; no HA I/O defaults. */
export function createJessicaTaskToolFactory(options: {
  roster: FamilyRoutes; policy: ReturnType<typeof loadPolicy>; read: TaskDependencies['read'];
  jsonResult(value: AnyDomainResult): ToolResult; clock?: () => Date; resultVersion?: 2 | 3;
  task?: {
    source(context: OpenClawPluginToolContext<2>): CurrentRequestEvidence;
    run(request: TaskEnvelope, work: { callId: string; source: CurrentRequestProjection; execution: ExecutionContext }):
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
      name: 'jessica_task', label: 'Jessica task',
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
        if (request !== null && typeof request === 'object' && 'operation' in request) {
          result = await executeJessicaStatusTask(callId, request, { identity, authority, read: options.read,
            ...options.clock ? { clock: options.clock } : {} });
        } else {
          if (!options.task) throw new Error('jessica_task_source_unavailable');
          const callerSessionKey = context.sessionKey, callerSessionId = context.sessionId;
          if (!callerSessionKey || !callerSessionId) throw new Error('jessica_task_caller_unavailable');
          const task = decode(TaskEnvelopeSchema, request, 'jessica_task_intent_invalid');
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
          const assertCurrent = () => {
            assertInvocationCurrent(authority);
            if (context.sessionKey !== callerSessionKey || context.sessionId !== callerSessionId ||
              context.requesterSenderId !== senderId || context.deliveryContext?.channel !== channel ||
              context.deliveryContext.accountId !== accountId || context.deliveryContext.to !== to) throw new Error('jessica_task_caller_changed');
            if (current.revalidateProjection(source, { signal: authority.signal }).status !== 'available') throw new Error('jessica_task_source_retired');
            const fresh = resolveTrustedIdentity({ channel, accountId, to, senderId: senderId ?? '' }, options.roster);
            if (fresh.senderId !== identity.senderId || fresh.channelKind !== identity.channelKind) throw new Error('jessica_task_identity_changed');
            authorize(options.policy, fresh, 'read');
          };
          assertResultCurrent = assertCurrent;
          assertCurrent();
          if (taskStarted) throw new Error('jessica_task_already_started');
          taskStarted = true;
          const handoff = await options.task.run(task, { callId, source,
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
          assertCurrent(); released.add(handoff.authority);
        }
        const serialized = synchronous(options.jsonResult(result), 'jessica_task_serialization_must_be_synchronous');
        assertResultCurrent();
        return serialized;
      },
    };
  };
}

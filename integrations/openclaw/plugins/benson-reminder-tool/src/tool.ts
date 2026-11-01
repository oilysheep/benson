import Type from 'typebox';
import type { OpenClawPluginToolFactory, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { executeReminderListTask, assertReminderCreateSource, REMINDER_TASK_SCHEMA, REMINDER_TASK_ENTRY_SCHEMA } from '../../../../../agents/reminder-service/lib/task.js';
import type { IdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';
import { executeReminderTool, type ReminderTransaction, type Dependencies } from '../../../../../agents/reminder-service/lib/service.js';
import { schemaForTool } from '../../../../../agents/reminder-service/lib/tool-contracts.js';
import { normalizeReminderServiceResult, SERVICE_OPERATIONS } from '../../../../../agents/reminder-service/lib/results.js';
import type { ToolName } from '../../../../../agents/reminder-service/lib/schemas.js';
import { DOMAIN_RESULT_OUTPUT_SCHEMA, DOMAIN_RESULT_V3_OUTPUT_SCHEMA, createCompletionDomainResult, createCompletionDomainResultV3 } from '../../../benson-routing/core/domain-result.js';
import { TaskEnvelopeSchema, type TaskEnvelope, type Effects, type AnyDomainResult } from '../../../benson-routing/core/contracts.js';
import { validateCompletion, type CompletionAuthority } from '../../../benson-routing/core/completion.js';
import { createCurrentRequestContext, type CurrentRequestEvidence, type CurrentRequestProjection } from '../../../benson-routing/core/conversation-context.js';
import { assertInvocationCurrent } from '../../../benson-routing/core/invocation.js';
import { decode, synchronous, fail } from '../../../benson-routing/core/value.js';
import { resolveReminderRuntimeRoute } from './identity.js';

type Tool = Exclude<NonNullable<ReturnType<OpenClawPluginToolFactory<2>['create']>>, unknown[]>;
type ToolResult = Awaited<ReturnType<Tool['execute']>>;
/** Existing raw domain registrations, retaining their canonical schemas and
 * whole transaction owner. Original route/evidence are adapter-private: child
 * deliveryContext and model arguments cannot manufacture source authority.
 */
export function createReminderToolFactory(options: {
  name: ToolName; source: Dependencies; jsonResult(value: unknown): ToolResult;
  current?: CurrentRequestProjection;
}): OpenClawPluginToolFactory<2>['create'] {
  const source = options.source;
  return context => {
    if (context.agentId !== 'reminder-service' || typeof context.assertInvocationCurrent !== 'function') return null;
    return { name: options.name, label: options.name,
      description: 'Execute the existing Reminder domain operation with trusted source evidence and transaction verification.',
      parameters: schemaForTool(options.name, source.identities, source.route), executionMode: 'sequential',
      async execute(callId, raw, signal) {
        const authority = { signal: AbortSignal.any([source.authority.signal, ...(signal ? [signal] : [])]),
          assertCurrent() {
            synchronous(context.assertInvocationCurrent(), 'reminder_tool_authority_must_be_synchronous');
            assertInvocationCurrent(source.authority);
          } };
        assertInvocationCurrent(authority);
        if ((options.name === 'benson_reminder_create' || options.name === 'benson_reminder_create_plan') && options.current) assertReminderCreateSource(raw, options.current);
        const result = await executeReminderTool(options.name, raw, { ...source, authority,
          transaction: { async execute(request, transactionAuthority) {
            const value = await source.transaction.execute(request, transactionAuthority);
            assertInvocationCurrent(authority);
            // Validate the canonical operation and transaction evidence before
            // disclosure, retaining the complete original carrier for Completion.
            normalizeReminderServiceResult(request.operation, value, {
              taskId: callId, pendingBinding: null, pendingExpiresAt: null,
            });
            assertInvocationCurrent(authority);
            return value;
          } },
        });
        assertInvocationCurrent(authority);
        const serialized = synchronous(options.jsonResult(result), 'reminder_tool_serialization_must_be_synchronous');
        assertInvocationCurrent(authority);
        return serialized;
      } };
  };
}
/** Source candidate for the existing reminder_task registration; no registration here. */
export function createReminderTaskToolFactory(options: {
  identities: IdentityContract; transaction: ReminderTransaction;
  jsonResult(value: AnyDomainResult): ToolResult; clock?: () => Date; resultVersion?: 2 | 3;
  task?: {
    source(context: OpenClawPluginToolContext<2>): CurrentRequestEvidence;
    run(request: TaskEnvelope, context: { callId: string; source: CurrentRequestProjection; deps: Dependencies }):
      Promise<{ completion: unknown; authority: CompletionAuthority; effects: Effects }>;
  };
}): OpenClawPluginToolFactory<2>['create'] {
  const project = options.resultVersion === 3 ? createCompletionDomainResultV3 :
    options.resultVersion === undefined || options.resultVersion === 2 ? createCompletionDomainResult : fail('domain_result_version');
  const released = new WeakSet<CompletionAuthority>();
  return context => {
    if (context.agentId !== 'main' || typeof context.assertInvocationCurrent !== 'function') return null;
    let taskStarted = false;
    return {
      name: 'reminder_task', label: 'Reminder task',
      description: options.task ? 'Delegate bounded Reminder intent to its domain; structured list executes deterministically.'
        : 'Delegate a full Reminder list to its deterministic domain entry. No mutation or child Run.',
      parameters: options.task ? REMINDER_TASK_ENTRY_SCHEMA : REMINDER_TASK_SCHEMA,
      outputSchema: options.resultVersion === 3 ? Type.Union([DOMAIN_RESULT_OUTPUT_SCHEMA, DOMAIN_RESULT_V3_OUTPUT_SCHEMA]) : DOMAIN_RESULT_OUTPUT_SCHEMA, executionMode: 'sequential',
      async execute(callId, request, signal) {
        // The native API makes signal optional. Live authority always comes from
        // the host assertion; an inert local signal grants no authority.
        const authority = { signal: signal ?? AbortSignal.any([]), assertCurrent: () => context.assertInvocationCurrent() };
        assertInvocationCurrent(authority);
        const route = resolveReminderRuntimeRoute(context, options.identities);
        if (!route) throw new TypeError('reminder_task_requester_untrusted');
        const deps: Dependencies = {
          identities: options.identities, route, authority, transaction: options.transaction,
          // List never consumes transcript evidence; refuse any accidental read.
          evidence: { async readCurrentUserText() { throw new Error('reminder_list_evidence_not_applicable'); },
            async readOriginalUserTurns() { throw new Error('reminder_list_evidence_not_applicable'); } },
          ...options.clock ? { clock: options.clock } : {},
        };
        let result: AnyDomainResult;
        let assertResultCurrent = () => assertInvocationCurrent(authority);
        // The strict list shape retains its zero-Run path. Other input is
        // accepted only by the explicitly assembled, source-bound task entry.
        if (request !== null && typeof request === 'object' && 'operation' in request) {
          result = await executeReminderListTask(callId, request, deps);
        } else {
          if (!options.task) throw new Error('reminder_task_source_unavailable');
          const callerSessionKey = context.sessionKey, callerSessionId = context.sessionId;
          if (!callerSessionKey || !callerSessionId) throw new Error('reminder_task_caller_unavailable');
          const task = decode(TaskEnvelopeSchema, request, 'reminder_task_intent_invalid');
          const evidence = synchronous(options.task.source(context), 'reminder_task_source_must_be_synchronous');
          const current = createCurrentRequestContext({ ...evidence, assertCurrent() {
            assertInvocationCurrent(authority); return evidence.assertCurrent();
          } });
          const source = current.projectCurrentRequest({ signal: authority.signal });
          if (source.status !== 'available') throw new Error('reminder_task_source_unavailable');
          const binding = source.context.conversation;
          if (task.request !== source.context.current.text || !source.context.current.entryId || binding.channel !== 'whatsapp' ||
            binding.accountId !== options.identities.accountId || binding.peerId !== route.sourceId ||
            binding.requesterId !== route.senderId || binding.kind !== (route.sourceType === 'group' ? 'group' : 'direct')) {
            throw new Error('reminder_task_source_mismatch');
          }
          const assertCurrent = () => {
            assertInvocationCurrent(authority);
            if (context.sessionKey !== callerSessionKey || context.sessionId !== callerSessionId) throw new Error('reminder_task_caller_changed');
            if (current.revalidateProjection(source, { signal: authority.signal }).status !== 'available') throw new Error('reminder_task_source_retired');
            const fresh = resolveReminderRuntimeRoute(context, options.identities);
            if (!fresh || Object.entries(route).some(([key, value]) => Reflect.get(fresh, key) !== value)) throw new Error('reminder_task_route_changed');
          };
          const taskDeps: Dependencies = { ...deps, authority: { signal: authority.signal, assertCurrent }, evidence: {
            async readCurrentUserText() { assertCurrent(); return source.context.current.text; },
            async readOriginalUserTurns() { assertCurrent(); return [{ text: source.context.current.text }]; },
          } };
          assertResultCurrent = assertCurrent;
          assertCurrent();
          if (taskStarted) throw new Error('reminder_task_already_started');
          // An ambiguous attempt must reconcile through the domain, never replay.
          taskStarted = true;
          const handoff = await options.task.run(task, { callId, source, deps: taskDeps });
          assertCurrent();
          if (released.has(handoff.authority)) throw new Error('reminder_completion_already_released');
          const completion = validateCompletion(handoff.completion, handoff.authority);
          if (completion.schemaVersion !== 6 || completion.kind !== 'domain-task' || completion.binding.domain !== 'reminder' || completion.binding.agentId !== 'reminder-service' ||
            completion.binding.inputId !== source.context.current.entryId || completion.binding.taskId !== callId ||
            completion.binding.conversationId !== binding.conversationRef || completion.binding.caller?.agentId !== 'main' ||
            completion.binding.caller.sessionKey !== callerSessionKey || completion.binding.caller.sessionId !== callerSessionId ||
            completion.binding.completionTarget !== 'CALLER') throw new Error('reminder_task_completion_binding');
          result = project(completion, handoff.authority, { projectEffects: () => handoff.effects });
          if (result.operation !== null && !Object.values(SERVICE_OPERATIONS).some(operation => operation === result.operation)) throw new Error('reminder_task_operation_not_enabled');
          assertCurrent(); released.add(handoff.authority);
        }
        const serialized = synchronous(options.jsonResult(result), 'reminder_task_serialization_must_be_synchronous');
        assertResultCurrent();
        return serialized;
      },
    };
  };
}

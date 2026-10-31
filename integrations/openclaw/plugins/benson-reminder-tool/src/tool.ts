import type { OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';
import { executeReminderListTask, REMINDER_TASK_SCHEMA } from '../../../../../agents/reminder-service/lib/task.js';
import type { IdentityContract } from '../../../../../agents/reminder-service/lib/identity.js';
import type { ReminderTransaction } from '../../../../../agents/reminder-service/lib/service.js';
import { DOMAIN_RESULT_OUTPUT_SCHEMA } from '../../../benson-routing/core/domain-result.js';
import type { DomainResult } from '../../../benson-routing/core/contracts.js';
import { assertInvocationCurrent } from '../../../benson-routing/core/invocation.js';
import { synchronous } from '../../../benson-routing/core/value.js';
import { resolveReminderRuntimeRoute } from './identity.js';

type Tool = Exclude<NonNullable<ReturnType<OpenClawPluginToolFactory<2>['create']>>, unknown[]>;
type ToolResult = Awaited<ReturnType<Tool['execute']>>;
/** Source candidate for the existing reminder_task registration; no registration here. */
export function createReminderTaskToolFactory(options: {
  identities: IdentityContract; transaction: ReminderTransaction;
  jsonResult(value: DomainResult): ToolResult; clock?: () => Date;
}): OpenClawPluginToolFactory<2>['create'] {
  return context => {
    if (context.agentId !== 'main' || typeof context.assertInvocationCurrent !== 'function') return null;
    return {
      name: 'reminder_task', label: 'Reminder task',
      description: 'Delegate a full Reminder list to its deterministic domain entry. No mutation or child Run.',
      parameters: REMINDER_TASK_SCHEMA, outputSchema: DOMAIN_RESULT_OUTPUT_SCHEMA, executionMode: 'sequential',
      async execute(callId, request, signal) {
        // The native API makes signal optional. Live authority always comes from
        // the host assertion; an inert local signal grants no authority.
        const authority = { signal: signal ?? AbortSignal.any([]), assertCurrent: () => context.assertInvocationCurrent() };
        assertInvocationCurrent(authority);
        const route = resolveReminderRuntimeRoute(context, options.identities);
        if (!route) throw new TypeError('reminder_task_requester_untrusted');
        const result = await executeReminderListTask(callId, request, {
          identities: options.identities, route, authority, transaction: options.transaction,
          // List never consumes transcript evidence; refuse any accidental read.
          evidence: { async readCurrentUserText() { throw new Error('reminder_list_evidence_not_applicable'); },
            async readOriginalUserTurns() { throw new Error('reminder_list_evidence_not_applicable'); } },
          ...options.clock ? { clock: options.clock } : {},
        });
        const serialized = synchronous(options.jsonResult(result), 'reminder_task_serialization_must_be_synchronous');
        assertInvocationCurrent(authority);
        return serialized;
      },
    };
  };
}

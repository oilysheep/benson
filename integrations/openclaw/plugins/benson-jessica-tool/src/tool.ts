import type { OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';
import { executeJessicaStatusTask, JESSICA_TASK_SCHEMA } from '../../../../../agents/jessica-vacuum/lib/task.js';
import { resolveTrustedIdentity, assertRosterPolicyAgreement, type FamilyRoutes } from '../../../../../agents/jessica-vacuum/lib/identity.js';
import { authorize, type loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { DOMAIN_RESULT_OUTPUT_SCHEMA } from '../../../benson-routing/core/domain-result.js';
import type { DomainResult } from '../../../benson-routing/core/contracts.js';
import { assertInvocationCurrent } from '../../../benson-routing/core/invocation.js';
import { synchronous } from '../../../benson-routing/core/value.js';

type Tool = Exclude<NonNullable<ReturnType<OpenClawPluginToolFactory<2>['create']>>, unknown[]>;
type ToolResult = Awaited<ReturnType<Tool['execute']>>;
type TaskDependencies = Parameters<typeof executeJessicaStatusTask>[2];
/** Source candidate for the existing jessica_task registration; no HA I/O defaults. */
export function createJessicaTaskToolFactory(options: {
  roster: FamilyRoutes; policy: ReturnType<typeof loadPolicy>; read: TaskDependencies['read'];
  jsonResult(value: DomainResult): ToolResult; clock?: () => Date;
}): OpenClawPluginToolFactory<2>['create'] {
  assertRosterPolicyAgreement(options.roster, options.policy);
  return context => {
    if (context.agentId !== 'main' || typeof context.assertInvocationCurrent !== 'function') return null;
    return {
      name: 'jessica_task', label: 'Jessica task',
      description: 'Delegate a Jessica status task to its deterministic domain entry. No device action or child Run.',
      parameters: JESSICA_TASK_SCHEMA, outputSchema: DOMAIN_RESULT_OUTPUT_SCHEMA, executionMode: 'sequential',
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
        const result = await executeJessicaStatusTask(callId, request, { identity, authority, read: options.read,
          ...options.clock ? { clock: options.clock } : {} });
        const serialized = synchronous(options.jsonResult(result), 'jessica_task_serialization_must_be_synchronous');
        assertInvocationCurrent(authority);
        return serialized;
      },
    };
  };
}

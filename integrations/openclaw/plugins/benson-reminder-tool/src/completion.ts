import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { PublicSchemas, type ServiceOperation, type ToolName } from '../../../../../agents/reminder-service/lib/schemas.js';
import { normalizeReminderServiceResult } from '../../../../../agents/reminder-service/lib/results.js';
import { settleNativeDomainCompletion, type NativeDomainCompletionInput } from '../../../benson-routing/core/completion.js';
import { createCompletionDomainResult, createCompletionDomainResultV3 } from '../../../benson-routing/core/domain-result.js';
import { assertion, synchronous, fail } from '../../../benson-routing/core/value.js';
import type { Binding6 } from '../../../benson-routing/core/completion-contracts.js';
import type { Effects } from '../../../benson-routing/core/contracts.js';
import type { createReminderTaskToolFactory } from './tool.js';

type Observation = { resultVersion?: 2 | 3 } & Omit<NativeDomainCompletionInput, 'binding' | 'knownFacts'> & {
  operation: ServiceOperation; effects: Effects; uncertainty: NativeDomainCompletionInput['knownFacts']['uncertainty'];
};
/** Retain the original service carrier in the native transcript. Normalization
 * occurs at this domain boundary, never by replacing the raw tool response.
 */
export function normalizeReminderCompletion(input: Observation & { binding: Binding6 }) {
  const project = input.resultVersion === 3 ? createCompletionDomainResultV3 :
    input.resultVersion === undefined || input.resultVersion === 2 ? createCompletionDomainResult : fail('domain_result_version');
  const value = normalizeReminderServiceResult(input.operation, input.tool.value, { taskId: input.binding.taskId,
    pendingBinding: null, pendingExpiresAt: null });
  if (input.binding.domain !== 'reminder' || input.binding.agentId !== 'reminder-service' ||
    !Object.hasOwn(PublicSchemas, input.tool.name) ||
    (input.tool.name !== `benson_reminder_${value.operation}` &&
      !(input.tool.name === 'benson_reminder_create_plan' && value.operation === 'create'))) throw new Error('reminder_native_completion_unverified');
  const effects = structuredClone(input.effects);
  const knownFacts = { domain: value.domain, domainSchemaVersion: value.domainSchemaVersion, operation: value.operation,
    status: value.status, verified: value.verified, verificationScope: value.verified ? ['reminder_transaction'] : [],
    data: value.data, warnings: value.warnings, error: value.error, pendingContext: value.pendingContext,
    effects: effects.details, uncertainty: structuredClone(input.uncertainty) };
  const { record, authority } = settleNativeDomainCompletion({ ...input, knownFacts });
  const result = project(record, authority, { expectedRunId: input.binding.runId,
    ...record.completion.outcome === 'NORMAL' ? { expectedTaskResult: value } : {}, projectEffects: () => effects });
  return { completion: record, authority, effects: result.effects, result };
}

type Task = NonNullable<Parameters<typeof createReminderTaskToolFactory>[0]['task']>;
/** Product producer for the existing Task Entry. The host captures native hook
 * observations and domain evidence; this adapter owns launch/receipt/caller
 * correlation, terminal validation and controlled Completion production.
 * Registration, evidence acquisition and transport remain native host work.
 */
export async function runReminderNativeTask(request: Parameters<Task['run']>[0], work: Parameters<Task['run']>[1], options: {
  resultVersion?: 2 | 3;
  runtime: Pick<OpenClawPluginApi['runtime']['subagent'], 'run' | 'waitForRun'>;
  sessionKey: string; message: string;
  /** Exact existing plugin-owned registration projection; never grant tools
   * merely because their domain schemas exist. Native policy still decides.
   */
  toolsAlsoAllow: readonly ToolName[];
  caller: NonNullable<Binding6['caller']>;
  observe(): Observation;
}) {
  if (options.resultVersion !== undefined && options.resultVersion !== 2 && options.resultVersion !== 3) fail('domain_result_version');
  const signal = work.deps.authority.signal, assertSource = work.deps.authority.assertCurrent.bind(work.deps.authority);
  const current = () => { signal.throwIfAborted(); assertion(assertSource(), 'reminder_source_custody_must_be_synchronous'); signal.throwIfAborted(); };
  current();
  const inputId = work.source.context.current.entryId, caller = structuredClone(options.caller), sessionKey = options.sessionKey;
  const tools = [...options.toolsAlsoAllow];
  if (!inputId || request.request !== work.source.context.current.text || caller.agentId !== 'main' ||
    !sessionKey.startsWith('agent:reminder-service:subagent:') || !tools.length || new Set(tools).size !== tools.length ||
    tools.some(name => !Object.hasOwn(PublicSchemas, name))) throw new Error('reminder_native_launch_binding');
  const receipt = await options.runtime.run({ sessionKey, message: options.message, promptMode: 'minimal', deliver: false,
    toolsAlsoAllow: tools, assertCurrent: current });
  current();
  if (receipt.sessionKey !== sessionKey) throw new Error('reminder_native_receipt_binding');
  // A wait timeout is not cancellation or terminal proof. Only the separately
  // captured native terminal observation can authorize settlement below.
  await options.runtime.waitForRun({ runId: receipt.runId, timeoutMs: 45_000 });
  current();
  const observed = synchronous(options.observe(), 'reminder_native_observation_must_be_synchronous');
  if (!tools.some(name => name === observed.tool.name)) throw new Error('reminder_native_tool_not_admitted');
  const assertCustody = observed.custody.assertCurrent.bind(observed.custody);
  const binding: Binding6 = { inputId, admissionId: inputId, conversationId: work.source.context.conversation.conversationRef,
    runId: receipt.runId, agentId: 'reminder-service', sessionKey, sessionId: observed.tool.sessionId,
    domain: 'reminder', taskId: work.callId, caller, completionTarget: 'CALLER', authorizationId: inputId,
    parentContinuation: { eligible: true, reason: null }, deliveryPolicy: { eligible: false, reason: null } };
  return normalizeReminderCompletion({ ...observed, ...options.resultVersion !== undefined ? { resultVersion: options.resultVersion } : {}, binding, custody: { assertCurrent(candidate) {
    current(); return assertCustody(candidate);
  } } });
}

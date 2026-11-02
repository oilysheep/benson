import { isDeepStrictEqual } from 'node:util';
import type { ToolExecutionEvidenceProvider } from '../../../benson-routing/core/tool-execution-evidence.js';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { PublicSchemas, parseRequest, type ServiceOperation, type ToolName } from '../../../../../agents/reminder-service/lib/schemas.js';
import { SERVICE_OPERATIONS, normalizeReminderServiceResult } from '../../../../../agents/reminder-service/lib/results.js';
import { MAX_NATIVE_TOOL_CALLS, settleNativeDomainCompletion, type NativeDomainCompletionInput, type NativeDomainNoToolCompletionInput } from '../../../benson-routing/core/completion.js';
import { createCompletionDomainResult, createCompletionDomainResultV3 } from '../../../benson-routing/core/domain-result.js';
import { assertion, synchronous, fail, plain, boundedCopy, decode, ObjectListSchema, read, TextSchema, MAX_BYTES } from '../../../benson-routing/core/value.js';
import type { Binding6 } from '../../../benson-routing/core/completion-contracts.js';
import { EffectsSchema, FactsSchema, type Effects } from '../../../benson-routing/core/contracts.js';
import type { createReminderTaskToolFactory } from './tool.js';

function serviceOperation(value: unknown): value is ServiceOperation {
  return typeof value === 'string' && Object.hasOwn(SERVICE_OPERATIONS, value);
}

type Observation = { resultVersion?: 2 | 3 } & Omit<NativeDomainCompletionInput, 'binding' | 'knownFacts'> & {
  operation: ServiceOperation; effects: Effects; uncertainty: NativeDomainCompletionInput['knownFacts']['uncertainty'];
};
type ReasoningObservation = Omit<NativeDomainNoToolCompletionInput, 'binding' | 'knownFacts'>;

/** A semantic question is not execution evidence. Only a sealed zero-tool Run
 * may propose this narrow create clarification; Task validates its provenance
 * against the original source before releasing the resulting pending. */
function normalizeReminderReasoningCompletion(input: ReasoningObservation & { binding: Binding6; resultVersion?: 2 | 3 }) {
  const final = input.terminal.messages.at(-1);
  if (!plain(final) || final.role !== 'assistant' || !Array.isArray(final.content) || final.content.length !== 1) fail('reminder_clarification_missing');
  const part: unknown = final.content[0];
  if (!plain(part) || part.type !== 'text' || typeof part.text !== 'string' || Buffer.byteLength(part.text, 'utf8') > MAX_BYTES) fail('reminder_clarification_missing');
  const proposal: unknown = JSON.parse(part.text);
  if (!plain(proposal)) fail('reminder_clarification_missing');
  const facts = read(FactsSchema, proposal.facts, 'reminder_clarification_invalid');
  if (facts.domain !== 'reminder' || facts.domainSchemaVersion !== 'legacy-unversioned' || facts.operation !== 'create' ||
      facts.status !== 'clarification_required' || facts.verified !== false || facts.verificationScope.length ||
      facts.effects.length || facts.uncertainty.length || facts.warnings.length || facts.error !== null || facts.pendingContext === null ||
      !plain(facts.data) || Object.keys(facts.data).join(',') !== 'question') fail('reminder_clarification_invalid');
  read(TextSchema, facts.data.question, 'reminder_clarification_invalid');
  const { record, authority } = settleNativeDomainCompletion({ ...input, knownFacts: facts });
  const effects: Effects = { status: 'none', refs: [], details: [], reconciliation: { required: false, reason: null } };
  const project = input.resultVersion === 3 ? createCompletionDomainResultV3 : createCompletionDomainResult;
  const result = project(record, authority, { expectedRunId: input.binding.runId, projectEffects: () => effects });
  return { completion: record, authority, effects: result.effects, result };
}
/** Canonical transaction identity validation, shared by aggregation and the
 * receipt/domain correlation check. No report or transcript grants authority. */
function reminderEffectIds(name: string, raw: unknown, operation: ServiceOperation, requestedId?: unknown): string[] {
  if (!plain(raw) || !plain(raw.data)) fail('reminder_effect_identity_missing');
  const ids: string[] = [];
  const add = (id: unknown) => {
    if (typeof id !== 'string' || !id.trim() || ids.includes(id)) fail('reminder_effect_identity_invalid');
    ids.push(id);
  };
  // Canonical service carriers: one top-level reminderId, or the plan's
  // top-level reminderIds with its complete, ordered record collection.
  if (name === 'benson_reminder_create_plan') {
    if (Object.hasOwn(raw, 'reminderId') || !Array.isArray(raw.reminderIds) || !raw.reminderIds.length ||
      !Array.isArray(raw.data.records) || raw.reminderIds.length !== raw.data.records.length ||
      Object.hasOwn(raw.data, 'record')) fail('reminder_effect_identity_missing');
    for (const [index, id] of raw.reminderIds.entries()) {
      add(id); const record: unknown = raw.data.records[index];
      if (!plain(record) || record.reminderId !== id) fail('reminder_effect_identity_mismatch');
    }
  } else {
    add(raw.reminderId);
    if (Object.hasOwn(raw, 'reminderIds') || !plain(raw.data.record) || raw.data.record.reminderId !== raw.reminderId ||
      requestedId !== undefined && requestedId !== raw.reminderId) fail('reminder_effect_identity_mismatch');
    // Recipient-specific update verifies both the remaining original record
    // and the newly restructured record. Neither effect may disappear.
    if (Object.hasOwn(raw.data, 'restructuredRecord')) {
      if (operation !== 'update-reminder' || !plain(raw.data.restructuredRecord)) fail('reminder_effect_identity_mismatch');
      add(raw.data.restructuredRecord.reminderId);
    }
  }
  return ids;
}

/** Project every captured domain carrier; this is a proposal until the existing
 * normalizer validates complete native receipt coverage and private witnesses.
 * Failed writes retain uncertainty and never become a no-effect assertion. */
export function collectReminderRunEffects(tools: readonly NativeDomainCompletionInput['tool'][], taskId: string):
  { effects: Effects; uncertainty: Observation['uncertainty'] } {
  if (!tools.length || tools.length > MAX_NATIVE_TOOL_CALLS || new Set(tools.map(tool => tool.callId)).size !== tools.length) fail('reminder_effect_calls_invalid');
  const effects: Effects = { status: 'none', refs: [], details: [], reconciliation: { required: false, reason: null } };
  const uncertainty: Observation['uncertainty'] = [];
  for (const tool of tools) {
    const operation = reminderToolOperation(tool.name);
    const value = normalizeReminderServiceResult(operation, tool.value, { taskId, pendingBinding: null, pendingExpiresAt: null });
    if (operation === 'list-reminders' || operation === 'find-reminders') continue;
    if (!value.verified) {
      effects.status = 'possible'; effects.reconciliation = { required: true, reason: 'REMINDER_TRANSACTION_UNRESOLVED' };
      uncertainty.push({ code: 'REMINDER_TRANSACTION_UNRESOLVED', callId: tool.callId, toolName: tool.name });
      continue;
    }
    for (const id of reminderEffectIds(tool.name, tool.value, operation)) {
      if (!effects.refs.includes(id)) effects.refs.push(id);
      effects.details.push({ kind: 'reminder-' + value.operation, reminderId: id, verified: true });
    }
    if (effects.status === 'none') effects.status = 'known';
  }
  return { effects: decode(EffectsSchema, effects, 'reminder_effects_invalid'),
    uncertainty: decode(ObjectListSchema, boundedCopy(uncertainty), 'reminder_uncertainty_invalid') };
}
function reminderToolOperation(name: string): ServiceOperation {
  if (!Object.hasOwn(PublicSchemas, name)) fail('reminder_native_tool_not_admitted');
  const operation = Object.entries(SERVICE_OPERATIONS).find(([, value]) => name === 'benson_reminder_' + value ||
    (value === 'create' && name === 'benson_reminder_create_plan'))?.[0];
  if (!serviceOperation(operation)) fail('reminder_native_tool_not_admitted');
  return operation;
}

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
  const { record, authority } = settleNativeDomainCompletion({ ...input, knownFacts, validateTool(tool, receipt) {
    if (!receipt) fail('reminder_native_receipt_missing');
    const operation = reminderToolOperation(tool.name);
    const request = parseRequest(tool.name as ToolName, receipt.executionArgs);
    if (request.operation !== operation) fail('reminder_native_arguments_mismatch');
    if (!['list-reminders', 'find-reminders'].includes(operation)) {
      if (!input.validateTool) fail('reminder_transaction_evidence_missing');
      assertion(input.validateTool(tool, receipt), 'reminder_transaction_evidence_async');
    }
    const observed = normalizeReminderServiceResult(operation, tool.value, { taskId: input.binding.taskId, pendingBinding: null, pendingExpiresAt: null });
    if (!['list-reminders', 'find-reminders'].includes(operation) && !observed.verified &&
      (effects.status !== 'possible' || !effects.reconciliation.required || !effects.reconciliation.reason ||
        !knownFacts.uncertainty.some(item => item.code === 'REMINDER_TRANSACTION_UNRESOLVED' &&
          item.callId === tool.callId && item.toolName === tool.name))) fail('reminder_uncertain_effect_omitted');
    if (observed.status !== 'success' && knownFacts.status === 'success') fail('reminder_domain_outcome_omitted');
    if (observed.warnings.some(warning => !knownFacts.warnings.some(retained => isDeepStrictEqual(boundedCopy(warning), boundedCopy(retained))))) fail('reminder_domain_warning_omitted');
    if (!['list-reminders', 'find-reminders'].includes(operation) && observed.verified) {
      const ids = reminderEffectIds(tool.name, tool.value, operation, 'reminderId' in request ? request.reminderId : undefined);
      for (const id of ids) if (!effects.refs.includes(id) ||
        !effects.details.some(effect => effect.reminderId === id && effect.kind === 'reminder-' + observed.operation)) fail('reminder_effect_omitted');
    }
  } });
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
  executionEvidence: ToolExecutionEvidenceProvider;
  /** Retained original-source/domain/terminal custody, independent of the
   * active Task invocation. It permits result consumption, never execution. */
  observe(runId: string): Observation | ReasoningObservation;
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
  await options.executionEvidence.waitForSettlement(receipt.runId, signal); current();
  const observed = synchronous(options.observe(receipt.runId), 'reminder_native_observation_must_be_synchronous');
  if (!('noTools' in observed) && [...(observed.preceding ?? []), observed].some(item => !tools.some(name => name === item.tool.name))) {
    throw new Error('reminder_native_tool_not_admitted');
  }
  const binding: Binding6 = { inputId, admissionId: inputId, conversationId: work.source.context.conversation.conversationRef,
    runId: receipt.runId, agentId: 'reminder-service', sessionKey, sessionId: 'noTools' in observed
      ? observed.terminal.sessionId ?? fail('reminder_native_terminal_identity_missing') : observed.tool.sessionId,
    domain: 'reminder', taskId: work.callId, caller, completionTarget: 'CALLER', authorizationId: inputId,
    parentContinuation: { eligible: true, reason: null }, deliveryPolicy: { eligible: false, reason: null } };
  const evidence = { ...observed, executionEvidence: options.executionEvidence.evidence(receipt.runId),
    ...options.resultVersion !== undefined ? { resultVersion: options.resultVersion } : {}, binding };
  const settled = 'noTools' in evidence ? normalizeReminderReasoningCompletion(evidence) : normalizeReminderCompletion(evidence);
  // Task invocation authority remains mandatory through production. The
  // normalized result retains its independent source/domain/native custody
  // after this invocation ends; it does not retain an execution grant.
  current(); return settled;
}

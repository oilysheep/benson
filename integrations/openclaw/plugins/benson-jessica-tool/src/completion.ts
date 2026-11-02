import { parseReadRequest, parseExecuteRequest, EXECUTE_OPERATIONS } from '../../../../../agents/jessica-vacuum/lib/schemas.js';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.js';
import type { CurrentRequestProjection } from '../../../benson-routing/core/conversation-context.js';
import { isDeepStrictEqual as same } from 'node:util';
import type { OpenClawPluginToolFactory, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { settleNativeDomainCompletion, type NativeDomainCompletionInput } from '../../../benson-routing/core/completion.js';
import { createCompletionDomainResult, createCompletionDomainResultV3 } from '../../../benson-routing/core/domain-result.js';
import { normalizeLegacyTaskResult } from '../../../benson-routing/core/legacy-response.js';
import { boundedCopy, synchronous, decode, object, IdentifierSchema, fail, plain, assertion } from '../../../benson-routing/core/value.js';

/** Domain normalization and effect ownership stay here; the existing Completion
 * owner validates native observations and reconstructs failed reporting.
 */
export function normalizeJessicaCompletion(input: Omit<NativeDomainCompletionInput, 'tool'> & {
  tool: NativeDomainCompletionInput['tool'] & { name: 'jessica_read' | 'jessica_execute' };
  resultVersion?: 2 | 3;
  projectEffects?: NonNullable<Parameters<typeof createCompletionDomainResult>[2]>['projectEffects'];
  /** Private original-source custody for unverified semantic proposals. This
   * validates a question/refusal, never authorizes an action or continuation. */
  semantic?: { source: CurrentRequestProjection; clock(): Date; assertCurrent(): unknown };
}) {
  const project = input.resultVersion === 3 ? createCompletionDomainResultV3 :
    input.resultVersion === undefined || input.resultVersion === 2 ? createCompletionDomainResult : fail('domain_result_version');
  const facts = structuredClone(input.knownFacts), originalBinding = structuredClone(input.binding);
  const trusted = { taskId: input.binding.taskId,
    pendingBinding: facts.pendingContext?.binding ?? null, pendingExpiresAt: facts.pendingContext?.expiresAt ?? null };
  const native = normalizeLegacyTaskResult(input.tool.value, trusted);
  let value = native;
  const keys = ['domain', 'domainSchemaVersion', 'operation', 'status', 'verified', 'data', 'warnings', 'error', 'pendingContext'] as const;
  const semantic = input.semantic;
  const originalSource = semantic && structuredClone(semantic.source.context);
  const semanticClock = semantic?.clock.bind(semantic), assertSource = semantic?.assertCurrent.bind(semantic);
  const assertSemanticCurrent = () => {
    if (!semantic) return;
    if (!semanticClock || !assertSource) fail('jessica_semantic_source_mismatch');
    assertion(assertSource(), 'jessica_semantic_source_async');
    const source = semantic.source;
    if (source.status !== 'available' || source.scope !== 'current-request-only' ||
      !same(source.context, originalSource) || source.context.current.entryId !== originalBinding.inputId ||
      source.context.conversation.conversationRef !== originalBinding.conversationId ||
      source.context.current.sender?.id !== source.context.conversation.requesterId ||
      !Number.isFinite(semanticClock().getTime())) fail('jessica_semantic_source_mismatch');
    const pending = facts.pendingContext;
    if (pending && (pending.binding.requesterId !== source.context.conversation.requesterId ||
      pending.binding.conversationId !== originalBinding.conversationId || Date.parse(pending.expiresAt) <= semanticClock().getTime())) {
      fail('jessica_semantic_pending_unavailable');
    }
  };
  if (keys.some(key => !same(boundedCopy(Reflect.get(native, key)), boundedCopy(Reflect.get(facts, key))))) {
    if (!semantic || !semanticClock) fail('jessica_native_completion_unverified');
    assertSemanticCurrent();
    const now = semanticClock(), tool = validateResult(input.tool.value, null, now);
    const proposal = validateResult({ schemaVersion: facts.domainSchemaVersion, domain: facts.domain,
      operation: facts.operation, status: facts.status, verified: facts.verified, data: facts.data,
      warnings: facts.warnings, error: facts.error, pendingContext: facts.pendingContext?.value ?? null }, null, now);
    if (input.tool.name !== 'jessica_read' || tool.status !== 'success' ||
      [...input.preceding ?? [], input].some(item => item.tool.name !== 'jessica_read') ||
      facts.verified !== false || facts.verificationScope.length || facts.effects.length || facts.uncertainty.length ||
      !same(boundedCopy(proposal.warnings), boundedCopy(tool.warnings))) fail('jessica_semantic_execution_claim');
    if ([...input.preceding ?? [], input].some(item => validateResult(item.tool.value, null, now).status !== 'success')) {
      fail('jessica_semantic_read_failure_omitted');
    }
    if (proposal.status === 'clarification_required') {
      if (proposal.operation !== 'clean' || tool.operation !== 'rooms' || !tool.data || !('kind' in tool.data) || tool.data.kind !== 'rooms' ||
        !proposal.data || !('question' in proposal.data) || !proposal.pendingContext ||
        !facts.pendingContext || facts.pendingContext.expiresAt !== proposal.pendingContext.expiresAt ||
        !['איזה חדר התכוונת?', 'Which room did you mean?'].includes(proposal.data.question)) fail('jessica_semantic_room_evidence');
      const rooms = new Map(tool.data.rooms.filter(room => room.enabled).map(room => [room.slug, room.label]));
      const candidates = proposal.data.candidates;
      if (new Set(candidates.map(item => item.room)).size !== candidates.length ||
        candidates.some(item => rooms.get(item.room) !== item.label)) fail('jessica_semantic_room_candidates');
    } else if (proposal.status === 'failure') {
      const error = proposal.error;
      if (!EXECUTE_OPERATIONS.some(operation => operation === proposal.operation) || proposal.data !== null ||
        proposal.pendingContext !== null || !error || error.code !== 'CONTROL_NOT_ENABLED' ||
        error.stage !== 'precondition' || error.retryable || error.sideEffects !== 'none' || error.retryMode !== 'none' ||
        tool.operation !== 'capabilities' || !tool.data || !('capabilities' in tool.data) ||
        tool.data.capabilities.some(capability => capability.support === 'verified' &&
          (EXECUTE_OPERATIONS.some(operation => operation === capability.name) || capability.name.startsWith('clean_')))) {
        fail('jessica_semantic_capability_evidence');
      }
    } else fail('jessica_semantic_outcome_invalid');
    value = normalizeLegacyTaskResult(proposal, trusted);
  }
  if (input.binding.domain !== 'jessica-vacuum' || input.binding.agentId !== 'jessica-vacuum' || value.domain !== input.binding.domain ||
    keys.some(key => !same(boundedCopy(Reflect.get(value, key)), boundedCopy(Reflect.get(facts, key))))) throw new Error('jessica_native_completion_unverified');
  const sourceCustody = input.custody;
  const { record, authority } = settleNativeDomainCompletion({ ...input, knownFacts: facts, custody: { assertCurrent(binding) {
    assertSemanticCurrent(); return sourceCustody.assertCurrent(binding);
  } }, validateTool(tool, receipt) {
    if (!receipt) fail('jessica_native_receipt_missing');
    if (tool.name !== 'jessica_read' && tool.name !== 'jessica_execute') fail('jessica_native_tool_not_admitted');
    const observed = normalizeLegacyTaskResult(tool.value, { taskId: input.binding.taskId,
      pendingBinding: facts.pendingContext?.binding ?? null, pendingExpiresAt: facts.pendingContext?.expiresAt ?? null });
    const request = tool.name === 'jessica_read' ? parseReadRequest(receipt.executionArgs) : parseExecuteRequest(receipt.executionArgs);
    if (observed.status !== 'success' && facts.status === 'success') fail('jessica_domain_outcome_omitted');
    if (observed.warnings.some(warning => !facts.warnings.some(retained => same(boundedCopy(warning), boundedCopy(retained))))) fail('jessica_domain_warning_omitted');
    if (request.operation !== observed.operation) fail('jessica_native_arguments_mismatch');
    if (tool.name === 'jessica_execute') {
      if (!input.validateTool) fail('jessica_operation_evidence_missing');
      assertion(input.validateTool(tool, receipt), 'jessica_operation_evidence_async');
      const id = plain(observed.data) && 'operationId' in observed.data ? observed.data.operationId : null;
      if (typeof id === 'string' && observed.error?.sideEffects !== 'none' &&
          !facts.effects.some(effect => effect.operationId === id)) fail('jessica_operation_effect_omitted');
      if (observed.error && observed.error.sideEffects !== 'none' && !facts.effects.length && !facts.uncertainty.length) fail('jessica_operation_uncertainty_omitted');
    }
    if (observed.domain !== 'jessica-vacuum' || (tool.name === 'jessica_read'
      ? !['status', 'rooms', 'capabilities', 'maintenance', 'statistics', 'room_settings', 'operation_status'].includes(observed.operation ?? '')
      : !['clean', 'pause', 'dock'].includes(observed.operation ?? ''))) fail('jessica_native_tool_result_mismatch');
  } });
  const result = project(record, authority, { expectedRunId: input.binding.runId,
    ...record.completion.outcome === 'NORMAL' ? { expectedTaskResult: value } : {},
    ...input.projectEffects ? { projectEffects: input.projectEffects } : {} });
  return { record, authority, result };
}

type Tool = Exclude<NonNullable<ReturnType<OpenClawPluginToolFactory<2>['create']>>, unknown[]>;
const parameters = object({ runId: IdentifierSchema });
/** Same optional Main tool name as the retained plugin. Native acquisition is
 * private host work using run/wait and observations, not runtime.tasks or DTO
 * authority. This factory performs no registration or transcript writes.
 */
export function createJessicaCompletionToolFactory(options: {
  resultVersion?: 2 | 3;
  readNativeCompletion(runId: string, context: OpenClawPluginToolContext<2>): Promise<Parameters<typeof normalizeJessicaCompletion>[0]>;
  jsonResult(value: { validated: true; result: ReturnType<typeof normalizeJessicaCompletion>['result'] }): Awaited<ReturnType<Tool['execute']>>;
}): OpenClawPluginToolFactory<2>['create'] {
  return context => {
    if (context.agentId !== 'main' || typeof context.assertInvocationCurrent !== 'function') return null;
    const attempted = new Set<string>();
    return { name: 'jessica_validate_completion', label: 'Validate Jessica completion',
      description: 'Validate a controlled Jessica Run against native evidence before returning domain truth.',
      parameters, executionMode: 'sequential',
      async execute(_callId, raw, signal) {
        const current = () => { signal?.throwIfAborted(); synchronous(context.assertInvocationCurrent(), 'completion_native_authority_must_be_synchronous'); signal?.throwIfAborted(); };
        current(); const request = decode(parameters, raw, 'completion_run_id_invalid');
        if (attempted.has(request.runId)) throw new Error('completion_already_attempted');
        attempted.add(request.runId);
        const input = await options.readNativeCompletion(request.runId, context); current();
        const caller = input.binding.caller;
        if (input.binding.runId !== request.runId || input.binding.completionTarget !== 'CALLER' || caller?.agentId !== 'main' ||
          !context.sessionKey || !context.sessionId || caller.sessionKey !== context.sessionKey || caller.sessionId !== context.sessionId) {
          throw new Error('completion_native_caller_mismatch');
        }
        const assertSourceCurrent = input.custody.assertCurrent.bind(input.custody);
        const value = normalizeJessicaCompletion({ ...input, ...options.resultVersion !== undefined ? { resultVersion: options.resultVersion } : {}, custody: { assertCurrent(binding) { current(); return assertSourceCurrent(binding); } } });
        current();
        const result = synchronous(options.jsonResult({ validated: true, result: value.result }), 'completion_serialization_must_be_synchronous');
        current(); return result;
      } };
  };
}

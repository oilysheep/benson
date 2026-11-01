import { isDeepStrictEqual as same } from 'node:util';
import type { OpenClawPluginToolFactory, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { settleNativeDomainCompletion, type NativeDomainCompletionInput } from '../../../benson-routing/core/completion.js';
import { createCompletionDomainResult, createCompletionDomainResultV3 } from '../../../benson-routing/core/domain-result.js';
import { normalizeLegacyTaskResult } from '../../../benson-routing/core/legacy-response.js';
import { boundedCopy, synchronous, decode, object, IdentifierSchema, fail } from '../../../benson-routing/core/value.js';

/** Domain normalization and effect ownership stay here; the existing Completion
 * owner validates native observations and reconstructs failed reporting.
 */
export function normalizeJessicaCompletion(input: Omit<NativeDomainCompletionInput, 'tool'> & {
  tool: NativeDomainCompletionInput['tool'] & { name: 'jessica_read' | 'jessica_execute' };
  resultVersion?: 2 | 3;
  projectEffects?: NonNullable<Parameters<typeof createCompletionDomainResult>[2]>['projectEffects'];
}) {
  const project = input.resultVersion === 3 ? createCompletionDomainResultV3 :
    input.resultVersion === undefined || input.resultVersion === 2 ? createCompletionDomainResult : fail('domain_result_version');
  const facts = input.knownFacts;
  const value = normalizeLegacyTaskResult(input.tool.value, { taskId: input.binding.taskId,
    pendingBinding: facts.pendingContext?.binding ?? null, pendingExpiresAt: facts.pendingContext?.expiresAt ?? null });
  if (input.binding.domain !== 'jessica-vacuum' || input.binding.agentId !== 'jessica-vacuum' || value.domain !== input.binding.domain ||
    ['domain', 'domainSchemaVersion', 'operation', 'status', 'verified', 'data', 'warnings', 'error', 'pendingContext'].some(key =>
      !same(boundedCopy(Reflect.get(value, key)), boundedCopy(Reflect.get(facts, key))))) throw new Error('jessica_native_completion_unverified');
  const { record, authority } = settleNativeDomainCompletion(input);
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

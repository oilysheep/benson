import Type, { type Static } from 'typebox';
import { ExecutionRouteSchema, TaskResultSchema, ResponseSchema, RenderedOutputSchema,
  ResponsePolicySchema, ResponseLifecycleSchema, NativeCompletionSchema, ParentSessionSchema,
  ResponseSourceSchema, LegacyResultSchema, LegacyJessicaSchema, LegacyTrustedSchema, DOMAIN_VERSIONS,
  DOMAIN_AGENTS, type TaskResult, type Response, type ResponseLifecycle, type RenderedOutput } from './contracts.js';
import { object, IdentifierSchema, candidate, exact, fail,
  freeze, identifier, plain, pending, read, timestamp, MAX_RESPONSE_RESULTS, MAX_RENDERED_TEXT } from './value.js';

function policy(raw: unknown): Static<typeof ResponsePolicySchema> {
  exact(raw, Object.keys(ResponsePolicySchema.properties), 'policy_shape');
  const value = read(ResponsePolicySchema, raw, 'policy_invalid');
  if (!value.allowedModes.includes(value.preferredMode)) fail('policy_invalid');
  return { allowedModes: [...value.allowedModes], preferredMode: value.preferredMode };
}
export function createExecutionRoute(raw: unknown) {
  exact(raw, Object.keys(ExecutionRouteSchema.properties), 'route_shape');
  const value = read(ExecutionRouteSchema, raw, 'route_invalid');
  if (!identifier(value.requestId) || !identifier(value.executionOwner) ||
      (value.completionTarget === 'CALLER' ? !identifier(value.callerRunId) : value.callerRunId !== null)) fail('route_invalid');
  return freeze({ ...value, responsePolicy: policy(value.responsePolicy) });
}
export function completionRoute(raw: unknown) {
  const { responsePolicy: _policy, ...route } = createExecutionRoute(raw); return freeze(route);
}
export function validateTaskResultEnvelope(raw: unknown): TaskResult {
  exact(raw, Object.keys(TaskResultSchema.properties), 'task_result_shape');
  // Preserve JSON rejection codes before structural schema checking.
  const value = read(TaskResultSchema, raw, 'task_result_invalid');
  if (!identifier(value.domainSchemaVersion) || !identifier(value.taskId) || DOMAIN_VERSIONS[value.domain] !== value.domainSchemaVersion ||
      (value.operation !== null && !identifier(value.operation)) ||
      (value.status === 'success' && (!value.verified || value.error !== null || value.pendingContext !== null)) ||
      (value.status === 'clarification_required' && (value.verified || value.error !== null || value.pendingContext === null)) ||
      (value.status === 'failure' && value.error === null)) fail('task_result_invalid');
  return freeze({ ...value, pendingContext: pending(value.pendingContext), messageCandidate: candidate(value.messageCandidate) });
}
export function normalizeLegacyTaskResult(raw: unknown, trusted: unknown, messageCandidate: unknown = null): TaskResult {
  if (!plain(raw)) fail('legacy_result_shape');
  const isJessica = Object.getOwnPropertyDescriptor(raw, 'domain')?.value === 'jessica-vacuum';
  exact(raw, Object.keys(isJessica ? LegacyJessicaSchema.properties : LegacyResultSchema.properties), 'legacy_result_shape');
  exact(trusted, Object.keys(LegacyTrustedSchema.properties), 'legacy_trusted_shape');
  if (!identifier(trusted.taskId) || (isJessica ? raw.schemaVersion !== '1' : raw.domain !== 'reminder')) fail('legacy_version_or_domain');
  if (raw.pendingContext !== null && (!trusted.pendingBinding || !timestamp(trusted.pendingExpiresAt) ||
      (isJessica && (typeof raw.pendingContext !== 'object' || !raw.pendingContext ||
        !('expiresAt' in raw.pendingContext) || raw.pendingContext.expiresAt !== trusted.pendingExpiresAt)))) fail('legacy_pending_binding_required');
  return validateTaskResultEnvelope({ schemaVersion: 1, domainSchemaVersion: isJessica ? '1' : 'legacy-unversioned',
    taskId: trusted.taskId, status: raw.status, domain: raw.domain, operation: raw.operation, verified: raw.verified,
    data: raw.data, warnings: raw.warnings, error: raw.error, pendingContext: raw.pendingContext === null ? null : {
      schemaVersion: 1, value: raw.pendingContext, binding: trusted.pendingBinding, expiresAt: trusted.pendingExpiresAt }, messageCandidate });
}
export function deriveResponseStatus(raw: unknown): Response['status'] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RESPONSE_RESULTS) fail('response_results_count');
  const statuses = raw.map((value: unknown) => validateTaskResultEnvelope(value).status);
  const first = statuses[0]; if (!first) fail('response_results_count');
  return statuses.every(status => status === first) ? first : 'partial';
}
function lifecycle(value: unknown): ResponseLifecycle {
  const result = read(ResponseLifecycleSchema, value, 'response_lifecycle_shape');
  return { domainExecution: result.domainExecution, failure: result.failure === null ? null : { ...result.failure } };
}
export function deriveResponseStatusWithLifecycle(results: readonly TaskResult[], rawLifecycle: unknown): Response['status'] {
  const value = lifecycle(rawLifecycle);
  if (results.length === 0) return value.failure === null ? 'success' : 'failure';
  const status = deriveResponseStatus(results);
  return value.failure === null ? status : results.some(result => result.status !== 'failure') ? 'partial' : 'failure';
}
export function validateResponseEnvelope(raw: unknown): Response {
  exact(raw, Object.keys(ResponseSchema.properties), 'response_shape');
  exact(raw.source, ['type', 'agentId', 'runId'], 'source_shape');
  exact(raw.provenance, ['executionVerified', 'completionCorrelated'], 'provenance_shape');
  const value = read(ResponseSchema, raw, 'response_invalid');
  if (![value.requestId, value.source.agentId, value.source.runId].every(identifier)) fail('response_invalid');
  const results = value.results.map(validateTaskResultEnvelope);
  const facts = lifecycle(value.lifecycle);
  if (new Set(results.map(result => result.taskId)).size !== results.length) fail('duplicate_task_result');
  if (!results.length) {
    if (value.provenance.completionCorrelated || value.pendingContext !== null || value.status !== deriveResponseStatusWithLifecycle(results, facts) ||
      (facts.failure === null && (value.source.type !== 'main' || facts.domainExecution !== 'none' || value.provenance.executionVerified !== 'not_applicable')) ||
      (facts.failure !== null && value.provenance.executionVerified !== (facts.domainExecution === 'none' ? 'not_applicable' : false))) fail('no_domain_result_invalid');
  } else if (facts.domainExecution === 'none' || value.status !== deriveResponseStatusWithLifecycle(results, facts) ||
    value.provenance.executionVerified !== results.every(result => result.verified) || !value.provenance.completionCorrelated ||
    (value.source.type === 'direct' && results.length !== 1)) fail('response_results_invalid');
  const contexts = results.flatMap(result => result.pendingContext === null ? [] : [result.pendingContext]);
  if (contexts.length > 1 || (contexts.length === 0 ? value.pendingContext !== null :
    JSON.stringify(value.pendingContext) !== JSON.stringify(contexts[0]))) fail('response_pending_mismatch');
  return freeze({ ...value, results, lifecycle: facts, pendingContext: pending(value.pendingContext),
    messageCandidate: candidate(value.messageCandidate), responsePolicy: policy(value.responsePolicy) });
}
export function validateRenderedOutput(raw: unknown): RenderedOutput {
  exact(raw, ['schemaVersion', 'message'], 'rendered_shape');
  const value = read(RenderedOutputSchema, raw, 'rendered_invalid');
  if (value.message.length > MAX_RENDERED_TEXT) fail('rendered_invalid'); return freeze({ ...value });
}
export function createResponseEnvelope(candidateInput: unknown, trusted: unknown): Response {
  exact(candidateInput, ['messageCandidate'], 'response_candidate_shape');
  exact(trusted, Object.keys(ResponseSchema.properties).filter(key => !['schemaVersion', 'messageCandidate'].includes(key)), 'response_trusted_shape');
  return validateResponseEnvelope({ schemaVersion: 2, ...trusted, messageCandidate: candidateInput.messageCandidate });
}
const TrustedSourceSchema = { requestId: IdentifierSchema, source: ResponseSourceSchema, parentSession: ParentSessionSchema,
  responsePolicy: ResponsePolicySchema };
const MainTrustedSchema = object({ ...TrustedSourceSchema, completions: Type.Array(NativeCompletionSchema, { maxItems: MAX_RESPONSE_RESULTS }),
  lifecycle: ResponseLifecycleSchema });
const DirectTrustedSchema = object(TrustedSourceSchema);
const DirectFailureTrustedSchema = object({ ...TrustedSourceSchema, lifecycle: ResponseLifecycleSchema });
function completionFacts(raw: unknown, requestId: string, parent: Static<typeof ParentSessionSchema>, destination: 'CALLER' | 'RESPONSE_CONTROLLER') {
  const value = read(Type.Array(NativeCompletionSchema, { maxItems: MAX_RESPONSE_RESULTS }), raw, 'response_completions_count');
  const seenRuns = new Set<string>();
  const results = value.map(completion => {
    const { binding: b, admission: a } = completion;
    if (b.requestId !== requestId || b.parentSessionKey !== parent.sessionKey || b.parentSessionId !== parent.sessionId ||
      (destination === 'CALLER' ? !identifier(b.parentRunId) : b.parentRunId !== null) ||
      ![b.childRunId, b.childSessionKey, b.executionOwner].every(identifier) ||
      !b.childSessionKey.startsWith(`agent:${b.executionOwner}:subagent:`) || b.completionTarget !== destination ||
      (destination === 'CALLER' ? b.callerRunId !== b.parentRunId : b.callerRunId !== null)) fail('completion_binding_mismatch');
    if (a.requestId !== requestId || a.childRunId !== b.childRunId || !identifier(a.taskId) ||
      a.destination !== destination || a.callerRunId !== b.callerRunId) fail('completion_admission_mismatch');
    const result = validateTaskResultEnvelope(a.result);
    if (result.taskId !== a.taskId || DOMAIN_AGENTS[result.domain] !== b.executionOwner) fail('completion_result_mismatch');
    if (seenRuns.has(b.childRunId)) fail('duplicate_completion_run'); seenRuns.add(b.childRunId); return result;
  });
  if (new Set(results.map(result => result.taskId)).size !== results.length) fail('duplicate_task_result');
  const contexts = results.flatMap(result => result.pendingContext === null ? [] : [result.pendingContext]);
  if (contexts.length > 1) fail('response_pending_ambiguous');
  const executionVerified: boolean | 'not_applicable' = results.length ? results.every(result => result.verified) : 'not_applicable';
  return { results, pendingContext: contexts[0] ?? null, provenance: { executionVerified, completionCorrelated: results.length > 0 } };
}
function sourceIds(source: Static<typeof ResponseSourceSchema>, parent: Static<typeof ParentSessionSchema>, requestId: string): boolean {
  return [requestId, source.agentId, source.runId, parent.sessionKey, parent.sessionId].every(identifier);
}
export function createMainResponseEnvelope(candidateInput: unknown, raw: unknown): Response {
  exact(raw, Object.keys(MainTrustedSchema.properties), 'main_finalization_shape');
  if (!Array.isArray(raw.completions) || raw.completions.length > MAX_RESPONSE_RESULTS) fail('response_completions_count');
  const value = read(MainTrustedSchema, raw, 'main_finalization_source');
  if (value.source.type !== 'main' || value.source.agentId !== 'main' || !sourceIds(value.source, value.parentSession, value.requestId)) fail('main_finalization_source');
  const facts = completionFacts(value.completions, value.requestId, value.parentSession, 'CALLER');
  return createResponseEnvelope(candidateInput, { requestId: value.requestId, source: value.source,
    status: deriveResponseStatusWithLifecycle(facts.results, value.lifecycle), results: facts.results, pendingContext: facts.pendingContext,
    lifecycle: value.lifecycle, responsePolicy: value.responsePolicy, provenance: { ...facts.provenance,
      executionVerified: !facts.results.length && value.lifecycle.domainExecution !== 'none' ? false : facts.provenance.executionVerified } });
}
export function createDirectResponseEnvelope(rawCompletion: unknown, rawTrusted: unknown): Response {
  exact(rawTrusted, Object.keys(DirectTrustedSchema.properties), 'direct_finalization_shape');
  const value = read(DirectTrustedSchema, rawTrusted, 'direct_finalization_source');
  if (value.source.type !== 'direct' || !sourceIds(value.source, value.parentSession, value.requestId)) fail('direct_finalization_source');
  const completion = read(NativeCompletionSchema, rawCompletion, 'native_completion_shape');
  const facts = completionFacts([completion], value.requestId, value.parentSession, 'RESPONSE_CONTROLLER');
  const result = facts.results[0];
  if (!result || value.source.runId !== completion.binding.childRunId || value.source.agentId !== completion.binding.executionOwner) fail('direct_finalization_source');
  return createResponseEnvelope({ messageCandidate: result.messageCandidate }, { requestId: value.requestId, source: value.source,
    status: result.status, results: facts.results, pendingContext: facts.pendingContext, responsePolicy: value.responsePolicy,
    provenance: facts.provenance, lifecycle: { domainExecution: 'attempted', failure: null } });
}
export function createDirectFailureResponseEnvelope(raw: unknown): Response {
  exact(raw, Object.keys(DirectFailureTrustedSchema.properties), 'direct_failure_shape');
  const value = read(DirectFailureTrustedSchema, raw, 'direct_failure_session');
  if (![value.parentSession.sessionKey, value.parentSession.sessionId].every(identifier)) fail('direct_failure_session');
  return createResponseEnvelope({ messageCandidate: null }, { requestId: value.requestId, source: value.source, status: 'failure',
    results: [], pendingContext: null, responsePolicy: value.responsePolicy, provenance: {
      executionVerified: value.lifecycle.domainExecution === 'none' ? 'not_applicable' : false, completionCorrelated: false }, lifecycle: value.lifecycle });
}
export function assertPendingContextBinding(value: unknown, trusted: unknown, now = new Date()) {
  exact(trusted, ['requesterId', 'conversationId'], 'pending_trusted_shape');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('pending_clock_invalid');
  const normalized = pending(value);
  if (normalized === null || normalized.binding.requesterId !== trusted.requesterId || normalized.binding.conversationId !== trusted.conversationId ||
    Date.parse(normalized.expiresAt) <= now.getTime()) fail('pending_binding_or_expiry');
  return freeze(normalized);
}

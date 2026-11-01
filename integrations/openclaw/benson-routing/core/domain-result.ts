import { type Static } from 'typebox';
import { isDeepStrictEqual as same } from 'node:util';
import { DomainResultSchema, DomainResultV3Schema, FactsSchema, FACT_KEYS, type DomainResult, type DomainResultV3,
  type AnyDomainResult, type Effects, type Admission, type NoRunOutcome } from './contracts.js';
import { validateCompletion } from './completion.js';
import { validateRenderedOutput, validateTaskResultEnvelope } from './legacy-response.js';
import { type SourceAdmissionController } from './request-control.js';
import { assertion, boundedCopy, exact, fail, freeze, gaps, identifier, object, pending, read, synchronous,
  timestamp, userResponse, MAX_RENDERED_TEXT, IdentifierSchema, MAX_DOMAIN_RESULT_V3_BYTES, nullable, UserResponseSchema, GapsSchema } from './value.js';
export const DOMAIN_RESULT_OUTPUT_SCHEMA = freeze(DomainResultSchema);
export const DOMAIN_RESULT_V3_OUTPUT_SCHEMA = freeze(DomainResultV3Schema);
export { MAX_DOMAIN_RESULT_V3_BYTES } from './value.js';
export { DOMAIN_RESULT_SCHEMA_VERSION } from './contracts.js';
export function validateDomainResult(raw: unknown): DomainResult {
  const value = read(DomainResultSchema, raw, 'domain_result_shape');
  return validateSemantics(value);
}
/** Explicit version dispatch; the existing v2 reader remains strict. */
export function validateDomainResultEnvelope(raw: unknown): AnyDomainResult {
  exact(raw, Object.keys(DomainResultSchema.properties), 'domain_result_shape');
  return raw.schemaVersion === 3 ? validateDomainResultV3(raw) : validateDomainResult(raw);
}
function validateSemantics<T extends AnyDomainResult>(value: T): T {
  if (!identifier(value.domain) || (value.domainSchemaVersion !== null && !identifier(value.domainSchemaVersion)) ||
      (value.operation !== null && !identifier(value.operation))) fail('domain_result_identity');
  const { verified, verificationScope } = value.facts;
  if (!verificationScope.every(identifier)) fail('domain_result_verification');
  gaps(value.evidence.gaps);
  const missing = (key: string) => value.evidence.gaps.some(gap => gap.code === 'FACT_NOT_ESTABLISHED' && gap.path === `facts.${key}`);
  for (const observation of value.evidence.observations) {
    if ((observation.ref !== null && !identifier(observation.ref)) ||
      (observation.observedAt !== null && !timestamp(observation.observedAt)) ||
      (observation.freshness === 'fresh' && (observation.ref === null || observation.observedAt === null))) fail('domain_result_observation');
  }
  if (value.domainSchemaVersion === null && !missing('domainSchemaVersion')) fail('domain_result_version_missing');
  pending(value.pendingContext);
  const handling = value.failures.handling;
  if (handling !== null && (!identifier(handling.code) || handling.message.length > MAX_RENDERED_TEXT)) fail('domain_result_handling');
  const effects = value.effects;
  if (!effects.refs.every(identifier)) fail('domain_result_effects');
  if ((effects.reconciliation.required ? !identifier(effects.reconciliation.reason) : effects.reconciliation.reason !== null) ||
      (effects.status === 'possible' && !effects.reconciliation.required) ||
      (effects.status === 'none' && (effects.refs.length || effects.details.length || effects.reconciliation.required)) ||
      (effects.status === 'known' && !effects.refs.length && !effects.details.length) ||
      (missing('effects') && effects.status !== 'possible')) fail('domain_result_effects_evidence');
  if (verified === true && !verificationScope.length && !missing('verificationScope')) fail('domain_result_verification_scope');
  const status = value.outcome.status;
  if ((status === 'success' && (value.failures.domain !== null || value.pendingContext !== null || (verified !== true && !missing('verified')))) ||
    (status === 'failure' && value.failures.domain === null && handling === null && !missing('error')) ||
    (status === 'clarification_required' && (value.failures.domain !== null || (value.pendingContext === null && !missing('pendingContext')) ||
      (verified !== false && !missing('verified')))) ||
    (status === 'unknown' && !value.uncertainty.length && !value.evidence.gaps.length) ||
    (status === 'not_applicable' && verified !== 'not_applicable' && !missing('verified')) ||
    (verified === 'not_applicable' && (verificationScope.length || (effects.status !== 'none' && !missing('effects'))))) fail('domain_result_semantics');
  const suppressed = value.outcome.disposition === 'suppressed' || value.outcome.disposition === 'reasoning-required';
  if ((value.content === null) !== suppressed) fail('domain_result_content_suppression');
  if (value.content !== null) userResponse(value.content);
  return freeze(value);
}
const NormalizedFactsSchema = object({ ...FactsSchema.properties, domain: IdentifierSchema });
type NormalizedFacts = Static<typeof NormalizedFactsSchema>;
const InheritedSchema = object({ facts: NormalizedFactsSchema, userResponse: nullable(UserResponseSchema),
  completion: object({ gaps: GapsSchema }) });
/** Neither budget may borrow from the other. The inherited projection is a
 * subset of a leaf Completion after trusted domain normalization, at the same
 * JSON depth. Removed routing/syntax bytes cover the at-most-12-byte null-to-
 * bound-domain increase when a FAILED record has a missing-domain gap. Metadata uses
 * placeholders for disjoint inherited leaves; restoring them adds at most the
 * inherited bytes. No authoritative value is duplicated in the wire envelope.
 */
export function validateDomainResultV3(raw: unknown): DomainResultV3 {
  exact(raw, Object.keys(DomainResultV3Schema.properties), 'domain_result_shape');
  for (const [key, fields] of Object.entries({ facts: ['verified', 'verificationScope', 'data'],
    outcome: ['disposition', 'status'], evidence: ['observations', 'gaps'], failures: ['domain', 'handling'],
    effects: ['status', 'refs', 'details', 'reconciliation'] })) exact(raw[key], fields, 'domain_result_shape');
  const facts = raw.facts as Record<string, unknown>, outcome = raw.outcome as Record<string, unknown>;
  const evidence = raw.evidence as Record<string, unknown>, failures = raw.failures as Record<string, unknown>;
  const effects = raw.effects as Record<string, unknown>;
  const inherited = read(InheritedSchema, { facts: { ...facts, status: outcome.status,
    domain: raw.domain, domainSchemaVersion: raw.domainSchemaVersion, operation: raw.operation,
    warnings: raw.warnings, error: failures.domain, effects: effects.details,
    uncertainty: raw.uncertainty, pendingContext: raw.pendingContext }, userResponse: raw.content,
    completion: { gaps: evidence.gaps } }, 'domain_result_payload');
  const metadata = read(DomainResultV3Schema, { ...raw,
    facts: { ...facts, data: null, verificationScope: [] }, evidence: { ...evidence, gaps: [] }, warnings: [],
    failures: { ...failures, domain: null }, effects: { ...effects, details: [] }, uncertainty: [], pendingContext: null, content: null },
  'domain_result_metadata');
  const f = inherited.facts;
  const value: DomainResultV3 = { ...metadata, facts: { verified: f.verified, verificationScope: f.verificationScope, data: f.data },
    evidence: { ...metadata.evidence, gaps: inherited.completion.gaps }, warnings: f.warnings,
    failures: { ...metadata.failures, domain: f.error }, effects: { ...metadata.effects, details: f.effects },
    uncertainty: f.uncertainty, pendingContext: f.pendingContext, content: inherited.userResponse };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_DOMAIN_RESULT_V3_BYTES) fail('json_bytes_exceeded');
  return validateSemantics(value);
}
function fromFacts(facts: NormalizedFacts, executionMode: DomainResult['executionMode'], disposition: DomainResult['outcome']['disposition'],
  evidence: DomainResult['evidence'], handling: DomainResult['failures']['handling'], effects: unknown, content: DomainResult['content'],
  schemaVersion: 2 | 3 = 2): AnyDomainResult {
  return validateDomainResultEnvelope({ schemaVersion, kind: 'benson.domain-result', executionMode,
    domain: facts.domain, domainSchemaVersion: facts.domainSchemaVersion, operation: facts.operation,
    outcome: { disposition, status: facts.status }, facts: { verified: facts.verified, verificationScope: facts.verificationScope, data: facts.data },
    evidence, warnings: facts.warnings, failures: { domain: facts.error, handling }, effects, uncertainty: facts.uncertainty,
    pendingContext: facts.pendingContext, content });
}
export interface NoRunResultOptions<A extends Admission> {
  controller: SourceAdmissionController<A>; admission: A; normalizeFacts(value: NoRunOutcome['evidence']['facts']): unknown;
  language: 'en' | 'he';
}
export function createNoRunDomainResult<A extends Admission>(response: unknown, options?: NoRunResultOptions<A>): DomainResult {
  if (typeof options?.controller?.validateOutcome !== 'function' || typeof options.controller.assertCurrent !== 'function' ||
    typeof options.normalizeFacts !== 'function' || !['en', 'he'].includes(options.language)) fail('domain_result_read_dependencies');
  exact(response, ['mode', 'outcome', 'rendered'], 'domain_result_response_shape');
  const { controller, admission, normalizeFacts, language } = options;
  const outcome = synchronous(controller.validateOutcome(admission, response.outcome), 'domain_result_validator_must_be_synchronous');
  if (outcome.schemaVersion !== 2 && outcome.schemaVersion !== 3) fail('domain_result_read_version');
  const suppressed = outcome.disposition === 'suppressed' || outcome.disposition === 'reasoning-required';
  if (response.mode !== (suppressed ? 'suppressed' : 'deterministic') || (response.rendered === null) !== suppressed) fail('domain_result_response_mode');
  const normalized = synchronous(normalizeFacts(outcome.evidence.facts), 'domain_result_normalizer_must_be_synchronous');
  exact(normalized, FACT_KEYS, 'domain_result_normalized_facts_shape');
  const facts = read(NormalizedFactsSchema, normalized, 'domain_result_read_facts_mismatch');
  if (facts.domain !== admission.domain || facts.effects.length) fail('domain_result_read_facts_mismatch');
  const rendered = suppressed ? null : validateRenderedOutput(response.rendered);
  const result = fromFacts(facts, 'deterministic', outcome.disposition, { observations: [{ ref: outcome.evidence.ref,
    observedAt: outcome.evidence.observedAt, freshness: outcome.evidence.freshness }], gaps: [] }, outcome.error,
    { ...outcome.effects, details: [], reconciliation: outcome.reconciliation },
    rendered === null ? null : { state: 'usable', text: rendered.message, language });
  assertion(controller.assertCurrent(admission), 'source_authority_must_be_synchronous');
  return result as DomainResult;
}
export interface CompletionResultOptions {
  projectEffects?(effects: readonly DomainResult['effects']['details'][number][]): unknown;
  expectedTaskResult?: unknown; expectedRunId?: string;
}
export function createCompletionDomainResult(raw: unknown, authority: unknown, options: CompletionResultOptions = {}): DomainResult {
  return completionResult(raw, authority, options, 2) as DomainResult;
}
export function createCompletionDomainResultV3(raw: unknown, authority: unknown, options: CompletionResultOptions = {}): DomainResultV3 {
  return completionResult(raw, authority, options, 3) as DomainResultV3;
}
function completionResult(raw: unknown, authority: unknown, options: CompletionResultOptions, version: 2 | 3): AnyDomainResult {
  const record = validateCompletion(raw, authority);
  if ((record.schemaVersion !== 5 && record.schemaVersion !== 6) || record.kind !== 'domain-task') fail('domain_result_completion_version_or_kind');
  if (options.expectedRunId !== undefined && record.binding.runId !== options.expectedRunId) fail('domain_result_run_mismatch');
  if (options.expectedTaskResult !== undefined) {
    const expected = validateTaskResultEnvelope(options.expectedTaskResult);
    const keys = ['domain', 'domainSchemaVersion', 'operation', 'status', 'verified', 'data', 'warnings', 'error', 'pendingContext'] as const;
    if (record.binding.taskId !== expected.taskId || keys.some(key => !same(boundedCopy(record.facts[key]), boundedCopy(expected[key])))) fail('domain_result_domain_evidence_mismatch');
  }
  const missing = record.completion.gaps.some(gap => gap.code === 'FACT_NOT_ESTABLISHED' && gap.path === 'facts.effects');
  let effects: unknown;
  if (record.facts.effects.length) {
    if (typeof options.projectEffects !== 'function') fail('domain_result_effect_projection_required');
    effects = synchronous(options.projectEffects(record.facts.effects), 'domain_result_effect_projection_must_be_synchronous');
    if (!effects || typeof effects !== 'object' || !('details' in effects) ||
      !same(boundedCopy(effects.details), boundedCopy(record.facts.effects))) fail('domain_result_effect_details_mismatch');
  } else {
    const noEffects: Effects = { status: missing ? 'possible' : 'none', refs: [], details: [],
      reconciliation: { required: missing, reason: missing ? 'COMPLETION_EFFECTS_NOT_ESTABLISHED' : null } }; effects = noEffects;
  }
  const disposition = record.facts.status === 'failure' ? 'failed' : record.facts.status === 'unknown' ? 'unresolved' : 'handled';
  const facts = read(NormalizedFactsSchema, { ...record.facts, domain: record.binding.domain }, 'domain_result_identity');
  const result = fromFacts(facts, 'agentic', disposition, { observations: [], gaps: record.completion.gaps }, null, effects, record.userResponse, version);
  if (record.schemaVersion === 6) validateCompletion(record, authority);
  return result;
}

import Type from 'typebox';
import { isDeepStrictEqual as same } from 'node:util';
import { FactsSchema, FACT_KEYS, DOMAIN_VERSIONS, DOMAIN_AGENTS, type Facts } from './contracts.js';
import { Binding3Schema, Binding4Schema, Binding5Schema, Binding6Schema, CompletionSchema, WorkflowSchema, SemanticsSchema,
  COMPLETION_SCHEMA_VERSION, type Binding, type Binding4, type Binding6, type Completion,
  type CompletionKind, type CompletionVersion, type CompletionOutcome } from './completion-contracts.js';
import { assertArrayData, assertIds, boundedCopy, decode, exact, fail, freeze, gaps, identifier, object, plain,
  pending, read, userResponse, assertion, UserResponseSchema, MAX_BYTES, MAX_RESPONSE_RESULTS, type Gap, type UserResponse } from './value.js';
export { COMPLETION_SCHEMA_VERSION, CURRENT_COMPLETION_SCHEMA_VERSION, SUCCESSOR_COMPLETION_SCHEMA_VERSION,
  BOUNDED_COMPLETION_SCHEMA_VERSION, COMPLETION_KINDS } from './completion-contracts.js';
export { COMPLETION_STATUSES } from './contracts.js';
export { MAX_WORKFLOW_ADMISSIONS } from './value.js';
export type { Completion, Completion3, Completion4, Completion5, Completion6 } from './completion-contracts.js';

const AUTHORITY = Symbol('CompletionAuthority');
export interface CompletionAuthority { readonly [AUTHORITY]: true }
/** Adapter-private live source/domain/terminal custody; serialized identities never supply authority. */
export interface CompletionCustody { assertCurrent(binding: Readonly<Binding6>): unknown }
interface Snapshot { schemaVersion: CompletionVersion; kind: CompletionKind; binding: Binding; facts: Facts;
  results: Completion[]; gaps: Gap[]; outcome: CompletionOutcome; custody?: CompletionCustody['assertCurrent'] }
const authorities = new WeakMap<object, Readonly<Snapshot>>();
const recordKeys = ['schemaVersion', 'kind', 'facts', 'results', 'userResponse', 'binding', 'completion'];
const callerKeys = ['runId', 'runGeneration', 'agentId', 'sessionKey', 'sessionId', 'sessionGeneration'] as const;
function component(version: number): boolean { return version === 4 || version === 5 || version === 6; }
function field(value: object, key: string): unknown { return Object.getOwnPropertyDescriptor(value, key)?.value; }
function generation(value: unknown): boolean { return identifier(value) || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0); }
function domainVersion(domain: unknown): string | undefined {
  return domain === 'jessica-vacuum' || domain === 'reminder' ? DOMAIN_VERSIONS[domain] : undefined;
}
function binding(value: unknown, kind: CompletionKind, version: CompletionVersion): Binding {
  const schema = version === 6 ? Binding6Schema : version === 5 ? Binding5Schema : version === 4 ? Binding4Schema : Binding3Schema;
  exact(value, Object.keys(schema.properties), 'completion_binding_shape');
  if (version === 6) {
    const b = read(Binding6Schema, value, 'completion_binding_invalid');
    assertIds(b, ['inputId', 'admissionId', 'runId', 'agentId', 'sessionKey', 'sessionId', 'taskId', 'authorizationId'], 'completion_binding_identity');
    if (kind !== 'domain-task' || b.agentId !== DOMAIN_AGENTS[b.domain]) fail('completion_domain_binding');
    if (b.conversationId !== null && !identifier(b.conversationId)) fail('completion_conversation_binding');
    if (b.caller !== null && (!Object.values(b.caller).every(identifier) || b.caller.runId === b.runId)) fail('completion_caller_binding');
    if ((b.completionTarget === 'CALLER' && b.caller === null) ||
      (b.parentContinuation.eligible && (b.caller === null || b.completionTarget !== 'CALLER')) ||
      (b.deliveryPolicy.eligible && b.completionTarget !== 'RESPONSE_CONTROLLER')) fail('completion_eligibility_binding');
    return freeze(b);
  }
  if (version === 5) {
    assertIds(value, ['inputId', 'admissionId', 'runId', 'agentId', 'sessionKey', 'sessionId', 'authorizationId'], 'completion_binding_identity');
    if (![value.runGeneration, value.sessionGeneration].every(generation)) fail('completion_binding_generation');
    const b = read(Binding5Schema, value, 'completion_binding_invalid');
    assertIds(b, ['inputId', 'admissionId', 'runId', 'agentId', 'sessionKey', 'sessionId', 'authorizationId'], 'completion_binding_identity');
    if (!generation(b.runGeneration) || !generation(b.sessionGeneration)) fail('completion_binding_generation');
    if (b.conversationId === null ? b.conversationGeneration !== null :
      !identifier(b.conversationId) || !generation(b.conversationGeneration)) fail('completion_conversation_binding');
    if (kind === 'domain-task' ? b.domain === null || b.agentId !== DOMAIN_AGENTS[b.domain] || !identifier(b.taskId) :
      b.domain !== null || b.taskId !== null) fail('completion_domain_binding');
    if (b.caller !== null && (![b.caller.runId, b.caller.agentId, b.caller.sessionKey, b.caller.sessionId].every(identifier) ||
      !generation(b.caller.runGeneration) || !generation(b.caller.sessionGeneration) || b.caller.runId === b.runId)) fail('completion_caller_binding');
    if ((b.completionTarget === 'CALLER' && b.caller === null) ||
      (b.parentContinuation.eligible && (b.caller === null || b.completionTarget !== 'CALLER')) ||
      (b.deliveryPolicy.eligible && b.completionTarget !== 'RESPONSE_CONTROLLER')) fail('completion_eligibility_binding');
    return freeze(b);
  }
  if (version === 4) {
    assertIds(value, ['conversationId', 'admissionId', 'workflowId', 'runId', 'agentId', 'sessionKey', 'sessionId', 'authorizationId'], 'completion_binding_identity');
    if (![value.conversationGeneration, value.runGeneration, value.sessionGeneration].every(generation)) fail('completion_binding_generation');
    const b = read(Binding4Schema, value, 'completion_binding_invalid');
    assertIds(b, ['conversationId', 'admissionId', 'workflowId', 'runId', 'agentId', 'sessionKey', 'sessionId', 'authorizationId'], 'completion_binding_identity');
    if (![b.conversationGeneration, b.runGeneration, b.sessionGeneration].every(generation)) fail('completion_binding_generation');
    if (kind !== (b.role === 'domain-task' ? 'domain-task' : 'final-workflow') ||
      (kind === 'domain-task' ? !identifier(b.taskId) : b.taskId !== null) ||
      b.finality !== (b.completionTarget === 'RESPONSE_CONTROLLER') || (kind === 'final-workflow' && !b.finality)) fail('completion_binding_invalid');
    if (b.completionTarget === 'CALLER') {
      if (b.caller === null || ![b.caller.workflowId, b.caller.runId, b.caller.agentId, b.caller.sessionKey, b.caller.sessionId].every(identifier) ||
          b.caller.workflowId !== b.workflowId || !generation(b.caller.runGeneration) || !generation(b.caller.sessionGeneration)) fail('completion_caller_binding');
    } else if (b.caller !== null) fail('completion_caller_binding');
    if (!b.finality && b.deliveryPolicy.eligible) fail('completion_delivery_policy_invalid');
    return freeze(b);
  }
  assertIds(value, ['requestId', 'workflowId', 'runId', 'agentId', 'sessionKey', 'sessionId', 'authorizationId'], 'completion_binding_identity');
  const b = read(Binding3Schema, value, 'completion_binding_invalid');
  assertIds(b, ['requestId', 'workflowId', 'runId', 'agentId', 'sessionKey', 'sessionId', 'authorizationId'], 'completion_binding_identity');
  if ((kind === 'domain-task' ? !identifier(b.taskId) : b.taskId !== null) ||
      (b.completionTarget === 'CALLER' ? !identifier(b.callerRunId) : b.callerRunId !== null) ||
      b.finality !== (b.completionTarget === 'RESPONSE_CONTROLLER')) fail('completion_binding_invalid');
  if (!b.finality && b.deliveryPolicy.eligible) fail('completion_delivery_policy_invalid');
  return freeze(b);
}
function missingFields(missing: readonly Gap[]): string[] {
  return FACT_KEYS.filter(key => missing.some(gap => gap.code === 'FACT_NOT_ESTABLISHED' && gap.path === `facts.${key}`));
}
function absences(b: Binding, missing: string[], results: readonly Completion[]): string[] {
  return [...new Set([...missing, ...('role' in b && b.role === 'direct-final' ? missingFields(results[0]?.completion.gaps ?? []) : [])])];
}
function facts(value: unknown, kind: CompletionKind, outcome: CompletionOutcome, version: number, absentFields: string[]): Facts {
  exact(value, FACT_KEYS, 'completion_facts_shape');
  const f = read(FactsSchema, value, 'completion_facts_invalid');
  const absent = (key: string) => component(version) && outcome === 'FAILED' && absentFields.includes(key);
  if (!f.verificationScope.every(identifier) || (f.operation !== null && !identifier(f.operation))) fail('completion_facts_invalid');
  if (kind === 'domain-task') {
    if ((f.domain === null && absent('domain')) || (f.domainSchemaVersion === null && absent('domainSchemaVersion'))) {
      if (f.domainSchemaVersion !== null && f.domainSchemaVersion !== '1' && f.domainSchemaVersion !== 'legacy-unversioned') fail('completion_domain_version');
    } else if (f.domain === null && f.domainSchemaVersion === null) {
      if (outcome !== 'FAILED') fail('completion_domain_unknown');
    } else if (domainVersion(f.domain) !== f.domainSchemaVersion) fail('completion_domain_version');
  } else if (f.domain !== null || f.domainSchemaVersion !== null || f.operation !== null) fail('completion_workflow_domain');
  if (f.verified === true && !f.verificationScope.length && !absent('verificationScope')) fail('completion_verification_scope');
  if (f.verified === 'not_applicable' && (f.verificationScope.length || f.effects.length)) fail('completion_verification_not_applicable');
  if (outcome !== 'FAILED') {
    if (f.status === 'success' && (f.error !== null || f.pendingContext !== null || (kind === 'domain-task' && f.verified !== true))) fail('completion_success_invalid');
    if (f.status === 'failure' && f.error === null) fail('completion_failure_error');
    if (f.status === 'clarification_required' && (f.pendingContext === null || f.error !== null || f.verified !== false)) fail('completion_clarification_invalid');
    if (f.status === 'unknown' && !f.uncertainty.length) fail('completion_unknown_unexplained');
    if (f.status === 'not_applicable' && f.verified !== 'not_applicable') fail('completion_not_applicable_invalid');
  }
  return freeze({ ...f, pendingContext: pending(f.pendingContext) });
}
function incompleteChildGap(record: Completion, index: number): Gap {
  return { code: 'CHILD_COMPLETION_INCOMPLETE', path: component(record.schemaVersion) ? `results.${index}` : `results.${record.binding.taskId}`,
    detail: 'Child report preserves known facts but lacks complete semantics.' };
}
function bounds(record: Completion): void {
  if (record.schemaVersion === 3) { boundedCopy(record); return; }
  boundedCopy({ ...record, results: [] });
  const count = record.results.length;
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_BYTES * (count + 1) + Math.max(0, count - 1)) fail('json_bytes_exceeded');
}
function correlate(record: Completion): void {
  if (record.schemaVersion === 5 || record.schemaVersion === 6) {
    const b = record.binding;
    if (record.facts.domain !== b.domain && !(record.completion.outcome === 'FAILED' && record.facts.domain === null &&
      missingFields(record.completion.gaps).includes('domain'))) fail('completion_domain_binding');
    if (b.domain !== null && record.facts.domainSchemaVersion !== null &&
      record.facts.domainSchemaVersion !== DOMAIN_VERSIONS[b.domain]) fail('completion_domain_version');
    if (record.schemaVersion === 5) {
      const b = record.binding;
      if (new Set(record.results.map(child => child.binding.runId)).size !== record.results.length) fail('completion_duplicate_run');
      for (const child of record.results) {
        if (child.binding.conversationId !== b.conversationId || child.binding.conversationGeneration !== b.conversationGeneration ||
          child.binding.caller === null || callerKeys.some(key => child.binding.caller?.[key] !== b[key])) fail('completion_result_correlation');
      }
    }
  } else if (record.schemaVersion === 4) {
    const b = record.binding;
    for (const child of record.results) {
      const c = child.binding;
      if (c.workflowId !== b.workflowId || c.conversationId !== b.conversationId || c.conversationGeneration !== b.conversationGeneration ||
        c.membershipRevision > b.membershipRevision || c.acceptedIntentRevision > b.acceptedIntentRevision) fail('completion_result_correlation');
      if (b.role === 'direct-final') {
        const keys = ['conversationId', 'conversationGeneration', 'admissionId', 'admissionSequence', 'workflowId', 'membershipRevision',
          'acceptedIntentRevision', 'runId', 'runGeneration', 'agentId', 'sessionKey', 'sessionId', 'sessionGeneration', 'authorizationId', 'deliveryPolicy'];
        if (record.results.length !== 1 || c.completionTarget !== 'RESPONSE_CONTROLLER' ||
          keys.some(key => !same(field(c, key), field(b, key)))) fail('completion_direct_result_binding');
      } else if (c.completionTarget !== 'CALLER' || c.caller?.agentId !== b.agentId) fail('completion_result_caller');
    }
    if (b.role === 'direct-final') {
      const child = record.results[0];
      if (!child || record.results.length !== 1) fail('completion_direct_results_count');
      if (!same(boundedCopy(record.facts), boundedCopy({ ...child.facts, domain: null, domainSchemaVersion: null, operation: null }))) fail('completion_direct_facts');
      if (record.completion.outcome !== child.completion.outcome) fail('completion_direct_outcome');
      if (!same(boundedCopy(record.userResponse), boundedCopy(child.userResponse))) fail('completion_direct_response');
    }
  } else {
    const b = record.binding;
    for (const child of record.results) {
      const c = child.binding;
      if (c.requestId !== b.requestId || c.workflowId !== b.workflowId || c.sessionId !== b.sessionId || c.sessionKey !== b.sessionKey) fail('completion_result_correlation');
      if (c.completionTarget === 'RESPONSE_CONTROLLER' && (record.results.length !== 1 || b.completionTarget !== 'RESPONSE_CONTROLLER' ||
        c.runId !== b.runId || c.agentId !== b.agentId || c.generation !== b.generation)) fail('completion_direct_result_binding');
    }
  }
  if (record.kind !== 'domain-task' && record.completion.outcome !== 'FAILED') {
    if (record.facts.status === 'success' && record.results.some(child => !['success', 'not_applicable'].includes(child.facts.status))) fail('completion_success_hides_result');
    if (!record.results.length && record.facts.status === 'success' && record.facts.verified !== 'not_applicable') fail('completion_empty_execution_proof');
  }
}
/** Validate components before traversing an aggregate; children cannot contain children. */
function shape(raw: unknown): Completion {
  exact(raw, recordKeys, 'completion_shape');
  if (![3, 4, 5, 6].includes(typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0)) fail('completion_version_or_kind');
  if (!Array.isArray(raw.results) || raw.results.length > MAX_RESPONSE_RESULTS || (raw.kind === 'domain-task' && raw.results.length)) fail('completion_results_count');
  assertArrayData(raw.results);
  boundedCopy({ ...raw, results: [] });
  for (const child of raw.results) {
    if (!plain(child) || child.kind !== 'domain-task' || child.schemaVersion !== raw.schemaVersion) fail('completion_result_kind');
    boundedCopy(child);
  }
  const record = decode(CompletionSchema, raw, 'completion_version_or_kind');
  const missing = gaps(record.completion.gaps);
  if ((record.completion.outcome === 'FAILED') !== (missing.length > 0)) fail('completion_outcome_gaps');
  const results = record.results.map(child => shape(child));
  if (new Set(results.map(child => child.binding.taskId)).size !== results.length) fail('completion_duplicate_task');
  const b = binding(record.binding, record.kind, record.schemaVersion);
  const f = facts(record.facts, record.kind, record.completion.outcome, record.schemaVersion, absences(b, missingFields(missing), results));
  const normalized = decode(CompletionSchema, { ...record, binding: b, facts: f, results, userResponse: userResponse(record.userResponse),
    completion: { outcome: record.completion.outcome, gaps: missing } }, 'completion_result_kind');
  correlate(normalized); bounds(normalized);
  if (normalized.schemaVersion === 4 && normalized.kind === 'domain-task' && normalized.binding.completionTarget === 'RESPONSE_CONTROLLER') {
    boundedCopy({ ...normalized, kind: 'final-workflow', facts: { ...normalized.facts, domain: null, domainSchemaVersion: null, operation: null },
      results: [], binding: { ...normalized.binding, role: 'direct-final', taskId: null }, completion: { outcome: normalized.completion.outcome,
        gaps: normalized.completion.outcome === 'FAILED' ? [incompleteChildGap(normalized, 0)] : [] } });
  }
  return freeze(normalized);
}
function snapshot(authority: unknown): Readonly<Snapshot> {
  const value = authority !== null && typeof authority === 'object' ? authorities.get(authority) : undefined;
  if (!value) fail('native_completion_authority_required');
  assertCustody(value); return value;
}
function assertCustody(value: Readonly<Snapshot>): void {
  if (value.schemaVersion !== 6) return;
  if (!value.custody) fail('completion_live_custody_required');
  assertion(value.custody(decode(Binding6Schema, value.binding, 'completion_binding_invalid')), 'completion_live_custody_must_be_synchronous');
}
function unknownFacts(): Facts {
  return { status: 'unknown', domain: null, domainSchemaVersion: null, operation: null, verified: 'unknown',
    verificationScope: [], data: null, warnings: [], error: null, effects: [], uncertainty: [], pendingContext: null };
}
function workflowEvidence(raw: unknown, b: Binding4, results: readonly Completion[]): void {
  if (!plain(raw) || !Array.isArray(raw.admissions) || !raw.admissions.length || raw.admissions.length > 256) fail('native_admissions_count');
  const w = read(WorkflowSchema, raw, 'native_workflow_shape');
  for (const key of ['workflowId', 'conversationId', 'conversationGeneration', 'membershipRevision', 'acceptedIntentRevision'] as const) {
    if (w[key] !== b[key]) fail('completion_workflow_binding_mismatch');
  }
  if (b.finality && w.membershipState !== 'closed') fail('completion_membership_not_closed');
  const members = new Map<string, number>(); let previous = 0;
  for (const entry of w.admissions) {
    if (!identifier(entry.admissionId) || entry.sequence <= previous || members.has(entry.admissionId)) fail('native_admission_order_or_identity');
    members.set(entry.admissionId, entry.sequence); previous = entry.sequence;
  }
  for (const entry of [b, ...results.map(child => child.binding)]) {
    if (!('admissionSequence' in entry) || members.get(entry.admissionId) !== entry.admissionSequence) fail('completion_admission_not_member');
  }
  if (b.finality && b.admissionId !== w.admissions[0]?.admissionId) fail('completion_final_admission_not_anchor');
}
function workflowSemantics(raw: unknown, b: Binding4, known: Record<string, unknown>, missing: Gap[]): void {
  const semantics = read(SemanticsSchema, raw, 'native_semantics_shape');
  if (b.role !== 'workflow-final') { if (semantics !== null) fail('completion_semantics_not_applicable'); return; }
  if (semantics !== null) {
    if (semantics.ownerRunId !== b.runId || semantics.ownerRunGeneration !== b.runGeneration ||
      semantics.acceptedIntentRevision !== b.acceptedIntentRevision) fail('completion_semantic_binding_mismatch');
    if (semantics.value !== null && !same(boundedCopy(semantics.value), boundedCopy(known.data ?? null))) fail('completion_semantic_evidence_mismatch');
  }
  if (semantics === null || semantics.coverage !== 'complete' || !plain(semantics.value) || !Object.keys(semantics.value).length) {
    missing.push({ code: 'WORKFLOW_SEMANTICS_NOT_ESTABLISHED', path: 'workflow.semantics',
      detail: 'Child facts alone do not establish the final owner semantics for the accepted intent.' });
  }
}
export function createCompletionAuthority(native: unknown, liveCustody?: CompletionCustody): CompletionAuthority {
  if (!plain(native)) fail('native_evidence_shape');
  const version = Object.hasOwn(native, 'schemaVersion') ? field(native, 'schemaVersion') : COMPLETION_SCHEMA_VERSION;
  if (version !== 3 && version !== 4 && version !== 5 && version !== 6) fail('completion_version_or_kind');
  let custody: CompletionCustody['assertCurrent'] | undefined;
  if (version === 6) {
    exact(liveCustody, ['assertCurrent'], 'completion_live_custody_required');
    if (typeof liveCustody.assertCurrent !== 'function') fail('completion_live_custody_required');
    custody = liveCustody.assertCurrent.bind(liveCustody);
  } else if (liveCustody !== undefined) fail('completion_live_custody_version_mismatch');
  const base = ['kind', 'binding', 'knownFacts', 'results', 'coverage', 'gaps', 'origin'];
  exact(native, version === 4 ? ['schemaVersion', ...base, 'workflow', 'semantics'] : version === 5 || version === 6 ? ['schemaVersion', ...base] : base, 'native_evidence_shape');
  const kind = native.kind;
  if ((kind !== 'domain-task' && kind !== 'agent-run' && kind !== 'final-workflow') ||
      (version === 6 ? kind !== 'domain-task' : version === 5 ? kind === 'final-workflow' : kind === 'agent-run') ||
      !['agent', 'runtime'].includes(typeof native.origin === 'string' ? native.origin : '') ||
      !['complete', 'incomplete'].includes(typeof native.coverage === 'string' ? native.coverage : '') ||
      !plain(native.knownFacts) || Object.keys(native.knownFacts).some(key => !FACT_KEYS.includes(key)) ||
      !Array.isArray(native.results) || native.results.length > MAX_RESPONSE_RESULTS || (kind === 'domain-task' && native.results.length)) fail('native_evidence_invalid');
  assertArrayData(native.results);
  const b = binding(native.binding, kind, version);
  if (custody) assertion(custody(decode(Binding6Schema, b, 'completion_binding_invalid')), 'completion_live_custody_must_be_synchronous');
  const known = boundedCopy(native.knownFacts);
  if (!plain(known)) fail('native_evidence_invalid');
  const missing = gaps(native.gaps);
  if (native.coverage !== 'complete') missing.push({ code: 'EVIDENCE_COVERAGE_INCOMPLETE', path: 'evidence.coverage',
    detail: 'Native execution evidence does not account for all required work.' });
  const absent = FACT_KEYS.filter(key => !Object.hasOwn(known, key));
  for (const key of absent) missing.push({ code: 'FACT_NOT_ESTABLISHED', path: `facts.${key}`,
    detail: 'Required semantic fact is absent from trusted native evidence.' });
  const results = native.results.map((entry: unknown, index: number) => {
    exact(entry, ['record', 'authority'], 'native_result_evidence_shape');
    const record = validateCompletion(entry.record, entry.authority);
    if (record.completion.outcome === 'FAILED') missing.push(incompleteChildGap(record, index));
    return record;
  });
  if (version === 4) {
    const b4 = decode(Binding4Schema, b, 'completion_binding_invalid');
    workflowEvidence(native.workflow, b4, results); workflowSemantics(native.semantics, b4, known, missing);
  }
  const f = facts({ ...unknownFacts(), ...known }, kind, missing.length ? 'FAILED' : 'RECOVERED', version, absences(b, absent, results));
  if (component(version) && f.pendingContext !== null && (!('conversationId' in b) ||
      f.pendingContext.binding.conversationId !== b.conversationId)) fail('completion_pending_conversation_mismatch');
  gaps(missing);
  if (native.origin === 'agent' && missing.length) fail('completion_evidence_insufficient');
  const s: Snapshot = freeze({ schemaVersion: version, kind, binding: b, facts: f, results, gaps: missing,
    outcome: native.origin === 'agent' ? 'NORMAL' : missing.length ? 'FAILED' : 'RECOVERED', ...(custody ? { custody } : {}) });
  shape(fromSnapshot(s, 'unavailable'));
  assertCustody(s);
  const authority: CompletionAuthority = freeze({ [AUTHORITY]: true }); authorities.set(authority, s); return authority;
}
function fromSnapshot(s: Readonly<Snapshot>, response: UserResponse | 'unavailable'): unknown {
  const retained = s.schemaVersion === 4 && 'role' in s.binding && s.binding.role === 'direct-final' ? s.results[0]?.userResponse : undefined;
  return { schemaVersion: s.schemaVersion, kind: s.kind, facts: s.facts, results: s.results, binding: s.binding,
    userResponse: response === 'unavailable' ? retained ?? { state: 'unavailable', reason: { code: 'RUNTIME_WORDING_UNAVAILABLE',
      detail: 'No owner-authored usable message is retained.' } } : response, completion: { outcome: s.outcome, gaps: s.gaps } };
}
export function validateCompletion(raw: unknown, authority: unknown): Completion {
  const s = snapshot(authority); const record = shape(raw);
  if (record.schemaVersion !== s.schemaVersion) fail('completion_version_or_kind');
  if (record.kind !== s.kind || !same(boundedCopy(record.binding), boundedCopy(s.binding))) fail('completion_native_binding_mismatch');
  if (!same(boundedCopy(record.facts), boundedCopy(s.facts)) || !(component(record.schemaVersion) ? same(record.results, s.results) :
    same(boundedCopy(record.results), boundedCopy(s.results)))) fail('completion_evidence_mismatch');
  if (record.completion.outcome !== s.outcome || !same(boundedCopy(record.completion.gaps), boundedCopy(s.gaps))) fail('completion_evidence_insufficient');
  if (s.outcome !== 'NORMAL') {
    const expected = decode(CompletionSchema, fromSnapshot(s, 'unavailable'), 'completion_shape');
    if (!same(boundedCopy(record.userResponse), boundedCopy(expected.userResponse))) fail('completion_runtime_response_mismatch');
  }
  assertCustody(s); return record;
}
export function acceptAgentCompletion(proposal: unknown, authority: unknown): Completion {
  const s = snapshot(authority);
  exact(proposal, ['schemaVersion', 'kind', 'facts', 'userResponse'], 'agent_completion_shape');
  if (proposal.schemaVersion !== s.schemaVersion || proposal.kind !== s.kind) fail('completion_version_or_kind');
  if (s.outcome !== 'NORMAL') fail('completion_origin_mismatch');
  if (!same(boundedCopy(proposal.facts), boundedCopy(s.facts))) fail('completion_evidence_mismatch');
  return validateCompletion(fromSnapshot(s, userResponse(proposal.userResponse)), authority);
}
export function reconstructCompletion(authority: unknown): Completion {
  const s = snapshot(authority); if (s.outcome === 'NORMAL') fail('completion_origin_mismatch');
  return validateCompletion(fromSnapshot(s, 'unavailable'), authority);
}
export function completionProposalSchema(authority: unknown) {
  const s = snapshot(authority); if (s.outcome !== 'NORMAL') fail('completion_origin_mismatch');
  const schema = object({ schemaVersion: Type.Literal(s.schemaVersion), kind: Type.Literal(s.kind),
    facts: { ...FactsSchema, const: boundedCopy(s.facts) }, userResponse: UserResponseSchema });
  const result = freeze({ $schema: 'https://json-schema.org/draft/2020-12/schema', ...schema,
    properties: { ...schema.properties, userResponse: { oneOf: UserResponseSchema.anyOf } } });
  assertCustody(s); return result;
}

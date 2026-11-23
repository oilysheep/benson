import { assertInvocationCurrent } from '../../../integrations/openclaw/benson-routing/core/invocation.js';
import Type from 'typebox';
import { object, decode, fail, freeze, boundedCopy, assertion } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { isDeepStrictEqual } from 'node:util';
import type { GrantedSourceDependencies } from '../../../integrations/openclaw/benson-routing/core/request-control.js';
import type { SourceInput, NoRunOutcome } from '../../../integrations/openclaw/benson-routing/core/contracts.js';
import { prepareJessicaWarningEvent, projectJessicaWarningEvent, prepareJessicaCompletionEvent, projectJessicaCompletionEvent, verifyJessicaCompletionProof } from './ha-read.js';
import { loadRegistry, resolveRoom, type Registry } from './registry.js';
import { createSourceAdmissionController, NATIVE_READ_ADMISSION_VERSION, type SourceAdmissionController } from '../../../integrations/openclaw/benson-routing/core/request-control.js';
import { TaskEnvelopeSchema, type TaskEnvelope, type ConsumedPending, type AnyDomainResult, type NativeDispatchReadAdmission, type NativeActionOutcome } from '../../../integrations/openclaw/benson-routing/core/contracts.js';
import { reconstructDomainPending, createCurrentRequestContext, type CurrentRequestEvidence, type NativeCurrentInputEvidence, ingressTextHash, type ConversationCutoff, type CurrentRequestProjection } from '../../../integrations/openclaw/benson-routing/core/conversation-context.js';
import { validateTaskEnvelope } from '../../../integrations/openclaw/benson-routing/core/task-envelope.js';
import { readDomainFactsData, withDomainPending } from '../../../integrations/openclaw/benson-routing/core/domain-result.js';
import { createNoRunDomainResult, NATIVE_READ_OUTCOME_VERSION, RESPONSE_CONTRACT_VERSION } from '../../../integrations/openclaw/benson-routing/core/envelope.js';
import { controlReadResponse, controlActionResponse } from '../../../integrations/openclaw/benson-routing/core/response-control.js';
import { renderJessicaStatusText, renderJessicaStartText } from './presentation.js';
import { validateResult, type Result } from './results.js';
import { IdentitySchema, parseExecuteRequest } from './schemas.js';
import type { InvocationAuthority } from './ports.js';
import { loadPolicy, authorize } from './policy.js';
import { assertRosterPolicyAgreement, resolveTrustedIdentity, type FamilyRoutes } from './identity.js';
import { OperationOriginSchema, operationInputId, type OperationOrigin, type OperationState, type OperationCorrelation } from './operation-state.js';
import type { createJessicaExecutor } from './executor.js';
function sourceOrigin(source: (CurrentRequestEvidence & { readonly cutoff: ConversationCutoff }) | NativeCurrentInputEvidence): OperationOrigin {
  return 'origin' in source ? source.origin : { binding: source.binding, cutoff: source.cutoff };
}
export const JESSICA_TASK_SCHEMA = object({ operation: Type.Literal('status') });

/** Routing hint only; exact room/capability validation stays in this owner. */
export function isJessicaRoomActionRequest(text: string): boolean { return /^(?:clean |נקה )/iu.test(text.trim()); }
export function resolveJessicaRoomAction(registry: Registry, text: string) {
  // Anchored commands with an exact existing alias; no inferred room, settings,
  // history resolution, multiple actions or under-test capability admission.
  const match = /^(?:clean (?:the )?|נקה (?:את )?)(.+)$/iu.exec(text.trim());
  if (!match?.[1]) fail('jessica_action_request_unsupported');
  const room = resolveRoom(registry, match[1]);
  if (!registry.capabilities.find(cap => cap.name === 'clean_single_room')?.verifiedRooms?.some(item => item.room === room.slug)) fail('jessica_action_room_unaccepted');
  return room;
}
/** Current-input action entry. Unsupported syntax is rejected before
 * admission, state access or dispatch; this is not a general intent parser.
 * The existing native registration is wired in source; installation and
 * runtime activation require separate approval. */
export async function executeJessicaRoomTask(raw: unknown, deps: {
  source: (CurrentRequestEvidence & { readonly cutoff: ConversationCutoff }) | NativeCurrentInputEvidence;
  roster: FamilyRoutes; registryConfig: unknown; policyConfig: unknown;
  executor: ReturnType<typeof createJessicaExecutor>; authority: InvocationAuthority;
  clock?: () => Date;
  /** Private result custody for the native Response owner; never serialized. */
  retainResult?: (assertCurrent: () => void) => void;
  /** Domain plugin/policy lifetime, independent of the normal Tool retirement. Required for ingress. */
  assertResultCurrent?: () => void;
}) {
  const clock = deps.clock ?? (() => new Date()), task = validateTaskEnvelope(raw);
  if (task.version === 2 && task.pending !== null) fail('jessica_action_pending_unsupported');
  const context = createCurrentRequestContext(deps.source), projected = context.projectCurrentRequest({ signal: deps.authority.signal });
  if (projected.status !== 'available') fail('jessica_action_source_unavailable');
  if (task.request !== projected.context.current.text) fail('jessica_action_original_request_mismatch');
  const origin = freeze(structuredClone(decode(OperationOriginSchema,
    'origin' in deps.source ? deps.source.origin : { binding: projected.context.conversation, cutoff: deps.source.cutoff }, 'jessica_action_origin_invalid')));
  if (origin.binding.channel !== 'whatsapp' || origin.binding.kind !== 'direct' || origin.binding.threadId !== null ||
    operationInputId(origin) !== projected.context.current.entryId ||
    (!('cutoff' in origin) && (origin.textHash !== ingressTextHash(task.request) || typeof deps.assertResultCurrent !== 'function' ||
      !('origin' in deps.source) || typeof deps.source.assertRetainedCurrent !== 'function'))) fail('jessica_action_origin_invalid');
  const registry = loadRegistry(deps.registryConfig), policy = loadPolicy(deps.policyConfig);
  assertRosterPolicyAgreement(deps.roster, policy);
  const identity = resolveTrustedIdentity({ channel: origin.binding.channel, accountId: origin.binding.accountId,
    to: origin.binding.peerId, senderId: origin.binding.requesterId }, deps.roster);
  const room = resolveJessicaRoomAction(registry, task.request);
  const request = freeze({ operation: 'clean' as const, target: { kind: 'rooms' as const, rooms: [room.slug] } });
  const action = { operation: 'clean', target: room.slug };
  const current = () => {
    deps.authority.signal.throwIfAborted(); assertInvocationCurrent(deps.authority);
    if (!('cutoff' in origin)) {
      if (!deps.assertResultCurrent) fail('jessica_action_result_custody_unavailable');
      assertion(deps.assertResultCurrent(), 'jessica_action_policy_async');
    }
    if (context.revalidateProjection(projected, { signal: deps.authority.signal }).status !== 'available' ||
      !isDeepStrictEqual(sourceOrigin(deps.source), origin) || !isDeepStrictEqual(deps.source.binding, origin.binding)) fail('jessica_action_source_changed');
    const resolved = resolveTrustedIdentity({ channel: origin.binding.channel, accountId: origin.binding.accountId,
      to: origin.binding.peerId, senderId: origin.binding.requesterId }, deps.roster);
    if (!isDeepStrictEqual(resolved, identity)) fail('jessica_action_requester_changed');
    authorize(policy, resolved, 'control');
  };
  let expected: NativeActionOutcome | undefined;
  let witness: Awaited<ReturnType<typeof deps.executor.executeWithCompletion>> | undefined;
  const controller = createSourceAdmissionController({ nativeAction: { requestId: operationInputId(origin),
    domain: 'jessica-vacuum', subject: identity.senderId, request: task.request, action }, now: () => clock().getTime(),
    assertCurrent: current, assertDomainOutcome(outcome) {
      current();
      if (!expected || !witness || !isDeepStrictEqual(outcome, boundedCopy(expected))) fail('jessica_action_outcome_mismatch');
      assertion(witness.assertCompletion(request, outcome.evidence.facts), 'jessica_action_witness_async');
    } });
  const admission = controller.admit({ schemaVersion: 5, kind: 'benson.source-input', domain: 'jessica-vacuum', scope: 'action', request: task.request, action });
  const authority = { signal: deps.authority.signal, assertCurrent: () => controller.assertCurrent(admission) };
  witness = await deps.executor.executeWithCompletion(request, { identity, requestEpoch: operationInputId(origin), origin, authority });
  current(); witness.assertCompletion(request, witness.result);
  const data = witness.result.data && 'operationId' in witness.result.data && !('kind' in witness.result.data) ? witness.result.data : null;
  const correlation = data ? await deps.executor.state.correlation(data.operationId) : null;
  current();
  if (witness.result.status === 'success' && (!correlation || !isDeepStrictEqual(correlation.origin, origin) ||
    correlation.owner.requesterId !== identity.senderId || correlation.plan.operation !== 'clean' ||
    correlation.plan.rooms.length !== 1 || correlation.plan.rooms[0]?.slug !== room.slug || correlation.plan.settings !== null)) fail('jessica_action_correlation_missing');
  const facts = validateResult(witness.result, correlation?.plan ?? null, clock());
  if (facts.operation !== 'clean' || facts.pendingContext !== null || facts.status === 'clarification_required' ||
    (data && (data.rooms.length !== 1 || data.rooms[0] !== room.slug || Object.keys(data.appliedSettings).length)) ||
    (facts.status === 'success' && data?.outcome !== 'started')) fail('jessica_action_result_scope');
  const possible = facts.error?.sideEffects === 'possible', known = facts.status === 'success' || facts.error?.sideEffects === 'observed';
  const effectStatus = possible ? 'possible' : known ? 'known' : 'none';
  const reconciliation = { required: possible || facts.error?.retryMode === 'reconcile', reason: possible || facts.error?.retryMode === 'reconcile' ? 'JESSICA_START_NOT_SETTLED' : null };
  const details = effectStatus === 'none' ? [] : [{ kind: 'jessica-dispatch', requestId: admission.requestId, ...(data ? { operationId: data.operationId } : {}),
    verified: facts.status === 'success', scope: 'cleaning_start_only' }];
  expected = freeze({ schemaVersion: 5, kind: 'benson.no-run',
    admission: { authorityKind: 'native-action', requestId: admission.requestId, domain: admission.domain, subject: admission.authority.subject, action },
    disposition: facts.status === 'success' ? 'handled' : possible || reconciliation.required ? 'unresolved' : 'failed',
    evidence: { ref: data?.operationId ?? admission.requestId, observedAt: data?.observation?.observedAt ?? null,
      freshness: facts.status === 'success' ? 'fresh' : 'unknown', facts },
    effects: { status: effectStatus, refs: effectStatus === 'none' ? [] : [data?.operationId ?? admission.requestId], details },
    reconciliation, notification: null,
    error: facts.error ? { code: facts.error.code, message: facts.error.message, retryable: false } : null });
  const response = controlActionResponse(expected, { controller, admission,
    renderOutcome: () => ({ schemaVersion: 2, message: renderJessicaStartText(facts) }) });
  const result = createNoRunDomainResult(response, { controller, admission, language: 'he', normalizeFacts: () => ({
    status: facts.status, domain: facts.domain, domainSchemaVersion: facts.schemaVersion, operation: facts.operation,
    verified: facts.verified, verificationScope: facts.status === 'success' ? ['room_cleaning_start'] : [],
    data: facts.data, warnings: facts.warnings, error: facts.error, effects: details,
    uncertainty: possible || reconciliation.required ? [{ code: 'JESSICA_START_NOT_SETTLED' }] : [], pendingContext: null }) });
  const retainedWitness = witness;
  deps.retainResult?.(() => {
    if ('origin' in deps.source) {
      assertion(deps.source.assertRetainedCurrent(), 'jessica_action_retained_source_async');
      if (!deps.assertResultCurrent) fail('jessica_action_result_custody_unavailable');
      assertion(deps.assertResultCurrent(), 'jessica_action_retained_policy_async');
      if (!isDeepStrictEqual(sourceOrigin(deps.source), origin) || deps.source.request !== task.request)
        fail('jessica_action_source_changed');
      const resolved = resolveTrustedIdentity({ channel: origin.binding.channel, accountId: origin.binding.accountId,
        to: origin.binding.peerId, senderId: origin.binding.requesterId }, deps.roster);
      if (!isDeepStrictEqual(resolved, identity)) fail('jessica_action_requester_changed');
      authorize(policy, resolved, 'control');
    } else current();
    retainedWitness.assertCompletion(request, facts);
  });
  return result;
}

/** The event branch of the existing domain entry. No identity is synthesized
 * for a person, task or Run, and no operation-state/effect port is available. */
export function createJessicaWarningEventEntry(deps: {
  registry: Registry; now(): number; readAuthority: GrantedSourceDependencies['readAuthority'];
}) {
  return Object.freeze({ entityIds: Object.freeze([deps.registry.mapBinding.deviceEntity]),
    prepareRequest: prepareJessicaWarningEvent,
    execute(input: SourceInput, assertCurrent: () => void) {
      let expected: NoRunOutcome | undefined;
      const project = () => projectJessicaWarningEvent(JSON.parse(input.request), deps.registry, deps.now());
      const controller = createSourceAdmissionController({ now: deps.now, readAuthority: deps.readAuthority, assertCurrent,
        assertDomainOutcome(outcome) {
          project();
          if (!expected || !isDeepStrictEqual(outcome, boundedCopy(expected))) fail('jessica_warning_outcome_mismatch');
        } });
      if (input.domain !== 'jessica-vacuum' || input.source.type !== 'ha' || input.scope !== 'read') fail('jessica_warning_admission_invalid');
      const admission = controller.admit(input), facts = project();
      expected = freeze({ schemaVersion: 1, kind: 'benson.no-run',
        admission: { inputId: admission.source.inputId, sourceType: admission.source.type, sourceRef: admission.source.ref,
          authorityRef: admission.authority.ref, authorityRevision: admission.authority.revision,
          domain: admission.domain, subject: admission.authority.subject },
        disposition: facts.active ? 'handled' : 'no-change',
        evidence: { ref: admission.source.inputId, observedAt: facts.observedAt, freshness: 'fresh', facts },
        effects: { status: 'none', refs: [] }, reconciliation: { required: false, reason: null }, notification: null, error: null });
      const response = controlReadResponse(expected, { controller, admission, renderOutcome: () => ({ schemaVersion: 2,
        message: facts.active ? 'Jessica reports a device error. Cleaning-task correlation is unknown.' : 'Jessica reports no device error. Cleaning-task correlation is unknown.' }) });
      return createNoRunDomainResult(response, { controller, admission, language: 'en', normalizeFacts: () => ({
        status: 'success', domain: admission.domain, domainSchemaVersion: '1', operation: 'warning', verified: true,
        verificationScope: ['ha_device_error_observation'], data: facts, warnings: [], error: null,
        effects: [], uncertainty: [], pendingContext: null }) });
    } });
}
/** Opt-in event consumer, never installed/registered by this source slice.
 * Original input, native source and independent physical proof remain separate
 * capabilities. Serialized fields and the last requester confer no authority. */
export function createJessicaCompletionEventEntry(deps: {
  registry: Registry; policyConfig: unknown; roster: FamilyRoutes; state: OperationState;
  source: (CurrentRequestEvidence & { readonly cutoff: ConversationCutoff }) | NativeCurrentInputEvidence;
  now(): number; readAuthority: GrantedSourceDependencies['readAuthority'];
  readEvidence(input: SourceInput, operation: OperationCorrelation): Promise<null | {
    proof: unknown; assertCurrent(proof: unknown): unknown;
  }>;
}) {
  const policy = loadPolicy(deps.policyConfig); assertRosterPolicyAgreement(deps.roster, policy);
  return Object.freeze({ entityIds: Object.freeze([deps.registry.mapBinding.deviceEntity]),
    prepareRequest: prepareJessicaCompletionEvent,
    async execute(input: SourceInput, assertCurrent: () => void) {
      if (input.domain !== 'jessica-vacuum' || input.source.type !== 'ha' || input.scope !== 'read') fail('jessica_completion_admission_invalid');
      let expected: NoRunOutcome | undefined;
      let operation: OperationCorrelation | undefined;
      let witness: Awaited<ReturnType<typeof deps.readEvidence>> = null;
      let verifiedProof: ReturnType<typeof verifyJessicaCompletionProof> = null;
      const originalContext = createCurrentRequestContext(deps.source);
      let originalProjection: CurrentRequestProjection | undefined;
      const current = () => {
        assertion(assertCurrent(), 'jessica_completion_source_async');
        if (operation) {
          if (!originalProjection) {
            const captured = originalContext.projectCurrentRequest();
            if (captured.status !== 'available') fail('jessica_completion_origin_not_current');
            originalProjection = captured;
          }
          const projection = originalContext.revalidateProjection(originalProjection);
          if (projection.status !== 'available' || !isDeepStrictEqual(deps.source.binding, operation.origin.binding) ||
            !isDeepStrictEqual(sourceOrigin(deps.source), operation.origin) ||
            projection.context.current.entryId !== operationInputId(operation.origin)) fail('jessica_completion_origin_not_current');
          const route = operation.origin.binding;
          const identity = resolveTrustedIdentity({ channel: route.channel, accountId: route.accountId,
            to: route.peerId, senderId: route.requesterId }, deps.roster);
          authorize(policy, identity, 'control');
          if (identity.senderId !== operation.owner.requesterId) fail('jessica_completion_recipient_changed');
        }
        if (verifiedProof && witness) assertion(witness.assertCurrent(verifiedProof), 'jessica_completion_witness_async');
      };
      const project = () => projectJessicaCompletionEvent(JSON.parse(input.request), deps.registry, deps.now());
      const controller = createSourceAdmissionController({ now: deps.now, readAuthority: deps.readAuthority, assertCurrent: current,
        assertDomainOutcome(outcome) {
          current(); project();
          if (!expected || !isDeepStrictEqual(outcome, boundedCopy(expected))) fail('jessica_completion_outcome_mismatch');
        } });
      const admission = controller.admit(input), event = project();
      const candidate = await deps.state.completionCandidate(); current();
      let disposition: NoRunOutcome['disposition'] = 'unresolved';
      let reason = 'JESSICA_COMPLETION_NOT_PROVEN';
      let level: string | null = null;
      if (candidate) {
        operation = candidate.correlation; current();
        if (candidate.claimed) { disposition = 'suppressed'; reason = 'JESSICA_COMPLETION_ALREADY_CLAIMED'; }
        else {
          witness = await deps.readEvidence(input, operation); current();
          const start = candidate.start.data;
          const at = start && 'observation' in start ? start.observation?.observedAt : null;
          if (witness && at) verifiedProof = verifyJessicaCompletionProof(witness.proof, event, operation, input.source, at, deps.registry);
          current();
          if (verifiedProof) {
            const claim = { evidenceRef: admission.source.inputId, observedAt: event.timeFired, sourceRef: admission.source.ref };
            const claimed = await deps.state.claimCompletion(operation, claim); current();
            if (claimed === 'duplicate') { disposition = 'suppressed'; reason = 'JESSICA_COMPLETION_ALREADY_CLAIMED'; }
            else if (claimed === 'claimed' && await deps.state.completionCurrent(operation, claim)) {
              current(); disposition = 'handled'; level = verifiedProof.level;
            }
          }
        }
      }
      current();
      const handled = disposition === 'handled', suppressed = disposition === 'suppressed';
      const facts = freeze({ status: handled ? 'success' : suppressed ? 'not_applicable' : 'unknown',
        domain: admission.domain, domainSchemaVersion: '1', operation: 'clean_completion',
        verified: handled ? true : suppressed ? 'not_applicable' : false,
        verificationScope: handled ? [level === 'simulated' ? 'simulated_room_cleaning_completion' : 'room_cleaning_completion'] : [],
        data: { operationId: operation?.owner.operationId ?? null, room: operation?.plan.rooms[0]?.slug ?? null,
          completion: handled ? 'verified' : 'unknown', proofLevel: level,
          originalReturnRoute: handled ? operation!.origin.binding : null, physicalCustodyReleased: false },
        warnings: [], error: null, effects: [], uncertainty: handled || suppressed ? [] : [{ code: reason }], pendingContext: null });
      expected = freeze({ schemaVersion: 1, kind: 'benson.no-run',
        admission: { inputId: admission.source.inputId, sourceType: admission.source.type, sourceRef: admission.source.ref,
          authorityRef: admission.authority.ref, authorityRevision: admission.authority.revision,
          domain: admission.domain, subject: admission.authority.subject }, disposition,
        evidence: { ref: admission.source.inputId, observedAt: event.timeFired, freshness: 'fresh', facts },
        effects: { status: 'none', refs: [] }, reconciliation: { required: false, reason: null }, notification: null,
        error: handled || suppressed ? null : { code: reason, message: 'Exact room-cleaning completion is not independently proven.', retryable: false } });
      const response = controlReadResponse(expected, { controller, admission,
        renderOutcome: () => ({ schemaVersion: 2, message: handled ? level === 'simulated'
          ? 'Simulation only: the requested room cleaning completed; no device or message was sent.'
          : 'The requested room cleaning completed.' : 'Jessica completion is unverified; no success notification is authorized.' }) });
      return createNoRunDomainResult(response, { controller, admission, language: 'en', normalizeFacts: () => facts });
    } });
}
/** Opt-in intent entry; deterministic status remains independently strict. */
// Native parameter normalization inspects direct object variants only.
export const JESSICA_TASK_ENTRY_SCHEMA = Type.Union([JESSICA_TASK_SCHEMA, ...TaskEnvelopeSchema.anyOf]);

/** Semantic custody only. The executor still owns policy, idempotency, device
 * reservation and every pre-dispatch authorization check. */
export function bindJessicaTaskPending(task: TaskEnvelope, history: Parameters<typeof reconstructDomainPending>[0],
  source: CurrentRequestProjection, clock: () => Date, assertCurrent: () => void) {
  const reference = (pending: NonNullable<AnyDomainResult['pendingContext']>, result: AnyDomainResult,
    at = new Date(Date.parse(pending.expiresAt) - 1)): ConsumedPending => {
    const value = validateResult({ schemaVersion: result.domainSchemaVersion, status: result.outcome.status,
      domain: result.domain, operation: result.operation, verified: result.facts.verified,
      data: readDomainFactsData(result.facts.data).value, warnings: result.warnings, error: result.failures.domain,
      pendingContext: pending.value }, null, at);
    if (result.executionMode !== 'agentic' || value.status !== 'clarification_required' || value.operation !== 'clean' ||
      !value.pendingContext || value.pendingContext.expiresAt !== pending.expiresAt) fail('jessica_pending_invalid');
    return { schemaVersion: 1, domain: 'jessica-vacuum', binding: pending.binding, clarificationId: value.pendingContext.clarificationId };
  };
  const view = reconstructDomainPending(history, { domain: 'jessica-vacuum',
    binding: { requesterId: source.context.conversation.requesterId, conversationId: source.context.conversation.conversationRef },
    currentInputId: source.context.current.entryId!, reference, clock, assertCurrent,
    replacement(previous, result) {
      if (!result.pendingContext || previous.value.clarificationId === result.pendingContext.value.clarificationId) fail('jessica_pending_replacement_invalid');
    } });
  const binding = view.bindTask(task), selected = binding.selected;
  return Object.freeze({ ...binding,
    assertRequest(raw: unknown) {
      binding.assertCurrent(); if (!selected) return;
      const request = parseExecuteRequest(raw), data = readDomainFactsData(selected.result.facts.data).value;
      if (request.operation !== 'clean' || request.target.kind !== 'rooms' || request.settings !== undefined ||
        request.target.rooms.length !== 1) fail('jessica_pending_request_mismatch');
      const room = request.target.rooms[0];
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
        !Array.isArray(data.candidates) || !data.candidates.some(item => item && typeof item === 'object' &&
          !Array.isArray(item) && item.room === room)) fail('jessica_pending_request_mismatch');
    },
    project(result: AnyDomainResult): AnyDomainResult {
      binding.assertCurrent();
      if (!selected) return result;
      if (result.domain !== 'jessica-vacuum' || result.operation !== 'clean') fail('jessica_pending_outcome_mismatch');
      const terminal = ['success', 'failure', 'clarification_required'].includes(result.outcome.status) &&
        result.failures.handling === null && !result.evidence.gaps.length && !result.uncertainty.length &&
        result.effects.status !== 'possible' && !result.effects.reconciliation.required;
      if (terminal && result.pendingContext) {
        const next = reference(result.pendingContext, result, clock());
        if (next.domain !== 'jessica-vacuum' || next.clarificationId === selected.pending.value.clarificationId ||
          next.binding.requesterId !== selected.reference.binding.requesterId ||
          next.binding.conversationId !== selected.reference.binding.conversationId) fail('jessica_pending_replacement_invalid');
      }
      return withDomainPending(result, terminal ? selected.reference : null);
    },
  });
}
export async function executeJessicaStatusTask(source: string | { controller: SourceAdmissionController<NativeDispatchReadAdmission>;
  admission: NativeDispatchReadAdmission }, raw: unknown, { identity, authority, read, clock = () => new Date() }:
  { identity: unknown; authority: InvocationAuthority; read: (request: unknown, identity: unknown, authority: InvocationAuthority) => Promise<Result>; clock?: () => Date }) {
  decode(JESSICA_TASK_SCHEMA, raw, 'jessica_task_intent_invalid');
  const trusted = decode(IdentitySchema, identity, 'jessica_task_identity_invalid');
  const controller: SourceAdmissionController = typeof source === 'string' ? createSourceAdmissionController({ invocation: { callId: source, domain: 'jessica-vacuum', subject: trusted.senderId }, now: () => clock().getTime(),
    assertCurrent() { authority.signal.throwIfAborted(); assertInvocationCurrent(authority); }, assertDomainOutcome(outcome) {
      const facts = validateResult(outcome.evidence.facts, null, clock());
      if (facts.operation !== 'status' || outcome.disposition !== (facts.status === 'success' ? 'handled' : 'failed') ||
        outcome.evidence.observedAt !== (facts.data && 'observedAt' in facts.data ? facts.data.observedAt : null)) throw new Error('jessica_task_evidence_mismatch');
    } }) : source.controller;
  const admission = typeof source === 'string' ? controller.admit({ schemaVersion: NATIVE_READ_ADMISSION_VERSION, kind: 'benson.source-input', domain: 'jessica-vacuum', scope: 'read', request: JSON.stringify(raw) }) : source.admission;
  if ((admission.schemaVersion !== 2 && admission.schemaVersion !== 3) || admission.domain !== 'jessica-vacuum' || admission.authority.subject !== trusted.senderId ||
      admission.request !== JSON.stringify(raw)) throw new Error('jessica_task_admission_mismatch');
  controller.assertCurrent(admission);
  authority.signal.throwIfAborted(); assertInvocationCurrent(authority);
  const facts = await read(raw, trusted, { signal: authority.signal, assertCurrent: () => controller.assertCurrent(admission) });
  const data = facts.data && 'kind' in facts.data && facts.data.kind === 'status' ? facts.data : null;
  const correlation = admission.schemaVersion === 3 ? { schemaVersion: 3 as const,
    admission: { authorityKind: admission.authority.kind, requestId: admission.requestId, domain: admission.domain, subject: admission.authority.subject } } :
    admission.schemaVersion === 2 ? { schemaVersion: NATIVE_READ_OUTCOME_VERSION,
      admission: { authorityKind: admission.authority.kind, callId: admission.callId, domain: admission.domain, subject: admission.authority.subject } } :
      (() => { throw new Error('jessica_task_admission_mismatch'); })();
  const response = controlReadResponse({ ...correlation, kind: 'benson.no-run', disposition: facts.status === 'success' ? 'handled' : 'failed',
    evidence: { ref: admission.schemaVersion === 3 ? admission.requestId : admission.callId, observedAt: data?.observedAt ?? null, freshness: data?.freshness ?? 'unknown', facts },
    effects: { status: 'none', refs: [] }, reconciliation: { required: false, reason: null }, notification: null,
    error: facts.error ? { code: facts.error.code, message: facts.error.message, retryable: facts.error.retryable } : null }, { controller, admission,
      renderOutcome: () => ({ schemaVersion: RESPONSE_CONTRACT_VERSION, message: renderJessicaStatusText(facts, clock()) }) });
  const result = createNoRunDomainResult(response, { controller, admission, language: 'he', normalizeFacts(value) {
    const validated = validateResult(value, null, clock());
    return { status: validated.status, domain: validated.domain, domainSchemaVersion: validated.schemaVersion, operation: validated.operation,
      verified: validated.verified, verificationScope: validated.verified ? ['status_read'] : [], data: validated.data, warnings: validated.warnings, error: validated.error,
      effects: [], uncertainty: [], pendingContext: null };
  } });
  controller.assertCurrent(admission); return result;
}

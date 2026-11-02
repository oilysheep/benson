import { assertInvocationCurrent } from '../../../integrations/openclaw/benson-routing/core/invocation.js';
import Type from 'typebox';
import { object, decode } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { createSourceAdmissionController, NATIVE_READ_ADMISSION_VERSION } from '../../../integrations/openclaw/benson-routing/core/request-control.js';
import { createNoRunDomainResult, NATIVE_READ_OUTCOME_VERSION, RESPONSE_CONTRACT_VERSION } from '../../../integrations/openclaw/benson-routing/core/envelope.js';
import { controlReadResponse } from '../../../integrations/openclaw/benson-routing/core/response-control.js';
import { executeReminderTool, type Dependencies } from './service.js';
import { verifiedList, safeListResult, discoveryData } from './results.js';
import { renderReminderList } from './presentation.js';
import { TaskEnvelopeSchema, type TaskEnvelope, type ConsumedPending, type AnyDomainResult } from '../../../integrations/openclaw/benson-routing/core/contracts.js';
import { reconstructDomainPending } from '../../../integrations/openclaw/benson-routing/core/conversation-context.js';
import { withDomainPending } from '../../../integrations/openclaw/benson-routing/core/domain-result.js';
import { ProvenanceSchema, type ServiceRequest } from './schemas.js';
import { isDeepStrictEqual } from 'node:util';
import { read, fail, boundedCopy } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { plain } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { normalizeReminderServiceResult } from './results.js';
import type { CurrentRequestProjection } from '../../../integrations/openclaw/benson-routing/core/conversation-context.js';
export const REMINDER_TASK_SCHEMA = object({ operation: Type.Literal('list') });
/** Opt-in only; the existing list entry and its consumers remain strict. */
// Native parameter normalization inspects direct object variants only.
export const REMINDER_TASK_ENTRY_SCHEMA = Type.Union([REMINDER_TASK_SCHEMA, ...TaskEnvelopeSchema.anyOf]);

/** Minimal create continuation over the existing provenance contract. Other
 * pending value shapes and lifecycle selections remain unavailable. */
export function bindReminderTaskPending(task: TaskEnvelope, history: Parameters<typeof reconstructDomainPending>[0],
  source: CurrentRequestProjection, deps: Pick<Dependencies, 'route' | 'clock'>, assertCurrent: () => void) {
  const clock = deps.clock ?? (() => new Date());
  const provenance = (pending: NonNullable<AnyDomainResult['pendingContext']>) => {
    const value = read(ProvenanceSchema, pending.value, 'reminder_pending_unsupported');
    if (value.requesterId !== deps.route.requesterId || value.sourceConversation.type !== deps.route.sourceType ||
      value.sourceConversation.id !== deps.route.sourceId || value.contextId !== source.context.conversation.conversationRef ||
      value.expiresAt !== pending.expiresAt || !Number.isFinite(Date.parse(value.createdAt)) ||
      Date.parse(value.createdAt) >= Date.parse(value.expiresAt) || value.revision !== value.evidence.length ||
      new Set(value.evidence.map(item => item.id)).size !== value.evidence.length ||
      value.evidence.at(-1)?.id !== value.currentEvidenceId || value.fieldEvidence.some(item =>
        !value.evidence.find(evidence => evidence.id === item.evidenceId)?.text.includes(item.quote))) fail('reminder_pending_invalid');
    return value;
  };
  const reference = (pending: NonNullable<AnyDomainResult['pendingContext']>, result: AnyDomainResult): ConsumedPending => {
    const value = provenance(pending);
    if (result.executionMode !== 'agentic' || result.operation !== 'create' || result.outcome.status !== 'clarification_required' ||
      !history.results.some(row => isDeepStrictEqual(boundedCopy(row.result.pendingContext), boundedCopy(pending)) &&
        row.requestId === value.currentEvidenceId)) fail('reminder_pending_invalid');
    return { schemaVersion: 1, domain: 'reminder', binding: pending.binding,
      contextId: value.contextId, revision: value.revision, currentEvidenceId: value.currentEvidenceId };
  };
  const successor = (previous: NonNullable<AnyDomainResult['pendingContext']>, next: unknown) => {
    const old = provenance(previous), value = read(ProvenanceSchema, next, 'reminder_pending_provenance_required');
    if (value.contextId !== old.contextId || value.requesterId !== old.requesterId ||
      !isDeepStrictEqual(value.sourceConversation, old.sourceConversation) || value.createdAt !== old.createdAt ||
      value.expiresAt !== old.expiresAt || value.revision !== old.revision + 1 ||
      value.evidence.length !== old.evidence.length + 1 || !isDeepStrictEqual(value.evidence.slice(0, -1), old.evidence) ||
      value.evidence.at(-1)?.id !== value.currentEvidenceId || value.currentEvidenceId === old.currentEvidenceId) fail('reminder_pending_successor_invalid');
    return value;
  };
  const view = reconstructDomainPending(history, { domain: 'reminder',
    binding: { requesterId: source.context.conversation.requesterId, conversationId: source.context.conversation.conversationRef },
    currentInputId: source.context.current.entryId!, reference, clock, assertCurrent,
    replacement(previous, result) { if (!result.pendingContext) fail('reminder_pending_successor_invalid'); successor(previous, result.pendingContext.value); } });
  const binding = view.bindTask(task), selected = binding.selected;
  return Object.freeze({ ...binding,
    assertRequest(request: ServiceRequest) {
      binding.assertCurrent(); if (!selected || request.operation === 'list-reminders' || request.operation === 'find-reminders') return;
      if (request.operation !== 'create-intent' || 'items' in request.input) fail('reminder_pending_operation_unsupported');
      const value = successor(selected.pending, request.input.provenance);
      if (value.currentEvidenceId !== source.context.current.entryId || value.evidence.at(-1)?.text !== source.context.current.text) fail('reminder_pending_current_input_mismatch');
    },
    project(result: AnyDomainResult): AnyDomainResult {
      binding.assertCurrent();
      if (result.pendingContext) {
        const pending = result.pendingContext, value = provenance(pending), time = clock().getTime();
        if (result.executionMode !== 'agentic' || result.operation !== 'create' || result.outcome.status !== 'clarification_required' ||
            result.failures.handling !== null || result.evidence.gaps.length || result.uncertainty.length || result.warnings.length ||
            result.effects.status !== 'none' || result.effects.reconciliation.required ||
            pending.binding.requesterId !== source.context.conversation.requesterId ||
            pending.binding.conversationId !== source.context.conversation.conversationRef || !Number.isFinite(time) ||
            Date.parse(value.createdAt) > time || Date.parse(value.expiresAt) <= time ||
            value.currentEvidenceId !== source.context.current.entryId || value.evidence.at(-1)?.text !== source.context.current.text) fail('reminder_pending_outcome_invalid');
        if (selected) successor(selected.pending, value);
        else if (value.revision !== 1 || value.evidence.length !== 1) fail('reminder_pending_current_only_required');
      }
      if (!selected) return result;
      if (result.domain !== 'reminder' || result.operation !== 'create') fail('reminder_pending_outcome_mismatch');
      const terminal = ['success', 'failure', 'clarification_required'].includes(result.outcome.status) &&
        result.failures.handling === null && !result.evidence.gaps.length && !result.uncertainty.length &&
        result.effects.status !== 'possible' && !result.effects.reconciliation.required;
      return withDomainPending(result, terminal ? selected.reference : null);
    },
  });
}
/** Current-input creation uses the existing transaction and provenance owner.
 * Legacy callers retain their existing evidence rules; this entry requires the
 * full bundle and the exact original input identity before any transaction.
 */
export async function executeReminderCreateTask(callId: string, raw: unknown, source: CurrentRequestProjection, deps: Dependencies) {
  assertInvocationCurrent(deps.authority);
  assertReminderCreateSource(raw, source);
  const result = await executeReminderTool('benson_reminder_create', raw, deps);
  assertInvocationCurrent(deps.authority);
  return normalizeReminderServiceResult('create-intent', result, { taskId: callId, pendingBinding: null, pendingExpiresAt: null });
}
/** Shared by the existing task entry and its raw native tool adapter. */
export function assertReminderCreateSource(raw: unknown, source: CurrentRequestProjection): void {
  const inputs = plain(raw) && plain(raw.input) && Array.isArray(raw.input.items) ? raw.input.items
    : [plain(raw) ? raw.input : null];
  for (const input of inputs) {
    if (!source.context.current.entryId || !plain(input) || !plain(input.provenance) ||
      input.provenance.currentEvidenceId !== source.context.current.entryId ||
      input.provenance.contextId !== source.context.conversation.conversationRef) throw new Error('reminder_original_input_provenance_required');
  }
}
/** Deterministic domain entry. The native adapter must supply live host custody. */
export async function executeReminderListTask(callId: string, raw: unknown, deps: Dependencies) {
  decode(REMINDER_TASK_SCHEMA, raw, 'reminder_task_intent_invalid');
  const clock = deps.clock ?? (() => new Date());
  const controller = createSourceAdmissionController({ invocation: { callId, domain: 'reminder', subject: deps.route.requesterId }, now: () => clock().getTime(),
    assertCurrent() { deps.authority.signal.throwIfAborted(); assertInvocationCurrent(deps.authority); },
    assertDomainOutcome(outcome) {
      const facts = safeListResult(outcome.evidence.facts);
      if (facts.status === 'success') verifiedList(outcome.evidence.facts);
      if (outcome.disposition !== (facts.status === 'success' ? 'handled' : 'failed') || facts.status === 'failure' && outcome.error?.code !== facts.error.code) throw new Error('reminder_task_evidence_mismatch');
    } });
  const admission = controller.admit({ schemaVersion: NATIVE_READ_ADMISSION_VERSION, kind: 'benson.source-input', domain: 'reminder', scope: 'read', request: JSON.stringify(raw) });
  let facts;
  try { facts = safeListResult(await executeReminderTool('benson_reminder_list', { requesterId: deps.route.requesterId }, deps)); }
  catch { controller.assertCurrent(admission); facts = safeListResult(null); }
  controller.assertCurrent(admission);
  const response = controlReadResponse({ schemaVersion: NATIVE_READ_OUTCOME_VERSION, kind: 'benson.no-run',
    admission: { authorityKind: admission.authority.kind, callId, domain: admission.domain, subject: admission.authority.subject },
    disposition: facts.status === 'success' ? 'handled' : 'failed', evidence: { ref: callId, observedAt: clock().toISOString(), freshness: 'fresh', facts },
    effects: { status: 'none', refs: [] }, reconciliation: { required: false, reason: null }, notification: null,
    error: facts.status === 'failure' ? facts.error : null }, { controller, admission,
    renderOutcome: outcome => ({ schemaVersion: RESPONSE_CONTRACT_VERSION, message: renderReminderList(safeListResult(outcome.evidence.facts), clock()) }) });
  const result = createNoRunDomainResult(response, { controller, admission, language: 'he', normalizeFacts(value) {
    const list = safeListResult(value);
    return { status: list.status, domain: 'reminder', domainSchemaVersion: 'legacy-unversioned', operation: 'list', verified: list.verified,
      verificationScope: list.verified ? ['full_list_read'] : [], data: list.status === 'success' ? discoveryData(list) : null,
      warnings: list.warnings, error: list.status === 'failure' ? list.error : null, effects: [], uncertainty: [], pendingContext: null };
  } });
  controller.assertCurrent(admission);
  return result;
}

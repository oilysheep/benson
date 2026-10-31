import { assertInvocationCurrent } from '../../../integrations/openclaw/benson-routing/core/invocation.js';
import Type from 'typebox';
import { object, decode } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { createSourceAdmissionController, NATIVE_READ_ADMISSION_VERSION } from '../../../integrations/openclaw/benson-routing/core/request-control.js';
import { createNoRunDomainResult, NATIVE_READ_OUTCOME_VERSION, RESPONSE_CONTRACT_VERSION } from '../../../integrations/openclaw/benson-routing/core/envelope.js';
import { controlReadResponse } from '../../../integrations/openclaw/benson-routing/core/response-control.js';
import { executeReminderTool, type Dependencies } from './service.js';
import { verifiedList, safeListResult, discoveryData } from './results.js';
import { renderReminderList } from './presentation.js';
export const REMINDER_TASK_SCHEMA = object({ operation: Type.Literal('list') });
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

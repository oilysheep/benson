import { assertInvocationCurrent } from '../../../integrations/openclaw/benson-routing/core/invocation.js';
import Type from 'typebox';
import { object, decode } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { createSourceAdmissionController, NATIVE_READ_ADMISSION_VERSION } from '../../../integrations/openclaw/benson-routing/core/request-control.js';
import { createNoRunDomainResult, NATIVE_READ_OUTCOME_VERSION, RESPONSE_CONTRACT_VERSION } from '../../../integrations/openclaw/benson-routing/core/envelope.js';
import { controlReadResponse } from '../../../integrations/openclaw/benson-routing/core/response-control.js';
import { formatUserDatetime } from '../../../shared/benson-datetime.js';
import { validateResult, type Result } from './results.js';
import { IdentitySchema } from './schemas.js';
import type { InvocationAuthority } from './ports.js';
export async function executeJessicaStatusTask(callId: string, raw: unknown, { identity, authority, read, clock = () => new Date() }:
  { identity: unknown; authority: InvocationAuthority; read: (request: unknown, identity: unknown, authority: InvocationAuthority) => Promise<Result>; clock?: () => Date }) {
  decode(object({ operation: Type.Literal('status') }), raw, 'jessica_task_intent_invalid');
  const trusted = decode(IdentitySchema, identity, 'jessica_task_identity_invalid');
  const controller = createSourceAdmissionController({ invocation: { callId, domain: 'jessica-vacuum', subject: trusted.senderId }, now: () => clock().getTime(),
    assertCurrent() { authority.signal.throwIfAborted(); assertInvocationCurrent(authority); }, assertDomainOutcome(outcome) {
      const facts = validateResult(outcome.evidence.facts, null, clock());
      if (facts.operation !== 'status' || outcome.disposition !== (facts.status === 'success' ? 'handled' : 'failed') ||
        outcome.evidence.observedAt !== (facts.data && 'observedAt' in facts.data ? facts.data.observedAt : null)) throw new Error('jessica_task_evidence_mismatch');
    } });
  const admission = controller.admit({ schemaVersion: NATIVE_READ_ADMISSION_VERSION, kind: 'benson.source-input', domain: 'jessica-vacuum', scope: 'read', request: JSON.stringify(raw) });
  const facts = await read(raw, trusted, { signal: authority.signal, assertCurrent: () => controller.assertCurrent(admission) });
  const data = facts.data && 'kind' in facts.data && facts.data.kind === 'status' ? facts.data : null;
  const response = controlReadResponse({ schemaVersion: NATIVE_READ_OUTCOME_VERSION, kind: 'benson.no-run',
    admission: { authorityKind: admission.authority.kind, callId, domain: admission.domain, subject: admission.authority.subject }, disposition: facts.status === 'success' ? 'handled' : 'failed',
    evidence: { ref: callId, observedAt: data?.observedAt ?? null, freshness: data?.freshness ?? 'unknown', facts },
    effects: { status: 'none', refs: [] }, reconciliation: { required: false, reason: null }, notification: null,
    error: facts.error ? { code: facts.error.code, message: facts.error.message, retryable: facts.error.retryable } : null }, { controller, admission,
      renderOutcome: () => ({ schemaVersion: RESPONSE_CONTRACT_VERSION, message: data && facts.status === 'success' ?
        `מצב Jessica: ${data.state}; סוללה: ${data.batteryLevel === null ? 'לא ידוע' : `${data.batteryLevel}%`}. לפי נתוני Home Assistant שנקראו ${formatUserDatetime(data.observedAt, 'Asia/Jerusalem', { now: clock() })}.` :
        'לא ניתן לאמת כעת את מצב Jessica. לא בוצעה פעולה במכשיר.' }) });
  const result = createNoRunDomainResult(response, { controller, admission, language: 'he', normalizeFacts(value) {
    const validated = validateResult(value, null, clock());
    return { status: validated.status, domain: validated.domain, domainSchemaVersion: validated.schemaVersion, operation: validated.operation,
      verified: validated.verified, verificationScope: validated.verified ? ['status_read'] : [], data: validated.data, warnings: validated.warnings, error: validated.error,
      effects: [], uncertainty: [], pendingContext: null };
  } });
  controller.assertCurrent(admission); return result;
}

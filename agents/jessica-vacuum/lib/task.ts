import { assertInvocationCurrent } from '../../../integrations/openclaw/benson-routing/core/invocation.js';
import Type from 'typebox';
import { object, decode } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { createSourceAdmissionController, NATIVE_READ_ADMISSION_VERSION, type SourceAdmissionController } from '../../../integrations/openclaw/benson-routing/core/request-control.js';
import type { NativeDispatchReadAdmission } from '../../../integrations/openclaw/benson-routing/core/contracts.js';
import { createNoRunDomainResult, NATIVE_READ_OUTCOME_VERSION, RESPONSE_CONTRACT_VERSION } from '../../../integrations/openclaw/benson-routing/core/envelope.js';
import { controlReadResponse } from '../../../integrations/openclaw/benson-routing/core/response-control.js';
import { renderJessicaStatusText } from './presentation.js';
import { validateResult, type Result } from './results.js';
import { IdentitySchema } from './schemas.js';
import type { InvocationAuthority } from './ports.js';
export const JESSICA_TASK_SCHEMA = object({ operation: Type.Literal('status') });
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

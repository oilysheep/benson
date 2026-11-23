import { AdmissionSchema, NoRunSchema, type Admission, type NoRunOutcome } from './contracts.js';
import { assertIds, decode, fail, freeze, identifier, read, timestamp, MAX_RENDERED_TEXT } from './value.js';
import { isDeepStrictEqual } from 'node:util';

/** Existing v1 observation contract; this is not admission or outbound authority. */
export function assertNoRunObservation(outcome: NoRunOutcome, admission: Admission): void {
  if (outcome.schemaVersion === 2 || outcome.schemaVersion === 3) return;
  if (admission.schemaVersion !== 1 || admission.source.type !== 'ha' ||
      !['read', 'reconcile'].includes(admission.scope) || outcome.effects.status !== 'none' ||
      outcome.reconciliation.required || outcome.notification !== null) fail('no_run_observation_required');
}

/** Correlation only. The admission controller supplies identity and live custody. */
export function validateNoRunOutcome(raw: unknown, rawAdmission: unknown): NoRunOutcome {
  const value = read(NoRunSchema, raw, 'no_run_version_or_disposition');
  const admission = decode(AdmissionSchema, rawAdmission, 'no_run_version_or_disposition');
  if (value.schemaVersion !== admission.schemaVersion) fail('no_run_version_or_disposition');
  if (value.schemaVersion === 5 && admission.schemaVersion === 5) {
    const expected = { authorityKind: admission.authority.kind, requestId: admission.requestId,
      domain: admission.domain, subject: admission.authority.subject };
    if (Object.entries(expected).some(([key, part]) => !identifier(part) || Reflect.get(value.admission, key) !== part) ||
      !isDeepStrictEqual(value.admission.action, admission.action)) fail('no_run_admission_mismatch');
  } else if (value.schemaVersion === 3 && admission.schemaVersion === 3) {
    const expected = { authorityKind: admission.authority.kind, requestId: admission.requestId,
      domain: admission.domain, subject: admission.authority.subject };
    if (Object.entries(expected).some(([key, part]) => !identifier(part) ||
      Reflect.get(value.admission, key) !== part)) fail('no_run_admission_mismatch');
  } else if (value.schemaVersion === 2 && admission.schemaVersion === 2) {
    const expected = { authorityKind: admission.authority.kind, callId: admission.callId,
      domain: admission.domain, subject: admission.authority.subject };
    if (Object.entries(expected).some(([key, part]) => !identifier(part) ||
      Reflect.get(value.admission, key) !== part)) fail('no_run_admission_mismatch');
  } else if (value.schemaVersion === 1 && admission.schemaVersion === 1) {
    const expected = { inputId: admission.source.inputId, sourceType: admission.source.type,
      sourceRef: admission.source.ref, authorityRef: admission.authority.ref,
      authorityRevision: admission.authority.revision, domain: admission.domain, subject: admission.authority.subject };
    if (Object.entries(expected).some(([key, part]) => !identifier(part) ||
      Reflect.get(value.admission, key) !== part)) fail('no_run_admission_mismatch');
  } else fail('no_run_version_or_disposition');
  const { evidence, effects, reconciliation, notification, error, disposition } = value;
  if ((evidence.ref !== null && !identifier(evidence.ref)) ||
      (evidence.observedAt !== null && !timestamp(evidence.observedAt)) ||
      (evidence.freshness === 'fresh' && (evidence.ref === null || evidence.observedAt === null || evidence.facts === null)) ||
      (['handled', 'no-change'].includes(disposition) && evidence.freshness !== 'fresh')) fail('no_run_evidence_invalid');
  if (!effects.refs.every(identifier) || (effects.status === 'none') !== (effects.refs.length === 0)) fail('no_run_effects_invalid');
  if ((reconciliation.required ? !identifier(reconciliation.reason) : reconciliation.reason !== null) ||
      (effects.status === 'possible' && !reconciliation.required)) fail('no_run_reconciliation_invalid');
  if (error !== null && (!identifier(error.code) || error.message.length > MAX_RENDERED_TEXT)) fail('no_run_error_invalid');
  if (['failed', 'unresolved', 'rejected'].includes(disposition) !== (error !== null)) fail('no_run_error_disposition_mismatch');
  if (notification !== null) {
    assertIds(notification, ['identity', 'policyRevision', 'evidenceRef'], 'no_run_notification_invalid');
    if (['suppressed', 'rejected'].includes(disposition) || evidence.freshness !== 'fresh' ||
        notification.evidenceRef !== evidence.ref || !Object.values(notification.route).every(identifier) ||
        notification.content.length > MAX_RENDERED_TEXT) fail('no_run_notification_invalid');
  }
  if ((value.schemaVersion === 2 || value.schemaVersion === 3) && (effects.status !== 'none' || reconciliation.required || notification !== null)) {
    fail('native_read_effects_or_notification');
  }
  if (value.schemaVersion === 5 && ((effects.status === 'none' && (value.effects.details.length || reconciliation.required)) ||
    (disposition === 'handled' && (effects.status !== 'known' || reconciliation.required)) ||
    (effects.status === 'possible' && disposition !== 'unresolved' && disposition !== 'failed'))) fail('native_action_effects_invalid');
  return freeze(value);
}

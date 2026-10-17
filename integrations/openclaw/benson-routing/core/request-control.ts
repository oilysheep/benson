import { type Static } from 'typebox';
import { GrantSchema, InvocationSchema, NativeReadInputSchema, SourceInputSchema,
  NativeRequestAdmissionSchema, type Admission, type SourceAdmission, type SourceInput,
  type NativeReadAdmission, type NoRunOutcome, type TaskEnvelope } from './contracts.js';
import { assertion, decode, exact, fail, freeze, identifier, read, synchronous } from './value.js';
import { createTaskEnvelope } from './task-envelope.js';
import { validateNoRunOutcome } from './no-run.js';
export { SOURCE_ADMISSION_VERSION, NATIVE_READ_ADMISSION_VERSION } from './contracts.js';

export const MAX_CLASSIFIER_REQUEST_BYTES = 8192;
export const ROUTING_PREVIOUS_MESSAGES = 5;
export const MAX_ROUTING_CONTEXT_BYTES = 32768;
export const MAX_ROUTING_WORKFLOW_BYTES = 8192;
export const MAX_ROUTING_REFERENCES = 16;
export const MAX_TRANSCRIPT_HYDRATION_BYTES = 1048576;
export const MAX_TRANSCRIPT_HYDRATION_EVENTS = 1024;
export const ROUTING_TRANSCRIPT_TIERS = Object.freeze([
  Object.freeze({ maxBytes: 262144, maxEvents: 256 }),
  Object.freeze({ maxBytes: 524288, maxEvents: 512 }),
  Object.freeze({ maxBytes: MAX_TRANSCRIPT_HYDRATION_BYTES, maxEvents: MAX_TRANSCRIPT_HYDRATION_EVENTS }),
]);
const REASONS = new Set(['non_external', 'command', 'plugin_binding', 'already_owned', 'cancelled',
  'duplicate_or_recovery', 'unsupported_input', 'identity_unavailable', 'non_main_owner', 'empty_or_oversized']);
type ProjectedAdmission = Readonly<{ kind: 'candidate'; trusted: Readonly<{ requestId: string; sessionKey: string }>;
  taskEnvelope: TaskEnvelope }> | Readonly<{ kind: 'main_only' | 'bypass'; reason: string }>;
export function projectRequestAdmission(raw: unknown): ProjectedAdmission {
  exact(raw, Object.keys(NativeRequestAdmissionSchema.properties), 'admission_shape_or_version');
  if (raw.schemaVersion !== 1) fail('admission_shape_or_version');
  const value = decode(NativeRequestAdmissionSchema, raw, raw.kind === 'candidate' ? 'candidate_admission_invalid' : 'blocked_admission_invalid');
  if (value.kind === 'candidate') {
    if (value.reason !== null || !identifier(value.requestId) || !identifier(value.sessionKey) ||
        !validRequest(value.request)) fail('candidate_admission_invalid');
    return freeze({ kind: 'candidate', trusted: freeze({ requestId: value.requestId, sessionKey: value.sessionKey }),
      taskEnvelope: createTaskEnvelope(value.request) });
  }
  if (value.reason === null || !REASONS.has(value.reason) || value.request !== null ||
      (value.requestId !== null && !identifier(value.requestId)) ||
      (value.sessionKey !== null && !identifier(value.sessionKey))) fail('blocked_admission_invalid');
  return freeze({ kind: value.kind, reason: value.reason });
}
function validRequest(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && Buffer.byteLength(value, 'utf8') <= MAX_CLASSIFIER_REQUEST_BYTES;
}
export interface SourceAdmissionController<A extends Admission = Admission> {
  admit(raw: unknown): A;
  assertCurrent(admission: A): void;
  validateOutcome(admission: A, raw: unknown): NoRunOutcome;
}
interface CommonDependencies<A extends Admission> {
  assertCurrent(admission?: SourceInput | A): unknown;
  assertDomainOutcome(outcome: NoRunOutcome, admission: A): unknown;
  now(): unknown;
}
export interface GrantedSourceDependencies extends CommonDependencies<SourceAdmission> {
  readAuthority(input: SourceInput | SourceAdmission): unknown;
  invocation?: never;
}
export interface NativeReadDependencies extends CommonDependencies<NativeReadAdmission> {
  invocation: Static<typeof InvocationSchema>;
  readAuthority?: never;
}
export function createSourceAdmissionController(deps: NativeReadDependencies): SourceAdmissionController<NativeReadAdmission>;
export function createSourceAdmissionController(deps: GrantedSourceDependencies): SourceAdmissionController<SourceAdmission>;
export function createSourceAdmissionController(deps: GrantedSourceDependencies | NativeReadDependencies): SourceAdmissionController;
export function createSourceAdmissionController(deps: GrantedSourceDependencies | NativeReadDependencies): SourceAdmissionController {
  if (![deps.assertCurrent, deps.assertDomainOutcome, deps.now].every(part => typeof part === 'function') ||
      (deps.invocation === undefined ? typeof deps.readAuthority !== 'function' : deps.readAuthority !== undefined)) {
    fail('source_authority_dependencies_unavailable');
  }
  const invocation = deps.invocation === undefined ? undefined : freeze(read(InvocationSchema, deps.invocation, 'native_read_context_invalid'));
  if (invocation && !Object.values(invocation).every(identifier)) fail('native_read_context_invalid');
  const admissions = new WeakSet<object>();
  const current = (input?: SourceInput | Admission): void => {
    // The discriminant narrows the callback together with the owned input.
    if (deps.invocation !== undefined) {
      assertion(deps.assertCurrent(input?.schemaVersion === 2 ? input : undefined), 'source_authority_must_be_synchronous');
    } else {
      assertion(deps.assertCurrent(input?.schemaVersion === 1 ? input : undefined), 'source_authority_must_be_synchronous');
    }
  };
  function clock(): number {
    const time = synchronous(deps.now(), 'source_authority_must_be_synchronous');
    if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0 || time > 8640000000000000) fail('source_clock_invalid');
    return time;
  }
  function authority(input: SourceInput | SourceAdmission, expected?: SourceAdmission['authority']) {
    current(input);
    if (deps.invocation !== undefined) fail('source_authority_dependencies_unavailable');
    const raw = synchronous(deps.readAuthority(input), 'source_authority_must_be_synchronous');
    exact(raw, Object.keys(GrantSchema.properties), 'source_contract_shape');
    const grant = read(GrantSchema, raw, 'source_grant_rejected');
    if (![grant.subject, grant.authorityRef, grant.authorityRevision].every(identifier) ||
        grant.inputId !== input.source.inputId || grant.sourceType !== input.source.type || grant.sourceRef !== input.source.ref ||
        grant.domain !== input.domain || !grant.scopes.includes(input.scope) || grant.expiresAt <= clock()) fail('source_grant_rejected');
    if (expected && (grant.authorityRef !== expected.ref || grant.authorityRevision !== expected.revision ||
        grant.subject !== expected.subject)) fail('source_grant_replaced');
    return { authority: { ref: grant.authorityRef, revision: grant.authorityRevision, subject: grant.subject }, scopes: grant.scopes };
  }
  function check(admission: Admission) {
    if (!admissions.has(admission)) fail('source_admission_unowned');
    if (admission.schemaVersion === 2 && invocation !== undefined) {
      current(admission); return { scopes: ['read'] };
    }
    if (admission.schemaVersion !== 1 || invocation !== undefined) fail('source_admission_unowned');
    return authority(admission, admission.authority);
  }
  return freeze({
    admit(raw: unknown): Admission {
      if (invocation !== undefined) {
        exact(raw, Object.keys(NativeReadInputSchema.properties), 'source_contract_shape');
        const input = read(NativeReadInputSchema, raw, 'native_read_input_invalid');
        if (input.domain !== invocation.domain || !validRequest(input.request)) fail('native_read_input_invalid');
        current();
        const admission: NativeReadAdmission = freeze({ ...input, kind: 'benson.source-admission', callId: invocation.callId,
          authority: { kind: 'native-invocation', subject: invocation.subject }, admittedAt: clock() });
        admissions.add(admission); return admission;
      }
      exact(raw, Object.keys(SourceInputSchema.properties), 'source_contract_shape');
      exact(raw.source, ['type', 'ref', 'inputId'], 'source_contract_shape');
      const input = freeze(read(SourceInputSchema, raw, 'source_input_invalid'));
      if (![input.source.ref, input.source.inputId].every(identifier) || !validRequest(input.request)) fail('source_input_invalid');
      const captured = authority(input);
      const admission: SourceAdmission = freeze({ ...input, kind: 'benson.source-admission',
        authority: captured.authority, admittedAt: clock() });
      authority(admission, admission.authority); admissions.add(admission); return admission;
    },
    assertCurrent(admission: Admission): void { check(admission); },
    validateOutcome(admission: Admission, raw: unknown): NoRunOutcome {
      check(admission);
      const outcome = validateNoRunOutcome(raw, admission);
      if (admission.schemaVersion === 2 && deps.invocation !== undefined) {
        assertion(deps.assertDomainOutcome(outcome, admission), 'source_authority_must_be_synchronous');
      } else if (admission.schemaVersion === 1 && deps.invocation === undefined) {
        assertion(deps.assertDomainOutcome(outcome, admission), 'source_authority_must_be_synchronous');
      } else fail('source_admission_unowned');
      const latest = check(admission);
      if (outcome.notification !== null && !latest.scopes.includes('notify')) fail('source_notification_scope_missing');
      if (outcome.evidence.observedAt !== null && Date.parse(outcome.evidence.observedAt) > clock()) fail('source_evidence_in_future');
      return outcome;
    },
  });
}

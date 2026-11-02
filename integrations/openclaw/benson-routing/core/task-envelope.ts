import { ConsumedPendingSchema, TaskEnvelopeV1Schema, TaskEnvelopeV2Schema, TASK_ENVELOPE_KIND, TASK_ENVELOPE_VERSION,
  TASK_ENVELOPE_V2_VERSION, type ConsumedPending, type TaskEnvelope } from './contracts.js';
import { decode, exact, read, plain, fail, freeze } from './value.js';
export { TASK_ENVELOPE_KIND, TASK_ENVELOPE_VERSION, TASK_ENVELOPE_V2_VERSION };
export function createTaskEnvelope(request: unknown): TaskEnvelope {
  if (typeof request !== 'string') fail('request_must_be_string');
  return freeze({ kind: TASK_ENVELOPE_KIND, version: TASK_ENVELOPE_VERSION, request });
}
export function formatTaskEnvelope(request: unknown): string { return JSON.stringify(createTaskEnvelope(request)); }
/** Explicit opt-in; omission never upgrades a legacy current-only request. */
export function createPendingTaskEnvelope(request: unknown, pending: ConsumedPending | null): TaskEnvelope {
  if (typeof request !== 'string') fail('request_must_be_string');
  return freeze({ kind: TASK_ENVELOPE_KIND, version: TASK_ENVELOPE_V2_VERSION,
    request, pending: pending === null ? null : read(ConsumedPendingSchema, pending, 'invalid_envelope_shape') });
}
export function validateTaskEnvelope(raw: unknown): TaskEnvelope {
  if (!plain(raw)) fail('invalid_envelope_shape');
  const version: unknown = Object.getOwnPropertyDescriptor(raw, 'version')?.value;
  exact(raw, Object.keys((version === 1 ? TaskEnvelopeV1Schema : TaskEnvelopeV2Schema).properties), 'invalid_envelope_shape');
  if (version === 1) return createTaskEnvelope(decode(TaskEnvelopeV1Schema, raw, 'invalid_envelope_shape').request);
  // The legacy request is unbounded text. Only the small semantic reference
  // uses bounded JSON preflight; copying the entire envelope would narrow v1.
  const pending = raw.pending === null ? null : read(ConsumedPendingSchema, raw.pending, 'invalid_envelope_shape');
  const value = decode(TaskEnvelopeV2Schema, { ...raw, pending }, 'invalid_envelope_shape');
  return createPendingTaskEnvelope(value.request, value.pending);
}
export function parseTaskEnvelope(serialized: unknown): TaskEnvelope {
  if (typeof serialized !== 'string') fail('envelope_must_be_string');
  let raw: unknown;
  try { raw = JSON.parse(serialized); } catch { return fail('invalid_envelope_json'); }
  return validateTaskEnvelope(raw);
}

import { TaskEnvelopeSchema, TASK_ENVELOPE_KIND, TASK_ENVELOPE_VERSION, type TaskEnvelope } from './contracts.js';
import { decode, exact, fail, freeze } from './value.js';
export { TASK_ENVELOPE_KIND, TASK_ENVELOPE_VERSION };
export function createTaskEnvelope(request: unknown): TaskEnvelope {
  if (typeof request !== 'string') fail('request_must_be_string');
  return freeze({ kind: TASK_ENVELOPE_KIND, version: TASK_ENVELOPE_VERSION, request });
}
export function formatTaskEnvelope(request: unknown): string { return JSON.stringify(createTaskEnvelope(request)); }
export function parseTaskEnvelope(serialized: unknown): TaskEnvelope {
  if (typeof serialized !== 'string') fail('envelope_must_be_string');
  let raw: unknown;
  try { raw = JSON.parse(serialized); } catch { return fail('invalid_envelope_json'); }
  exact(raw, Object.keys(TaskEnvelopeSchema.properties), 'invalid_envelope_shape');
  return createTaskEnvelope(decode(TaskEnvelopeSchema, raw, 'invalid_envelope_shape').request);
}

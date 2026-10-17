import Type, { type Static } from 'typebox';
import { decode, plain } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { normalizeLegacyTaskResult, type TaskResult } from '../../../integrations/openclaw/benson-routing/core/envelope.js';
import { Nonempty, type ServiceOperation } from './schemas.js';

export const SERVICE_OPERATIONS = { 'create-intent': 'create', 'list-reminders': 'list', 'find-reminders': 'find',
  'update-reminder': 'update', 'pause-reminder': 'pause', 'resume-reminder': 'resume', 'delete-reminder': 'delete' } as const;
export const ErrorSchema = Type.Object({ code: Nonempty, message: Type.Optional(Type.String()), retryable: Type.Optional(Type.Boolean()) });
export const ServiceResultSchema = Type.Object({ status: Type.Enum(['success', 'failure']), operation: Type.Enum(Object.values(SERVICE_OPERATIONS)),
  verified: Type.Optional(Type.Boolean()), warnings: Type.Optional(Type.Array(Type.Unknown())), error: Type.Optional(Type.Union([Type.Null(), ErrorSchema])),
  transaction: Type.Optional(Type.Object({ status: Type.String(), verified: Type.Boolean() })),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown())), transport: Type.Optional(Type.Object({ deliveries: Type.Array(Type.Unknown()) })),
  matches: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))), matchCount: Type.Optional(Type.Integer({ minimum: 0 })) });
export type ServiceResult = Static<typeof ServiceResultSchema>;
const ListSchedule = Type.Union([Type.Object({ type: Type.Literal('one-shot'), resolvedTime: Type.String(), timezone: Type.String() }),
  Type.Object({ type: Type.Literal('recurring'), cron: Type.String(), timezone: Type.String() })]);
export const ReminderRecordSchema = Type.Object({ schemaVersion: Type.Literal(4), reminderId: Nonempty, status: Type.Enum(['active', 'paused']),
  content: Nonempty, schedules: Type.Array(ListSchedule, { minItems: 1 }) });
export const ListSuccessSchema = Type.Object({ operation: Type.Literal('list'), status: Type.Literal('success'), verified: Type.Literal(true),
  warnings: Type.Array(Type.Unknown(), { maxItems: 0 }), error: Type.Optional(Type.Null()),
  matchCount: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), matches: Type.Array(ReminderRecordSchema) });
export type ListSuccess = Static<typeof ListSuccessSchema>;
export type ListResult = ListSuccess | { operation: 'list'; status: 'failure'; verified: false; warnings: readonly never[];
  error: { code: string; message: string; retryable: boolean } };
export function verifiedList(raw: unknown): ListSuccess {
  const result = decode(ListSuccessSchema, raw, 'reminder_list_incomplete');
  if (result.matchCount !== result.matches.length || new Set(result.matches.map(item => item.reminderId)).size !== result.matches.length) throw new Error('reminder_list_incomplete');
  return result;
}
export function safeListResult(raw: unknown): ListResult {
  try {
    const result = decode(ServiceResultSchema, raw, 'reminder_list_invalid');
    if (result.operation !== 'list') throw new Error('reminder_list_operation_invalid');
    if (result.status === 'success') return verifiedList(raw);
    if (result.verified === true || !result.error) throw new Error('reminder_list_failure_invalid');
    return { operation: 'list', status: 'failure', verified: false, warnings: [], error: { code: result.error.code,
      message: 'Reminder list could not be verified', retryable: result.error.retryable === true } };
  } catch {
    return { operation: 'list', status: 'failure', verified: false, warnings: [], error: {
      code: 'REMINDER_READ_UNAVAILABLE', message: 'Reminder list could not be verified', retryable: true } };
  }
}
export function discoveryData(result: ListSuccess | ServiceResult): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result).filter(([key]) => !['status', 'operation', 'verified', 'warnings'].includes(key)));
}
export function normalizeReminderServiceResult(operation: ServiceOperation, raw: unknown, trusted: unknown, messageCandidate: unknown = null): TaskResult {
  const result = decode(ServiceResultSchema, raw, 'reminder_result_invalid');
  if (result.operation !== SERVICE_OPERATIONS[operation]) throw new Error('Reminder service operation mismatch');
  const warnings = result.warnings ?? [];
  let data: unknown, verified = false;
  if (result.status === 'success') {
    if (result.error != null || result.verified === false) throw new Error('Reminder success contradicts verification');
    if (result.operation === 'list' || result.operation === 'find') {
      if (result.verified !== true || !result.matches || result.matchCount !== result.matches.length) throw new Error('Reminder discovery incomplete');
      data = discoveryData(result);
    } else {
      if (result.transaction?.status !== 'success' || result.transaction.verified !== true || !result.data || !result.transport) throw new Error('Reminder transaction unverified');
      data = Object.fromEntries(Object.entries(result).filter(([key]) => !['status', 'operation', 'warnings', 'error'].includes(key)));
    }
    verified = true;
  } else {
    if (!plain(result.error)) throw new Error('Reminder failure lacks structured error');
    data = result;
  }
  return normalizeLegacyTaskResult({ status: result.status, domain: 'reminder', operation: result.operation, verified,
    data, warnings, error: result.status === 'failure' ? result.error : null, pendingContext: null }, trusted, messageCandidate);
}

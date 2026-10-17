import Type, { type Static, type TSchema } from 'typebox';
import { object, decode, plain, freeze } from '../../../integrations/openclaw/benson-routing/core/value.js';

export const Nonempty = Type.String({ minLength: 1, pattern: '\\S' });
export const SourceSchema = object({ type: Type.Enum(['private', 'group']), id: Nonempty });
export const MetadataSchema = object({ value: Nonempty, evidenceQuote: Nonempty, evidenceId: Type.Optional(Nonempty) });
const Citation = object({ field: Nonempty, evidenceId: Nonempty, quote: Nonempty });
export const ProvenanceSchema = object({ schemaVersion: Type.Literal(1), contextId: Nonempty, revision: Type.Integer({ minimum: 1 }),
  createdAt: Nonempty, expiresAt: Nonempty, sourceConversation: SourceSchema, requesterId: Nonempty, currentEvidenceId: Nonempty,
  evidence: Type.Array(object({ id: Nonempty, text: Nonempty }), { minItems: 1 }), fieldEvidence: Type.Array(Citation, { minItems: 1 }) });
export type Provenance = Static<typeof ProvenanceSchema>;
export const ScheduleSchema = object({ type: Type.Enum(['one-shot', 'relative', 'recurring']), timezone: Nonempty,
  resolvedTime: Type.Optional(Nonempty), cron: Type.Optional(Nonempty),
  offset: Type.Optional(object({ value: Type.Integer(), unit: Type.Enum(['seconds', 'minutes', 'hours', 'days', 'weeks']) })),
  reference: Type.Optional(Type.Enum(['existing', 'request'])) });
export const OneShotSchema = object({ type: Type.Literal('one-shot'), resolvedTime: Nonempty, timezone: Nonempty });
export const CalendarSchema = object({ requested: Type.Boolean(), durationMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
  calendarId: Type.Optional(Type.Literal('primary')), eventSchedule: Type.Optional(ScheduleSchema),
  summary: Type.Optional(MetadataSchema), description: Type.Optional(MetadataSchema), location: Type.Optional(MetadataSchema) });
export type Calendar = Static<typeof CalendarSchema>;
const Content = Type.String({ minLength: 1, maxLength: 1000 });
const CreateFields = { sourceConversation: SourceSchema, requesterId: Nonempty, recipientIds: Type.Array(Nonempty, { minItems: 1 }),
  content: Content, verbatimRequest: Type.Optional(Nonempty), notifyRecipients: Type.Optional(Type.Boolean()) };
export const CreateInputSchema = object({ ...CreateFields, provenance: Type.Optional(ProvenanceSchema), schedule: Type.Optional(ScheduleSchema),
  schedules: Type.Optional(Type.Array(ScheduleSchema, { minItems: 1, maxItems: 32 })), calendar: CalendarSchema });
export type CreateInput = Static<typeof CreateInputSchema>;
const PlanProvenance = object({ ...ProvenanceSchema.properties, fieldEvidence: Type.Array(object({ ...Citation.properties,
  field: Type.Enum(['content', 'recipientIds', 'schedule', 'calendar.requested', 'calendar.durationMinutes', 'calendar.eventSchedule']) }), { minItems: 1 }) });
export const PlanItemSchema = object({ ...CreateFields, provenance: PlanProvenance, schedule: OneShotSchema,
  calendar: object({ requested: Type.Literal(true), durationMinutes: Type.Integer({ minimum: 1, maximum: 1440 }),
    calendarId: Type.Optional(Type.Literal('primary')), eventSchedule: OneShotSchema }) });
export const PlanInputSchema = object({ items: Type.Array(PlanItemSchema, { minItems: 2, maxItems: 2 }) });
export type PlanItem = Static<typeof PlanItemSchema>;
export const UpdateInputSchema = Type.Object({ recipientId: Type.Optional(Nonempty), content: Type.Optional(Content),
  verbatimRequest: Type.Optional(Nonempty), schedule: Type.Optional(ScheduleSchema), calendar: Type.Optional(CalendarSchema) }, { additionalProperties: false, minProperties: 1 });
const DiscoveryFields = { requesterId: Nonempty, recipient: Type.Optional(Nonempty), enabled: Type.Optional(Type.Boolean()) };
const LifecycleFields = { reminderId: Nonempty, requesterId: Nonempty };
export const PublicSchemas = freeze({
  benson_reminder_create: object({ input: CreateInputSchema }), benson_reminder_create_plan: object({ input: PlanInputSchema }),
  benson_reminder_list: object(DiscoveryFields), benson_reminder_find: object({ ...DiscoveryFields,
    reminderId: Type.Optional(Nonempty), jobId: Type.Optional(Nonempty), text: Type.Optional(Nonempty) }),
  benson_reminder_update: object({ ...LifecycleFields, input: UpdateInputSchema }),
  benson_reminder_pause: object(LifecycleFields), benson_reminder_resume: object(LifecycleFields), benson_reminder_delete: object(LifecycleFields),
});
export type ToolName = keyof typeof PublicSchemas;
export const ServiceRequestSchema = Type.Union([
  object({ operation: Type.Literal('create-intent'), input: Type.Union([CreateInputSchema, PlanInputSchema]) }),
  object({ operation: Type.Literal('list-reminders'), ...PublicSchemas.benson_reminder_list.properties }),
  object({ operation: Type.Literal('find-reminders'), ...PublicSchemas.benson_reminder_find.properties }),
  object({ operation: Type.Literal('update-reminder'), ...PublicSchemas.benson_reminder_update.properties }),
  object({ operation: Type.Literal('pause-reminder'), ...LifecycleFields }),
  object({ operation: Type.Literal('resume-reminder'), ...LifecycleFields }),
  object({ operation: Type.Literal('delete-reminder'), ...LifecycleFields }),
]);
export type ServiceRequest = Static<typeof ServiceRequestSchema>;
export type ServiceOperation = ServiceRequest['operation'];
export function parseToolName(raw: unknown): ToolName {
  switch (raw) {
    case 'benson_reminder_create': case 'benson_reminder_create_plan': case 'benson_reminder_list': case 'benson_reminder_find':
    case 'benson_reminder_update': case 'benson_reminder_pause': case 'benson_reminder_resume': case 'benson_reminder_delete': return raw;
    default: throw new TypeError('reminder_tool_unknown');
  }
}
/** The retained calendar=false projection intentionally discards irrelevant metadata. */
export function canonicalParams(raw: unknown): unknown {
  if (plain(raw) && plain(raw.input) && plain(raw.input.calendar) && raw.input.calendar.requested === false) return { ...raw, input: { ...raw.input, calendar: { requested: false } } };
  return raw;
}
export function parseRequest(name: ToolName, raw: unknown): ServiceRequest {
  const value = canonicalParams(raw);
  const parse = <S extends TSchema>(schema: S): Static<S> => decode(schema, value, 'reminder_arguments_invalid');
  switch (name) {
    case 'benson_reminder_create': return { operation: 'create-intent', ...parse(PublicSchemas.benson_reminder_create) };
    case 'benson_reminder_create_plan': return { operation: 'create-intent', ...parse(PublicSchemas.benson_reminder_create_plan) };
    case 'benson_reminder_list': return { operation: 'list-reminders', ...parse(PublicSchemas.benson_reminder_list) };
    case 'benson_reminder_find': return { operation: 'find-reminders', ...parse(PublicSchemas.benson_reminder_find) };
    case 'benson_reminder_update': return { operation: 'update-reminder', ...parse(PublicSchemas.benson_reminder_update) };
    case 'benson_reminder_pause': return { operation: 'pause-reminder', ...parse(PublicSchemas.benson_reminder_pause) };
    case 'benson_reminder_resume': return { operation: 'resume-reminder', ...parse(PublicSchemas.benson_reminder_resume) };
    case 'benson_reminder_delete': return { operation: 'delete-reminder', ...parse(PublicSchemas.benson_reminder_delete) };
  }
}

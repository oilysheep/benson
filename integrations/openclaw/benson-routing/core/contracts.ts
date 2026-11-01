import Type, { type Static } from 'typebox';
import { object, nullable, IdentifierSchema as Id, JsonSchema, JsonObjectSchema, ObjectListSchema,
  CandidateSchema, PendingSchema, TimestampSchema, TextSchema, IdListSchema,
  GapsSchema, UserResponseSchema, MAX_RESPONSE_RESULTS, MAX_WARNINGS } from './value.js';

export const CONTROL_CONTRACT_VERSION = 1;
export const RESPONSE_CONTRACT_VERSION = 2;
export const RESPONSE_V3_CONTRACT_VERSION = 3;
export const RESPONSE_V4_CONTRACT_VERSION = 4;
export const SOURCE_ADMISSION_VERSION = 1;
export const NATIVE_READ_ADMISSION_VERSION = 2;
export const NATIVE_DISPATCH_READ_ADMISSION_VERSION = 3;
export const NO_RUN_OUTCOME_VERSION = 1;
export const NATIVE_READ_OUTCOME_VERSION = 2;
export const NATIVE_DISPATCH_READ_OUTCOME_VERSION = 3;
export const DOMAIN_RESULT_SCHEMA_VERSION = 2;
export const DOMAIN_RESULT_V3_SCHEMA_VERSION = 3;
export const TASK_ENVELOPE_KIND = 'benson.self-contained-request';
export const TASK_ENVELOPE_VERSION = 1;
export const DomainSchema = Type.Union([Type.Literal('jessica-vacuum'), Type.Literal('reminder')]);
export type Domain = Static<typeof DomainSchema>;
export const DOMAIN_VERSIONS = Object.freeze({ 'jessica-vacuum': '1', reminder: 'legacy-unversioned' });
export const DOMAIN_AGENTS = Object.freeze({ 'jessica-vacuum': 'jessica-vacuum', reminder: 'reminder-service' });
export const NO_RUN_DISPOSITIONS = Object.freeze([
  'handled', 'no-change', 'suppressed', 'rejected', 'reasoning-required', 'unresolved', 'failed',
] as const);
export const DispositionSchema = Type.Enum(NO_RUN_DISPOSITIONS);
export type Disposition = Static<typeof DispositionSchema>;
export const COMPLETION_STATUSES = Object.freeze([
  'success', 'clarification_required', 'failure', 'partial', 'unknown', 'not_applicable',
] as const);
export const StatusSchema = Type.Enum(COMPLETION_STATUSES);
export const VerifiedSchema = Type.Union([Type.Boolean(), Type.Literal('unknown'), Type.Literal('not_applicable')]);
export const TaskEnvelopeSchema = object({ kind: Type.Literal(TASK_ENVELOPE_KIND),
  version: Type.Literal(1), request: Type.String() });
export type TaskEnvelope = Static<typeof TaskEnvelopeSchema>;
const SourceSchema = object({ type: Type.Enum(['user', 'ha', 'automation']), ref: Id, inputId: Id });
export const ScopeSchema = Type.Enum(['read', 'reconcile', 'notify', 'action']);
export const SourceInputSchema = object({ schemaVersion: Type.Literal(1), kind: Type.Literal('benson.source-input'),
  source: SourceSchema, domain: DomainSchema, scope: ScopeSchema, request: Type.String() });
export const NativeReadInputSchema = object({ schemaVersion: Type.Literal(2), kind: Type.Literal('benson.source-input'),
  domain: Id, scope: Type.Literal('read'), request: Type.String() });
export const NativeDispatchReadInputSchema = object({ ...NativeReadInputSchema.properties, schemaVersion: Type.Literal(3) });
export const NativeDispatchRunInputSchema = object({ ...NativeReadInputSchema.properties, schemaVersion: Type.Literal(4) });
const AuthorityBindingSchema = object({ ref: Id, revision: Id, subject: Id });
export const SourceAdmissionSchema = object({ ...SourceInputSchema.properties,
  kind: Type.Literal('benson.source-admission'), authority: AuthorityBindingSchema, admittedAt: Type.Number() });
export const InvocationSchema = object({ callId: Id, domain: Id, subject: Id });
export const NativeReadAdmissionSchema = object({ ...NativeReadInputSchema.properties,
  kind: Type.Literal('benson.source-admission'), callId: Id,
  authority: object({ kind: Type.Literal('native-invocation'), subject: Id }), admittedAt: Type.Number() });
export const NativeDispatchSchema = object({ requestId: Id, domain: Id, subject: Id });
export const NativeDispatchReadAdmissionSchema = object({ ...NativeDispatchReadInputSchema.properties,
  kind: Type.Literal('benson.source-admission'), requestId: Id,
  authority: object({ kind: Type.Literal('native-dispatch'), subject: Id }), admittedAt: Type.Number() });
/** Separate from Admission/NoRun: authorizes only bounded read-only reasoning. */
export const NativeDispatchRunAdmissionSchema = object({ ...NativeDispatchRunInputSchema.properties,
  kind: Type.Literal('benson.source-admission'), requestId: Id,
  authority: object({ kind: Type.Literal('native-dispatch'), subject: Id }), admittedAt: Type.Number() });
export type SourceInput = Static<typeof SourceInputSchema>;
export type SourceAdmission = Static<typeof SourceAdmissionSchema>;
export type NativeReadAdmission = Static<typeof NativeReadAdmissionSchema>;
export type NativeDispatchReadAdmission = Static<typeof NativeDispatchReadAdmissionSchema>;
export type NativeDispatchRunAdmission = Static<typeof NativeDispatchRunAdmissionSchema>;
export type Admission = SourceAdmission | NativeReadAdmission | NativeDispatchReadAdmission;
export const AdmissionSchema = Type.Union([SourceAdmissionSchema, NativeReadAdmissionSchema, NativeDispatchReadAdmissionSchema]);
export const GrantSchema = object({ inputId: Id, sourceType: SourceSchema.properties.type,
  sourceRef: Id, domain: DomainSchema, subject: Id, authorityRef: Id, authorityRevision: Id,
  scopes: Type.Array(ScopeSchema, { minItems: 1, maxItems: 4, uniqueItems: true }),
  expiresAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER }), status: Type.Literal('active'),
  cancelled: Type.Literal(false), replayState: Type.Literal('fresh'), commitment: Type.Literal('uncommitted') });
export const NativeRequestAdmissionSchema = object({ schemaVersion: Type.Literal(1),
  kind: Type.Enum(['candidate', 'main_only', 'bypass']), reason: nullable(Type.String()),
  requestId: nullable(Id), sessionKey: nullable(Id), request: nullable(Type.String()) });
export const ReconciliationSchema = object({ required: Type.Boolean(), reason: nullable(Id) });
export const HandlingErrorSchema = object({ code: Id, message: TextSchema, retryable: Type.Boolean() });
export const EffectStatusSchema = Type.Enum(['none', 'known', 'possible']);
const NoRunCommon = {
  kind: Type.Literal('benson.no-run'), disposition: DispositionSchema,
  evidence: object({ ref: nullable(Id), observedAt: nullable(TimestampSchema),
    freshness: Type.Enum(['fresh', 'stale', 'unknown']), facts: JsonSchema }),
  effects: object({ status: EffectStatusSchema,
    refs: Type.Array(Id, { maxItems: MAX_RESPONSE_RESULTS, uniqueItems: true }) }),
  reconciliation: ReconciliationSchema,
  notification: nullable(object({ identity: Id, policyRevision: Id, evidenceRef: Id,
    route: object({ recipient: Id, channel: Id, accountId: Id, target: Id }), content: TextSchema })),
  error: nullable(HandlingErrorSchema),
};
export const NoRunV1Schema = object({ schemaVersion: Type.Literal(1), ...NoRunCommon,
  admission: object({ inputId: Id, sourceType: Id, sourceRef: Id, authorityRef: Id,
    authorityRevision: Id, domain: Id, subject: Id }) });
export const NoRunV2Schema = object({ schemaVersion: Type.Literal(2), ...NoRunCommon,
  admission: object({ authorityKind: Type.Literal('native-invocation'), callId: Id, domain: Id, subject: Id }) });
export const NoRunV3Schema = object({ schemaVersion: Type.Literal(3), ...NoRunCommon,
  admission: object({ authorityKind: Type.Literal('native-dispatch'), requestId: Id, domain: Id, subject: Id }) });
export const NoRunSchema = Type.Union([NoRunV1Schema, NoRunV2Schema, NoRunV3Schema]);
export type NoRunOutcome = Static<typeof NoRunSchema>;
export type NativeReadOutcome = Static<typeof NoRunV2Schema>;
export type NativeDispatchReadOutcome = Static<typeof NoRunV3Schema>;
export const ResponseModeSchema = Type.Enum(['pass_through', 'deterministic', 'response_model', 'main_continuation', 'safe_failure']);
export const ResponsePolicySchema = object({ allowedModes: Type.Array(ResponseModeSchema, { minItems: 1,
  maxItems: 5, uniqueItems: true }), preferredMode: ResponseModeSchema });
export const DestinationSchema = Type.Enum(['CALLER', 'RESPONSE_CONTROLLER']);
export const ExecutionRouteSchema = object({ schemaVersion: Type.Literal(1), requestId: Id,
  executionOwner: Id, completionTarget: DestinationSchema, callerRunId: nullable(Id), responsePolicy: ResponsePolicySchema });
const TaskStatusSchema = Type.Enum(['success', 'clarification_required', 'failure']);
export const TaskResultSchema = object({ schemaVersion: Type.Literal(1), domainSchemaVersion: Id,
  taskId: Id, status: TaskStatusSchema, domain: DomainSchema, operation: nullable(Id), verified: Type.Boolean(),
  data: JsonSchema, warnings: ObjectListSchema, error: nullable(JsonObjectSchema),
  pendingContext: nullable(PendingSchema), messageCandidate: nullable(CandidateSchema) });
export type TaskResult = Static<typeof TaskResultSchema>;
export const LegacyResultSchema = object({ status: TaskStatusSchema, domain: DomainSchema,
  operation: nullable(Id), verified: Type.Boolean(), data: JsonSchema, warnings: ObjectListSchema,
  error: nullable(JsonObjectSchema), pendingContext: nullable(JsonObjectSchema) });
export const LegacyJessicaSchema = object({ schemaVersion: Type.Literal('1'), ...LegacyResultSchema.properties });
export const LegacyTrustedSchema = object({ taskId: Id, pendingBinding: nullable(PendingSchema.properties.binding),
  pendingExpiresAt: nullable(TimestampSchema) });
export const CompletionBindingSchema = object({ schemaVersion: Type.Literal(1), requestId: Id,
  parentSessionKey: Id, parentSessionId: Id, parentRunId: nullable(Id), childRunId: Id,
  childSessionKey: Id, executionOwner: Id, completionTarget: DestinationSchema, callerRunId: nullable(Id) });
export type CompletionBinding = Static<typeof CompletionBindingSchema>;
export const CompletionAdmissionSchema = object({ schemaVersion: Type.Literal(1), requestId: Id,
  childRunId: Id, taskId: Id, destination: DestinationSchema, callerRunId: nullable(Id), result: TaskResultSchema });
export const NativeCompletionSchema = object({ binding: CompletionBindingSchema, admission: CompletionAdmissionSchema });
export type NativeCompletion = Static<typeof NativeCompletionSchema>;
export const ParentSessionSchema = object({ sessionKey: Id, sessionId: Id });
export const ResponseSourceSchema = object({ type: Type.Enum(['main', 'direct']), agentId: Id, runId: Id });
export const ResponseLifecycleSchema = object({ domainExecution: Type.Enum(['none', 'attempted', 'uncertain']),
  failure: nullable(object({ code: Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' }) })) });
export type ResponseLifecycle = Static<typeof ResponseLifecycleSchema>;
export const ResponseSchema = object({ schemaVersion: Type.Literal(2), requestId: Id, source: ResponseSourceSchema,
  status: Type.Enum(['success', 'clarification_required', 'failure', 'partial']),
  results: Type.Array(TaskResultSchema, { maxItems: MAX_RESPONSE_RESULTS }),
  pendingContext: nullable(PendingSchema), messageCandidate: nullable(CandidateSchema), responsePolicy: ResponsePolicySchema,
  provenance: object({ executionVerified: Type.Union([Type.Boolean(), Type.Literal('not_applicable')]),
    completionCorrelated: Type.Boolean() }), lifecycle: ResponseLifecycleSchema });
export type Response = Static<typeof ResponseSchema>;
export const RenderedOutputSchema = object({ schemaVersion: Type.Literal(2), message: TextSchema });
export type RenderedOutput = Static<typeof RenderedOutputSchema>;
export const FactsSchema = object({ status: StatusSchema, domain: nullable(DomainSchema),
  domainSchemaVersion: nullable(Id), operation: nullable(Id), verified: VerifiedSchema,
  verificationScope: IdListSchema, data: JsonSchema, warnings: ObjectListSchema,
  error: nullable(JsonObjectSchema), effects: ObjectListSchema, uncertainty: ObjectListSchema,
  pendingContext: nullable(PendingSchema) });
export type Facts = Static<typeof FactsSchema>;
export const FACT_KEYS = Object.freeze(Object.keys(FactsSchema.properties));
export const EffectsSchema = object({ status: EffectStatusSchema, refs: IdListSchema, details: ObjectListSchema,
  reconciliation: ReconciliationSchema });
export type Effects = Static<typeof EffectsSchema>;
export const DomainResultSchema = object({ schemaVersion: Type.Literal(2), kind: Type.Literal('benson.domain-result'),
  executionMode: Type.Enum(['deterministic', 'agentic']), domain: Id, domainSchemaVersion: nullable(Id), operation: nullable(Id),
  outcome: object({ disposition: DispositionSchema, status: StatusSchema }),
  facts: object({ verified: VerifiedSchema, verificationScope: IdListSchema, data: JsonSchema }),
  evidence: object({ observations: Type.Array(object({ ref: nullable(Id), observedAt: nullable(TimestampSchema),
    freshness: Type.Enum(['fresh', 'stale', 'unknown']) }), { maxItems: MAX_WARNINGS }), gaps: GapsSchema }),
  warnings: ObjectListSchema, failures: object({ domain: nullable(JsonObjectSchema), handling: nullable(HandlingErrorSchema) }),
  effects: EffectsSchema, uncertainty: ObjectListSchema, pendingContext: nullable(PendingSchema),
  content: nullable(UserResponseSchema) });
export type DomainResult = Static<typeof DomainResultSchema>;
/** Same semantic fields; byte budgets are validated as separate components. */
export const DomainResultV3Schema = object({ ...DomainResultSchema.properties, schemaVersion: Type.Literal(3) });
export type DomainResultV3 = Static<typeof DomainResultV3Schema>;
export type AnyDomainResult = DomainResult | DomainResultV3;
export const ResponseV3SourceSchema = Type.Union([
  object({ type: Type.Literal('main'), agentId: Type.Literal('main'), runId: Id }),
  object({ type: Type.Literal('direct'), executionMode: Type.Literal('agentic'), agentId: Id, runId: Id }),
  object({ type: Type.Literal('direct'), executionMode: Type.Literal('deterministic'), agentId: Id,
    admission: Type.Union([NoRunV1Schema.properties.admission, NoRunV2Schema.properties.admission, NoRunV3Schema.properties.admission]) }),
]);
export type ResponseV3Source = Static<typeof ResponseV3SourceSchema>;
export const ResponseV3Schema = object({ schemaVersion: Type.Literal(3), requestId: Id, source: ResponseV3SourceSchema,
  results: Type.Array(DomainResultSchema, { maxItems: MAX_RESPONSE_RESULTS }),
  messageCandidate: nullable(CandidateSchema), responsePolicy: ResponsePolicySchema, lifecycle: ResponseLifecycleSchema });
export type ResponseV3 = Static<typeof ResponseV3Schema>;
export const ResponseV4Schema = object({ ...ResponseV3Schema.properties, schemaVersion: Type.Literal(4),
  results: Type.Array(Type.Union([DomainResultSchema, DomainResultV3Schema]), { maxItems: MAX_RESPONSE_RESULTS }) });
export type ResponseV4 = Static<typeof ResponseV4Schema>;

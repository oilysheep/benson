import Type, { type Static, type TSchema } from 'typebox';
import { object, nullable, IdentifierSchema as Id, CodeSchema, RevisionSchema, GenerationSchema,
  GapsSchema, UserResponseSchema, MAX_RESPONSE_RESULTS, MAX_WORKFLOW_ADMISSIONS } from './value.js';
import { FactsSchema, DestinationSchema, DomainSchema } from './contracts.js';
export const COMPLETION_SCHEMA_VERSION = 3;
export const CURRENT_COMPLETION_SCHEMA_VERSION = 4;
export const SUCCESSOR_COMPLETION_SCHEMA_VERSION = 5;
export const BOUNDED_COMPLETION_SCHEMA_VERSION = 6;
export const COMPLETION_KINDS = Object.freeze(['domain-task', 'final-workflow'] as const);
export const EligibilitySchema = object({ eligible: Type.Boolean(), reason: nullable(CodeSchema) });
export const CallerSchema = object({ runId: Id, runGeneration: GenerationSchema, agentId: Id,
  sessionKey: Id, sessionId: Id, sessionGeneration: GenerationSchema });
export const Binding3Schema = object({ requestId: Id, workflowId: Id, runId: Id, agentId: Id,
  sessionKey: Id, sessionId: Id, generation: RevisionSchema, taskId: nullable(Id), callerRunId: nullable(Id),
  completionTarget: DestinationSchema, finality: Type.Boolean(), authorizationId: Id, deliveryPolicy: EligibilitySchema });
export const Binding4Schema = object({ conversationId: Id, conversationGeneration: GenerationSchema,
  admissionId: Id, admissionSequence: RevisionSchema, workflowId: Id, membershipRevision: RevisionSchema,
  acceptedIntentRevision: RevisionSchema, runId: Id, runGeneration: GenerationSchema, agentId: Id,
  sessionKey: Id, sessionId: Id, sessionGeneration: GenerationSchema, taskId: nullable(Id),
  caller: nullable(object({ workflowId: Id, ...CallerSchema.properties })),
  role: Type.Enum(['domain-task', 'direct-final', 'workflow-final']), completionTarget: DestinationSchema,
  finality: Type.Boolean(), authorizationId: Id, deliveryPolicy: EligibilitySchema });
export const Binding5Schema = object({ inputId: Id, admissionId: Id, conversationId: nullable(Id),
  conversationGeneration: nullable(GenerationSchema), ...CallerSchema.properties, domain: nullable(DomainSchema),
  taskId: nullable(Id), caller: nullable(CallerSchema),
  completionTarget: Type.Enum(['CALLER', 'RESPONSE_CONTROLLER', 'NATIVE']), authorizationId: Id,
  parentContinuation: EligibilitySchema, deliveryPolicy: EligibilitySchema });
const BoundedCallerSchema = object({ runId: Id, agentId: Id, sessionKey: Id, sessionId: Id });
export const Binding6Schema = object({ inputId: Id, admissionId: Id, conversationId: nullable(Id),
  ...BoundedCallerSchema.properties, domain: DomainSchema, taskId: Id, caller: nullable(BoundedCallerSchema),
  completionTarget: Binding5Schema.properties.completionTarget, authorizationId: Id,
  parentContinuation: EligibilitySchema, deliveryPolicy: EligibilitySchema });
export type Binding3 = Static<typeof Binding3Schema>;
export type Binding4 = Static<typeof Binding4Schema>;
export type Binding5 = Static<typeof Binding5Schema>;
export type Binding6 = Static<typeof Binding6Schema>;
export type Binding = Binding3 | Binding4 | Binding5 | Binding6;
const OutcomeSchema = object({ outcome: Type.Enum(['NORMAL', 'RECOVERED', 'FAILED']), gaps: GapsSchema });
const record = <V extends number, K extends TSchema, B extends TSchema, R extends TSchema>(
  version: V, kind: K, binding: B, result: R, count: number) => object({ schemaVersion: Type.Literal(version), kind,
  facts: FactsSchema, results: Type.Array(result, { maxItems: count }), userResponse: UserResponseSchema,
  binding, completion: OutcomeSchema });
export const Child3Schema = record(3, Type.Literal('domain-task'), Binding3Schema, Type.Never(), 0);
export const Child4Schema = record(4, Type.Literal('domain-task'), Binding4Schema, Type.Never(), 0);
export const Child5Schema = record(5, Type.Literal('domain-task'), Binding5Schema, Type.Never(), 0);
export const Record3Schema = Type.Union([Child3Schema,
  record(3, Type.Literal('final-workflow'), Binding3Schema, Child3Schema, MAX_RESPONSE_RESULTS)]);
export const Record4Schema = Type.Union([Child4Schema,
  record(4, Type.Literal('final-workflow'), Binding4Schema, Child4Schema, MAX_RESPONSE_RESULTS)]);
export const Record5Schema = Type.Union([Child5Schema,
  record(5, Type.Literal('agent-run'), Binding5Schema, Child5Schema, MAX_RESPONSE_RESULTS)]);
export const Record6Schema = record(6, Type.Literal('domain-task'), Binding6Schema, Type.Never(), 0);
export const CompletionSchema = Type.Union([Record3Schema, Record4Schema, Record5Schema, Record6Schema]);
export type Completion3 = Static<typeof Record3Schema>;
export type Completion4 = Static<typeof Record4Schema>;
export type Completion5 = Static<typeof Record5Schema>;
export type Completion6 = Static<typeof Record6Schema>;
export type Completion = Static<typeof CompletionSchema>;
export type CompletionKind = Completion['kind'];
export type CompletionVersion = Completion['schemaVersion'];
export type CompletionOutcome = Completion['completion']['outcome'];
export const WorkflowSchema = object({ workflowId: Id, conversationId: Id,
  conversationGeneration: GenerationSchema, membershipRevision: RevisionSchema, acceptedIntentRevision: RevisionSchema,
  membershipState: Type.Enum(['open', 'closed']), admissions: Type.Array(object({ admissionId: Id,
    sequence: RevisionSchema }), { minItems: 1, maxItems: MAX_WORKFLOW_ADMISSIONS }) });
export const SemanticsSchema = nullable(object({ ownerRunId: Id, ownerRunGeneration: GenerationSchema,
  acceptedIntentRevision: RevisionSchema, coverage: Type.Enum(['complete', 'incomplete']), value: Type.Unknown() }));

import Type, { type Static } from 'typebox';
import { object, nullable, decode } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { deny } from './errors.js';
import { Nonempty, Positive, SafeInteger, SuctionSchema, ModeSchema, SettingsSchema, CapabilitySchema,
  EXECUTE_OPERATIONS, READ_OPERATIONS } from './schemas.js';
import { validCapability } from './registry.js';

export const OutcomeSchema = Type.Enum(['not_sent', 'accepted', 'preparing', 'started', 'paused', 'stopped', 'returning', 'docked', 'completed', 'unknown']);
export const DispatchSchema = Type.Enum(['not_attempted', 'accepted', 'rejected', 'unknown']);
export const ObservationSchema = object({ observedAt: Nonempty, sourceUpdatedAt: nullable(Nonempty), state: Nonempty,
  activeSegments: nullable(Type.Array(Positive)), currentSegment: nullable(Positive),
  taskStatus: Type.Optional(object({ state: Nonempty, sourceUpdatedAt: Nonempty })),
  chargingStatus: Type.Optional(object({ value: Type.Enum(['charging', 'charging_completed']), sourceUpdatedAt: Nonempty })),
  homeTask: Type.Optional(object({ value: Type.Literal(1), sourceReadAt: Nonempty,
    geometrySha256: Type.String({ pattern: '^[a-f0-9]{64}$' }), mapListReadAt: Nonempty })) });
export type Observation = Static<typeof ObservationSchema>;
export const AppliedSettingsSchema = object({ ...SettingsSchema.properties, wetness: Type.Optional(SafeInteger) });
export const ActionDataSchema = object({ operationId: Nonempty, rooms: Type.Array(Nonempty, { uniqueItems: true }),
  outcome: OutcomeSchema, dispatch: DispatchSchema, observation: nullable(ObservationSchema), appliedSettings: AppliedSettingsSchema,
  completionEvidence: Type.Optional(object({ operationId: Nonempty, observedAt: Nonempty, source: Nonempty })) });
export type ActionData = Static<typeof ActionDataSchema>;
const ReadItemBase = { name: Nonempty, value: nullable(Type.Union([Type.String(), Type.Number()])), unit: nullable(Nonempty) };
export const ReadItemSchema = Type.Union([object(ReadItemBase), object({ ...ReadItemBase,
  availability: Type.Enum(['available', 'unavailable']), sourceKind: Type.Literal('ha_cached_entity'), sourceUpdatedAt: nullable(Nonempty) })]);
export type ReadItem = Static<typeof ReadItemSchema>;
const EvidenceBase = { observedAt: Nonempty, sourceUpdatedAt: nullable(Nonempty), freshness: Type.Enum(['fresh', 'stale']) };
const StatusBase = { kind: Type.Literal('status'), ...EvidenceBase, state: Nonempty,
  batteryLevel: nullable(Type.Integer({ minimum: 0, maximum: 100 })), activeSegments: nullable(Type.Array(Positive)), currentSegment: nullable(Positive) };
const CapabilitiesBase = { kind: Type.Literal('capabilities'), ...EvidenceBase, capabilities: Type.Array(CapabilitySchema) };
export const ReadDataSchema = Type.Union([
  object(StatusBase), object({ ...StatusBase, sourceKind: Type.Literal('ha_cached_entity'),
    locationMeaning: Type.Enum(['map_localization', 'reported_current_segment']), health: Type.Array(ReadItemSchema) }),
  object({ kind: Type.Literal('rooms'), ...EvidenceBase, mapFingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    rooms: Type.Array(object({ slug: Nonempty, label: Nonempty, segmentId: SafeInteger, enabled: Type.Boolean() })) }),
  object(CapabilitiesBase), object({ ...CapabilitiesBase, inventoryScope: Type.Literal('accepted_registry_only'), liveAvailability: Type.Literal('not_checked') }),
  object({ kind: Type.Literal('maintenance'), ...EvidenceBase, items: Type.Array(ReadItemSchema) }),
  object({ kind: Type.Literal('statistics'), ...EvidenceBase, metrics: Type.Array(ReadItemSchema) }),
  object({ kind: Type.Literal('room_settings'), ...EvidenceBase, room: Nonempty,
    suction: nullable(SuctionSchema), mode: nullable(ModeSchema), wetness: nullable(SafeInteger) }),
  object({ kind: Type.Literal('operation_status'), ...EvidenceBase, operationId: Nonempty,
    outcome: OutcomeSchema, dispatch: DispatchSchema, observation: nullable(ObservationSchema) }),
]);
export type ReadData = Static<typeof ReadDataSchema>;
const ClarificationSchema = object({ question: Nonempty, candidates: Type.Array(object({ room: Nonempty, label: Nonempty })) });
export const ErrorSchema = object({ code: Nonempty,
  stage: Type.Enum(['input', 'identity', 'authorization', 'resolution', 'precondition', 'dispatch', 'verification', 'integrity']),
  retryable: Type.Boolean(), retryMode: Type.Enum(['none', 'read_only', 'reconcile']), sideEffects: Type.Enum(['none', 'possible', 'observed']), message: Nonempty });
export const ResultSchema = object({ schemaVersion: Type.Literal('1'), status: Type.Enum(['success', 'clarification_required', 'failure']),
  domain: Type.Literal('jessica-vacuum'), operation: nullable(Type.Enum([...READ_OPERATIONS, ...EXECUTE_OPERATIONS])), verified: Type.Boolean(),
  data: nullable(Type.Union([ReadDataSchema, ActionDataSchema, ClarificationSchema])),
  warnings: Type.Array(object({ code: Nonempty, message: Nonempty })), error: nullable(ErrorSchema),
  pendingContext: nullable(object({ version: Type.Literal('1'), clarificationId: Nonempty, expiresAt: Nonempty })) });
export type Result = Static<typeof ResultSchema>;
const PlanEvidenceSchema = Type.Object({ operation: Type.Enum(EXECUTE_OPERATIONS),
  rooms: Type.Array(Type.Object({ slug: Nonempty, segmentId: Type.Optional(Positive) })), settings: nullable(SettingsSchema),
  roomTaskSignal: Type.Optional(Type.Boolean()), targetKind: Type.Optional(nullable(Type.Enum(['rooms', 'home']))),
  underTestId: Type.Optional(nullable(Nonempty)), homeGeometrySha256: Type.Optional(Nonempty) });
const instant = (value: string) => Number.isFinite(Date.parse(value));
const validBefore = (value: string, now: string) => instant(value) && Date.parse(value) <= Date.parse(now);
function assertObservation(value: Observation): void {
  if (!instant(value.observedAt) || (value.sourceUpdatedAt !== null && !instant(value.sourceUpdatedAt)) ||
      (value.taskStatus && !validBefore(value.taskStatus.sourceUpdatedAt, value.observedAt)) ||
      (value.chargingStatus && !validBefore(value.chargingStatus.sourceUpdatedAt, value.observedAt)) ||
      (value.homeTask && (!validBefore(value.homeTask.sourceReadAt, value.observedAt) || !validBefore(value.homeTask.mapListReadAt, value.observedAt)))) {
    deny('INVALID_RESULT', 'integrity', 'Observation timestamps are invalid');
  }
}
function assertReadItems(items: readonly ReadItem[], observedAt: string): boolean {
  return items.every(item => !('availability' in item) ||
    (item.sourceUpdatedAt === null || validBefore(item.sourceUpdatedAt, observedAt)) &&
    (item.availability === 'available') === (item.value !== null));
}
function assertRead(data: ReadData): void {
  if (!instant(data.observedAt) || (data.sourceUpdatedAt !== null && !validBefore(data.sourceUpdatedAt, data.observedAt))) deny('INVALID_RESULT', 'integrity', 'Read evidence is invalid');
  const collection = data.kind === 'maintenance' ? data.items : data.kind === 'statistics' ? data.metrics :
    data.kind === 'status' && 'health' in data ? data.health : [];
  if (!assertReadItems(collection, data.observedAt) || (data.kind === 'capabilities' && !data.capabilities.every(validCapability))) deny('INVALID_RESULT', 'integrity', 'Read collection is invalid');
  if (data.kind === 'operation_status' && data.observation) assertObservation(data.observation);
}
function assertActionSuccess(result: Result, data: ActionData, expected: unknown, now: Date): void {
  let plan;
  try { plan = decode(PlanEvidenceSchema, expected, 'expected_plan_invalid'); }
  catch { return deny('FALSE_SUCCESS', 'integrity', 'Action result is not bound to its validated plan'); }
  const reject = (message: string): never => deny('FALSE_SUCCESS', 'integrity', message);
  if (plan.operation !== result.operation || data.rooms.length !== plan.rooms.length ||
      data.rooms.some((slug, index) => slug !== plan.rooms[index]?.slug)) reject('Action result is not bound to its validated plan');
  const o = data.observation;
  if (!result.verified || data.dispatch !== 'accepted' || !o || o.sourceUpdatedAt === null ||
      ['accepted', 'preparing', 'not_sent', 'unknown'].includes(data.outcome)) reject('Physical action has no verified outcome');
  if (!o || o.sourceUpdatedAt === null) return reject('Physical observation is unavailable');
  const age = now.getTime() - Date.parse(o.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 60_000 || !validBefore(o.sourceUpdatedAt, o.observedAt)) reject('Physical observation is stale or inconsistent');
  if (plan.settings && Object.entries(plan.settings).some(([key, value]) =>
    (key === 'suction' ? data.appliedSettings.suction : key === 'mode' ? data.appliedSettings.mode : data.appliedSettings.wetness) !== value)) reject('Requested setting lacks verified application');
  const allowed: Record<string, Record<string, readonly string[]>> = {
    clean: { started: ['cleaning'], completed: ['docked', 'idle'] }, pause: { paused: ['paused'] },
    resume: { started: ['cleaning'] }, stop: { stopped: ['stopped', 'idle'] }, dock: { returning: ['returning'], docked: ['docked'] },
  };
  if (!allowed[plan.operation]?.[data.outcome]?.includes(o.state)) reject('Observed state does not prove the claimed outcome');
  if (plan.operation === 'pause' && (data.outcome !== 'paused' || o.taskStatus?.state !== 'room_cleaning_paused')) reject('Pause requires a room-task pause signal');
  if (plan.operation === 'dock' && (data.outcome !== 'docked' || !o.chargingStatus)) reject('Dock requires a charging transition');
  if (data.outcome === 'completed' && data.completionEvidence === undefined) reject('Completion requires separate task evidence');
  if (plan.operation === 'clean' && data.outcome === 'started' && data.rooms.length &&
      (!o.activeSegments || [...o.activeSegments].sort((a, b) => a - b).join(',') !==
        plan.rooms.map(room => room.segmentId).sort((a, b) => (a ?? 0) - (b ?? 0)).join(','))) reject('Active segments do not match the validated target');
  if (plan.operation === 'clean' && plan.roomTaskSignal && data.outcome === 'started' && o.taskStatus?.state !== 'room_cleaning') reject('Room start lacks room-cleaning task evidence');
  if (plan.operation === 'clean' && plan.targetKind === 'home') {
    const home = o.homeTask;
    if (data.outcome !== 'started' || data.rooms.length || !plan.underTestId || !/^[a-f0-9]{64}$/u.test(plan.homeGeometrySha256 ?? '') ||
        !home || home.geometrySha256 !== plan.homeGeometrySha256 || [home.sourceReadAt, home.mapListReadAt].some(time =>
          now.getTime() - Date.parse(time) < 0 || now.getTime() - Date.parse(time) > 90_000) || (o.activeSegments !== null && o.activeSegments.length)) reject('Home start lacks device-confirmed task and reviewed map evidence');
  }
}
export function validateResult(raw: unknown, expectedPlan: unknown = null, now = new Date()): Result {
  let result: Result;
  try { result = decode(ResultSchema, raw, 'result_invalid'); }
  catch { return deny('INVALID_RESULT', 'integrity', 'Result has an invalid shape or value'); }
  if (result.status === 'clarification_required') {
    const data = decode(ClarificationSchema, result.data, 'clarification_invalid');
    if (result.verified || result.error !== null || !data.question || !result.pendingContext ||
        !instant(result.pendingContext.expiresAt) || Date.parse(result.pendingContext.expiresAt) <= now.getTime()) deny('INVALID_RESULT', 'integrity', 'Clarification contract is invalid');
  } else {
    if (result.pendingContext !== null || (result.status === 'failure') !== (result.error !== null)) deny('INVALID_RESULT', 'integrity', 'Result status and error disagree');
    if (result.operation === null || result.data === null) {
      if (result.status !== 'failure' || result.data !== null || result.verified) deny('INVALID_RESULT', 'integrity', 'Result facts are missing');
    } else if ('kind' in result.data) {
      const data = decode(ReadDataSchema, result.data, 'read_data_invalid');
      if (data.kind !== result.operation) deny('INVALID_RESULT', 'integrity', 'Read kind and operation disagree'); assertRead(data);
      const age = now.getTime() - Date.parse(data.observedAt);
      if (result.status === 'success' && (data.freshness !== 'fresh' || !result.verified || !Number.isFinite(age) || age < 0 || age > 60_000)) deny('FALSE_SUCCESS', 'integrity', 'Read success requires fresh evidence');
    } else {
      const data = decode(ActionDataSchema, result.data, 'action_data_invalid');
      if (!EXECUTE_OPERATIONS.some(operation => operation === result.operation)) deny('INVALID_RESULT', 'integrity', 'Action operation is invalid');
      if (data.observation) assertObservation(data.observation);
      if (data.completionEvidence && (data.completionEvidence.operationId !== data.operationId || !instant(data.completionEvidence.observedAt))) deny('INVALID_RESULT', 'integrity', 'Completion evidence does not match operation');
      if (result.status === 'success') assertActionSuccess(result, data, expectedPlan, now);
    }
  }
  return structuredClone(result);
}

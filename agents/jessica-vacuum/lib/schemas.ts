import Type, { type Static, type TSchema } from 'typebox';
import { Compile } from 'typebox/compile';
import { object, nullable, decode, plain, freeze } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { deny } from './errors.js';

export const RESULT_VERSION = '1';
export const READ_OPERATIONS = ['status', 'rooms', 'capabilities', 'maintenance', 'statistics', 'room_settings', 'operation_status'] as const;
export const EXECUTE_OPERATIONS = ['clean', 'pause', 'resume', 'stop', 'dock'] as const;
export const Nonempty = Type.String({ minLength: 1 });
export const SafeInteger = Type.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
export const Positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const SuctionSchema = Type.Enum(['quiet', 'standard', 'strong', 'turbo']);
export const ModeSchema = Type.Enum(['sweeping', 'mopping', 'sweeping_and_mopping', 'mopping_after_sweeping']);
export const SettingsSchema = object({ suction: Type.Optional(SuctionSchema), mode: Type.Optional(ModeSchema),
  wetness: Type.Optional(Type.Integer({ minimum: 1, maximum: 32, multipleOf: 1 })) });
export type Settings = Static<typeof SettingsSchema>;
const RoomReference = Type.String({ minLength: 1, maxLength: 80 });
export const READ_REQUEST_SCHEMA = Type.Union([
  object({ operation: Type.Enum(['status', 'rooms', 'capabilities', 'maintenance', 'statistics']) }),
  object({ operation: Type.Literal('room_settings'), room: RoomReference }),
  object({ operation: Type.Literal('operation_status'), operationId: Type.String({ minLength: 1, maxLength: 128 }) }),
]);
export const EXECUTE_REQUEST_SCHEMA = Type.Union([
  object({ operation: Type.Literal('clean'), target: Type.Union([
    object({ kind: Type.Literal('home') }), object({ kind: Type.Literal('rooms'),
      rooms: Type.Array(RoomReference, { minItems: 1, uniqueItems: true }) }),
  ]), settings: Type.Optional(SettingsSchema) }),
  object({ operation: Type.Enum(['pause', 'resume', 'stop', 'dock']) }),
]);
export type ReadRequest = Static<typeof READ_REQUEST_SCHEMA>;
export type ExecuteRequest = Static<typeof EXECUTE_REQUEST_SCHEMA>;
/** Schema code-point checks are supplemented by the retained UTF-16 bounds. */
function parse<S extends TSchema>(schema: S, value: unknown): Static<S> {
  let parsed: Static<S>;
  try { parsed = decode(schema, value, 'invalid_request'); }
  catch { return deny('INVALID_REQUEST', 'input', 'Request has an invalid shape or value'); }
  if (plain(value)) {
    if ((typeof value.room === 'string' && value.room.length > 80) ||
        (typeof value.operationId === 'string' && value.operationId.length > 128) ||
        (plain(value.target) && Array.isArray(value.target.rooms) &&
          value.target.rooms.some((room: unknown) => typeof room === 'string' && room.length > 80))) {
      deny('INVALID_REQUEST', 'input', 'Request text exceeds its UTF-16 bound');
    }
  }
  return structuredClone(parsed);
}
export const parseReadRequest = (value: unknown): ReadRequest => parse(READ_REQUEST_SCHEMA, value);
export const parseExecuteRequest = (value: unknown): ExecuteRequest => parse(EXECUTE_REQUEST_SCHEMA, value);
export const NONEMPTY_STRING_SCHEMA = Nonempty;
export function schemaErrors(schema: TSchema, value: unknown): string[] {
  return [...Compile(schema).Errors(value)].map(error => `${error.instancePath}: ${error.message}`);
}
export const PolicySchema = object({ version: Type.Literal('1'), defaultDecision: Type.Literal('deny'),
  rules: Type.Array(object({ subject: Nonempty, actionClass: Type.Enum(['read', 'control']),
    deviceScope: Type.Literal('jessica-vacuum'), decision: Type.Enum(['allow', 'deny']) })) });
export const IdentitySchema = Type.Object({ source: Type.Literal('trusted_runtime'), senderId: Nonempty,
  channelKind: Type.Enum(['direct', 'group']), perSenderVerified: Type.Optional(Type.Boolean()) });
export type TrustedIdentity = Static<typeof IdentitySchema>;
export type Policy = Static<typeof PolicySchema>;
export const ReviewedRoomSchema = object({ room: Nonempty, observedAt: Nonempty, provenance: Nonempty });
export const ReviewedSetSchema = object({ rooms: Type.Array(Nonempty, { minItems: 2, uniqueItems: true }),
  observedAt: Nonempty, provenance: Nonempty });
export const ReviewedSettingSchema = object({ ...ReviewedRoomSchema.properties,
  settings: object({ suction: SuctionSchema }) });
export const CapabilitySchema = object({ name: Nonempty, support: Type.Enum(['disabled', 'reported', 'verified']),
  observedAt: nullable(Nonempty), provenance: Nonempty,
  verifiedRooms: Type.Optional(Type.Array(ReviewedRoomSchema, { minItems: 1 })),
  verifiedRoomSets: Type.Optional(Type.Array(ReviewedSetSchema, { minItems: 1 })),
  verifiedSettings: Type.Optional(Type.Array(ReviewedSettingSchema, { minItems: 1, maxItems: 1 })) });
export type Capability = Static<typeof CapabilitySchema>;
const BindingFields = { generation: Nonempty, observedAt: Nonempty, source: Nonempty, reviewProvenance: Nonempty };
export const RoomSchema = object({ slug: Type.String({ pattern: '^[a-z][a-z0-9_]*$' }), segmentId: Positive,
  label: Nonempty, aliases: Type.Array(Type.String()), enabled: Type.Boolean(), disabledReason: nullable(Nonempty),
  binding: nullable(object(BindingFields)) });
export type Room = Static<typeof RoomSchema>;
const CanaryCommon = { id: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }), expiresAt: Nonempty };
const Subject = Type.String({ pattern: '^[a-z][a-z0-9:_-]{0,79}$' });
const CanarySchema = Type.Union([
  object({ ...CanaryCommon, capability: Type.Enum(['clean_single_room', 'pause', 'dock']), maxDispatches: Type.Literal(1), room: Nonempty, subject: Subject }),
  object({ ...CanaryCommon, capability: Type.Enum(['clean_multi_room', 'pause']), maxDispatches: Type.Literal(1),
    rooms: Type.Array(Nonempty, { minItems: 2, maxItems: 2, uniqueItems: true }), subject: Subject }),
  object({ ...CanaryCommon, capability: Type.Literal('clean_home'), maxDispatches: Type.Literal(1),
    subject: Type.Literal('oren'), reviewedGeometrySha256: Type.String({ pattern: '^[a-f0-9]{64}$' }) }),
  object({ ...CanaryCommon, capability: Type.Literal('clean_settings'), maxDispatches: Type.Literal(2),
    room: Nonempty, settings: object({ suction: SuctionSchema }) }),
]);
export const RegistrySchema = object({ version: Type.Literal('1'), mapFingerprint: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  mapBinding: object({ ...BindingFields, deviceEntity: Type.Literal('vacuum.jesica_jesica'), mapId: Positive, mapName: Nonempty }),
  rooms: Type.Array(RoomSchema), capabilities: Type.Array(CapabilitySchema),
  workflows: Type.Array(object({ id: Nonempty, kind: Type.Literal('shortcut'), room: Nonempty,
    shortcutId: Positive, expectedPasses: Positive, enabled: Type.Boolean() })), underTest: Type.Optional(CanarySchema) });
export const ShortcutTaskSchema = object({ order: SafeInteger, segment_id: SafeInteger, suction_level: SafeInteger,
  water_volume: SafeInteger, cleaning_times: SafeInteger, cleaning_mode: SafeInteger, wetness_level: SafeInteger,
  mopping_settings: SafeInteger, cleaning_route: SafeInteger, task_type: SafeInteger });
export const MapSchema = Type.Object({ mapId: Positive, mapName: Nonempty,
  rooms: Type.Array(Type.Object({ id: Positive, name: Nonempty }), { minItems: 1 }),
  shortcuts: Type.Array(Type.Object({ id: Positive, mapId: Positive,
    tasks: Type.Array(Type.Array(ShortcutTaskSchema, { minItems: 1 }), { minItems: 1 }) })),
  observedAt: Type.Optional(Nonempty) });
export type MapEvidence = Static<typeof MapSchema>;
export const PlanSchema = object({ operation: Type.Enum(EXECUTE_OPERATIONS), targetKind: nullable(Type.Enum(['home', 'rooms'])),
  rooms: Type.Array(object({ slug: Nonempty, segmentId: Positive })), workflowId: Type.Null(), settings: nullable(SettingsSchema),
  mapFingerprint: nullable(Nonempty), mapGeneration: nullable(Nonempty), registryVersion: Type.Literal('1'),
  policyVersion: Type.Literal('1'), requesterSubject: Nonempty, underTestId: nullable(Nonempty), roomTaskSignal: Type.Boolean(),
  homeGeometrySha256: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })) });
export type ExecutePlan = Static<typeof PlanSchema>;
freeze(READ_REQUEST_SCHEMA); freeze(EXECUTE_REQUEST_SCHEMA);

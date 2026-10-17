import Type, { type Static } from 'typebox';
import { object, nullable } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { MapSchema, Nonempty, SettingsSchema, SafeInteger, Positive, EXECUTE_OPERATIONS } from './schemas.js';
import { ObservationSchema } from './results.js';
import type { InvocationAuthority } from '../../../integrations/openclaw/benson-routing/core/invocation.js';
export type { InvocationAuthority } from '../../../integrations/openclaw/benson-routing/core/invocation.js';

/** Host custody stays outside the domain. A comparison token is never authority. */
export interface StateObservation<T> { readonly value: T | undefined; readonly token: object }
export type StateWrite = 'applied' | 'unchanged' | 'conflict';
/** The native adapter must fence every write using the live invocation authority. */
export interface AtomicKeyedState<Records extends object> {
  observe<Key extends keyof Records & string>(key: Key): Promise<StateObservation<unknown>>;
  lookup<Key extends keyof Records & string>(key: Key): Promise<unknown>;
  compareAndSet<Key extends keyof Records & string>(key: Key, observed: StateObservation<unknown>, value: Records[Key]): Promise<StateWrite>;
  registerIfAbsent<Key extends keyof Records & string>(key: Key, value: Records[Key]): Promise<boolean>;
}
export const SignalTimeSchema = object({ observedAt: Nonempty, sourceUpdatedAt: Nonempty });
export const TaskSignalSchema = object({ ...SignalTimeSchema.properties, state: Nonempty });
export const NumericSignalSchema = object({ ...SignalTimeSchema.properties, value: Type.Number() });
export const ChargingSignalSchema = object({ ...SignalTimeSchema.properties, value: Nonempty });
export const SettingSourcesSchema = object({ suction: Type.Optional(SignalTimeSchema),
  mode: Type.Optional(SignalTimeSchema), wetness: Type.Optional(SignalTimeSchema) });
export const HomeGeometrySchema = object({ sha256: Nonempty, mapId: Positive,
  deviceMapListReadAt: Nonempty, savedMapLoadedAt: Nonempty, visibleSegmentIds: Type.Array(Positive),
  hiddenSegmentIds: Type.Array(Positive), noGoCount: SafeInteger, noMopCount: SafeInteger, virtualWallCount: SafeInteger });
export const TaskDeviceSchema = object({ value: SafeInteger, sourceReadAt: Nonempty });
// These are private domain observations, never raw host sessions or transport responses.
export const DeviceSnapshotSchema = Type.Object({ map: Type.Optional(MapSchema), status: ObservationSchema,
  taskId: Type.Optional(nullable(Nonempty)), taskScope: Type.Optional(nullable(Nonempty)),
  taskStatus: Type.Optional(nullable(TaskSignalSchema)), currentArea: Type.Optional(nullable(NumericSignalSchema)),
  currentTime: Type.Optional(nullable(NumericSignalSchema)), chargingStatus: Type.Optional(nullable(ChargingSignalSchema)),
  settings: Type.Optional(SettingsSchema), settingSources: Type.Optional(nullable(SettingSourcesSchema)),
  deviceSuction: Type.Optional(nullable(Nonempty)), error: Type.Optional(nullable(Type.String())),
  options: Type.Optional(Type.Object({ observedAt: Nonempty, suction: Type.Optional(Type.Array(Nonempty)), mode: Type.Optional(Type.Array(Nonempty)),
    wetness: Type.Optional(Type.Object({ min: SafeInteger, max: SafeInteger, step: SafeInteger })) })),
  taskDevice: Type.Optional(nullable(TaskDeviceSchema)), homeGeometry: Type.Optional(nullable(HomeGeometrySchema)) });
export type DeviceSnapshot = Static<typeof DeviceSnapshotSchema>;
export const DeviceStepSchema = Type.Union([
  object({ kind: Type.Literal('setting'), name: Type.Literal('suction'), value: Type.Enum(['quiet', 'standard', 'strong', 'turbo']) }),
  object({ kind: Type.Literal('setting'), name: Type.Literal('mode'), value: Type.Enum(['sweeping', 'mopping', 'sweeping_and_mopping', 'mopping_after_sweeping']) }),
  object({ kind: Type.Literal('setting'), name: Type.Literal('wetness'), value: SafeInteger }),
  object({ kind: Type.Literal('command'), operation: Type.Enum(EXECUTE_OPERATIONS),
    targetKind: nullable(Type.Enum(['home', 'rooms'])), segments: Type.Array(Positive), workflowId: Type.Null() }),
]);
export type DeviceStep = Static<typeof DeviceStepSchema>;
export interface MutationGuard extends InvocationAuthority { assertMutationCurrent(): Promise<void> }
export interface JessicaDevice {
  read(authority: InvocationAuthority): Promise<DeviceSnapshot>;
  dispatch(step: DeviceStep, guard: MutationGuard): Promise<{ readonly accepted: boolean }>;
}

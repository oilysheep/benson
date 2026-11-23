import Type, { type Static } from 'typebox';
import { decode, object, plain, fail, freeze, timestamp } from '../../../integrations/openclaw/benson-routing/core/value.js';
import type { Registry } from './registry.js';
import { MapSchema, Positive, SafeInteger, Nonempty, ShortcutTaskSchema, type MapEvidence } from './schemas.js';
import { deny } from './errors.js';
import type { ReadData, ReadItem } from './results.js';

export const VACUUM_ENTITY = 'vacuum.jesica_jesica';
// Source-only FC7 policy: freshness of the HA observation, not a claim that
// hardware was independently sampled. No numeric fault semantics are inferred.
export const WARNING_EVENT_MAX_AGE_MS = 30_000;
const WarningEventRequestSchema = object({ schemaVersion: Type.Literal(1), kind: Type.Literal('jessica.warning-event'),
  deviceEntity: Type.String(), state: Type.String(), hasError: Type.Boolean(),
  timeFired: Type.String(), lastUpdated: Type.String() });
/** Reduce only an authenticated native event selected by ingress. Authority and
 * original-frame identity remain outside this domain-owned payload. */
export function prepareJessicaWarningEvent(raw: unknown): string {
  if (!plain(raw) || raw.type !== 'event' || !plain(raw.event) ||
      raw.event.event_type !== 'state_changed' || !plain(raw.event.data)) fail('jessica_warning_event_invalid');
  const event = raw.event, data = raw.event.data, state = data.new_state;
  if (!plain(state) || state.entity_id !== data.entity_id || !plain(state.attributes)) fail('jessica_warning_device_or_signal_invalid');
  return JSON.stringify({ schemaVersion: 1, kind: 'jessica.warning-event', deviceEntity: data.entity_id,
    state: state.state, hasError: state.attributes.has_error, timeFired: event.time_fired, lastUpdated: state.last_updated });
}
/** Only projection v1 is admitted: legacy raw events and unknown versions fail
 * closed. Freshness and device semantics remain this domain's responsibility. */
export function projectJessicaWarningEvent(raw: unknown, registry: Registry, now: number) {
  const input = decode(WarningEventRequestSchema, raw, 'jessica_warning_projection_invalid');
  if (!Number.isSafeInteger(now) || registry.mapBinding.deviceEntity !== VACUUM_ENTITY ||
      input.deviceEntity !== registry.mapBinding.deviceEntity ||
      ['unknown', 'unavailable'].includes(input.state)) fail('jessica_warning_device_or_signal_invalid');
  if (!timestamp(input.timeFired) || !timestamp(input.lastUpdated)) fail('jessica_warning_timestamp_invalid');
  const fired = Date.parse(input.timeFired), updated = Date.parse(input.lastUpdated);
  if (updated > fired || fired > now || now - updated > WARNING_EVENT_MAX_AGE_MS) fail('jessica_warning_evidence_not_fresh');
  return freeze({ kind: 'device-warning' as const, deviceEntity: VACUUM_ENTITY,
    condition: 'device-reports-error' as const, active: input.hasError,
    severity: input.hasError ? 'warning' as const : null,
    observedAt: input.lastUpdated, sourceKind: 'ha_event' as const, taskCorrelation: 'unknown' as const });
}
export const HaEntitySchema = Type.Object({ entity_id: Nonempty, state: Type.String(),
  attributes: Type.Record(Type.String(), Type.Unknown()), last_updated: Type.Optional(Nonempty) });
export type HaEntity = Static<typeof HaEntitySchema>;
export const SENSOR_FIELDS = Object.freeze({ chargingStatus: 'sensor.jesica_charging_status', error: 'sensor.jesica_error',
  lowWaterWarning: 'sensor.jesica_low_water_warning', taskStatus: 'sensor.jesica_task_status', dustBag: 'sensor.jesica_dust_bag_status',
  cleanWaterTank: 'sensor.jesica_clean_water_tank_status', dirtyWaterTank: 'sensor.jesica_dirty_water_tank_status', detergent: 'sensor.jesica_detergent_status',
  mainBrushPercent: 'sensor.jesica_main_brush_left', mainBrushHours: 'sensor.jesica_main_brush_time_left',
  sideBrushPercent: 'sensor.jesica_side_brush_left', sideBrushHours: 'sensor.jesica_side_brush_time_left',
  filterPercent: 'sensor.jesica_filter_left', filterHours: 'sensor.jesica_filter_time_left',
  sensorCarePercent: 'sensor.jesica_sensor_dirty_left', sensorCareHours: 'sensor.jesica_sensor_dirty_time_left',
  totalCleaningMinutes: 'sensor.jesica_total_cleaning_time', cleaningCount: 'sensor.jesica_cleaning_count', totalCleanedArea: 'sensor.jesica_total_cleaned_area',
  currentCleaningMinutes: 'sensor.jesica_cleaning_time', currentCleanedArea: 'sensor.jesica_cleaned_area' });
type Sensor = keyof typeof SENSOR_FIELDS;
type SensorSpec = readonly [Sensor, string | null, 'number' | 'text'];
const MAINTENANCE: readonly SensorSpec[] = [['mainBrushPercent', '%', 'number'], ['mainBrushHours', 'h', 'number'],
  ['sideBrushPercent', '%', 'number'], ['sideBrushHours', 'h', 'number'], ['filterPercent', '%', 'number'], ['filterHours', 'h', 'number'],
  ['sensorCarePercent', '%', 'number'], ['sensorCareHours', 'h', 'number'], ['dustBag', null, 'text'], ['cleanWaterTank', null, 'text'], ['dirtyWaterTank', null, 'text'], ['detergent', null, 'text']];
const STATISTICS: readonly SensorSpec[] = [['totalCleaningMinutes', 'min', 'number'], ['cleaningCount', 'count', 'number'],
  ['totalCleanedArea', 'm²', 'number'], ['currentCleaningMinutes', 'min', 'number'], ['currentCleanedArea', 'm²', 'number']];
export function selectSensors(raw: unknown): ReadonlyMap<string, HaEntity> {
  if (!Array.isArray(raw)) return deny('READ_INVALID', 'verification', 'Home Assistant sensor inventory is invalid');
  const allowed = new Set<string>(Object.values(SENSOR_FIELDS)), selected = new Map<string, HaEntity>();
  for (const value of raw) {
    if (!plain(value) || typeof value.entity_id !== 'string' || !allowed.has(value.entity_id)) continue;
    if (selected.has(value.entity_id)) deny('READ_INVALID', 'verification', 'Duplicate Jessica sensor identity');
    selected.set(value.entity_id, decode(HaEntitySchema, value, 'ha_sensor_invalid'));
  }
  return selected;
}
function sensorEvidence(states: ReadonlyMap<string, HaEntity>, name: Sensor, type: 'number' | 'text', unit: string | null, observedAt: string): ReadItem {
  const entity = states.get(SENSOR_FIELDS[name]), raw = entity?.state, updated = entity?.last_updated ?? null;
  if (entity && (!updated || !Number.isFinite(Date.parse(updated)) || Date.parse(updated) > Date.parse(observedAt))) deny('READ_INVALID', 'verification', 'Invalid sensor source timestamp');
  const unavailable = !entity || raw === 'unknown' || raw === 'unavailable' || raw === null;
  let value: string | number | null = null;
  if (!unavailable) {
    if (typeof raw !== 'string' || !raw.trim() || type === 'text' && raw.length > 80) deny('READ_INVALID', 'verification', 'Invalid sensor value');
    value = type === 'number' ? Number(raw) : raw;
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || unit === '%' && value > 100)) deny('READ_INVALID', 'verification', 'Invalid sensor value');
  }
  return { name, value, unit, availability: unavailable ? 'unavailable' : 'available', sourceUpdatedAt: updated, sourceKind: 'ha_cached_entity' };
}
export const projectHealth = (states: ReadonlyMap<string, HaEntity>, observedAt: string): ReadItem[] =>
  (['chargingStatus', 'error', 'lowWaterWarning', 'taskStatus'] as const).map(name => sensorEvidence(states, name, 'text', null, observedAt));
export function projectSensorCollection(states: ReadonlyMap<string, HaEntity>, operation: string, observedAt: string): ReadItem[] {
  const spec = operation === 'maintenance' ? MAINTENANCE : operation === 'statistics' ? STATISTICS : null;
  if (!spec) return deny('READ_INVALID', 'verification', 'Unsupported sensor collection');
  return spec.map(([name, unit, type]) => sensorEvidence(states, name, type, unit, observedAt));
}
const RawMapSchema = Type.Object({ selected_map_id: Positive, selected_map: Nonempty,
  rooms: Type.Record(Type.String(), Type.Unknown()), shortcuts: Type.Record(Type.String(), Type.Unknown()) });
const RawRoomsSchema = Type.Array(Type.Object({ id: Positive, name: Nonempty }));
const RawShortcutSchema = Type.Object({ id: Positive, map_id: Positive,
  tasks: Type.Array(Type.Array(Type.Object(ShortcutTaskSchema.properties))) });
export function projectMap(raw: unknown, observedAt: string): MapEvidence {
  try {
    const state = decode(HaEntitySchema, raw, 'ha_entity_invalid'), attrs = decode(RawMapSchema, state.attributes, 'ha_map_invalid');
    const rooms = decode(RawRoomsSchema, attrs.rooms[attrs.selected_map], 'ha_rooms_invalid').map(({ id, name }) => ({ id, name }));
    const shortcuts = Object.values(attrs.shortcuts).filter(item => plain(item) && item.map_id === attrs.selected_map_id)
      .map(item => {
        const shortcut = decode(RawShortcutSchema, item, 'ha_shortcut_invalid');
        return { id: shortcut.id, mapId: shortcut.map_id, tasks: shortcut.tasks.map(pass => pass.map(task => ({
          order: task.order, segment_id: task.segment_id, suction_level: task.suction_level, water_volume: task.water_volume,
          cleaning_times: task.cleaning_times, cleaning_mode: task.cleaning_mode, wetness_level: task.wetness_level,
          mopping_settings: task.mopping_settings, cleaning_route: task.cleaning_route, task_type: task.task_type,
        }))) };
      });
    return decode(MapSchema, { observedAt, mapId: attrs.selected_map_id, mapName: attrs.selected_map,
      rooms, shortcuts }, 'ha_map_invalid');
  } catch { return deny('INVALID_MAP', 'precondition', 'Selected Home Assistant map is unavailable'); }
}
const StatusAttributes = Type.Object({ battery: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0, maximum: 100 })])),
  active_segments: Type.Optional(Type.Union([Type.Null(), Type.Array(Positive)])), current_segment: Type.Optional(Type.Union([Type.Null(), Positive])) });
export function projectStatus(raw: unknown, observedAt: string): Extract<ReadData, { kind: 'status' }> {
  try {
    const state = decode(HaEntitySchema, raw, 'ha_entity_invalid'), attrs = decode(StatusAttributes, state.attributes, 'ha_status_invalid');
    if (state.last_updated !== undefined && (!Number.isFinite(Date.parse(state.last_updated)) || Date.parse(state.last_updated) > Date.parse(observedAt))) throw new Error('invalid timestamp');
    return { kind: 'status', observedAt, sourceUpdatedAt: state.last_updated ?? null, freshness: 'fresh', state: state.state,
      batteryLevel: attrs.battery ?? null, activeSegments: attrs.active_segments ?? null, currentSegment: attrs.current_segment ?? null,
      sourceKind: 'ha_cached_entity', locationMeaning: state.state === 'docked' ? 'map_localization' : 'reported_current_segment', health: [] };
  } catch { return deny('READ_INVALID', 'verification', 'Home Assistant status values are invalid'); }
}

/** Private completion projection. HA context/task booleans are observations,
 * never an original operation identity or an independent success receipt. */
const CompletionEventSchema = object({ schemaVersion: Type.Literal(1), kind: Type.Literal('jessica.completion-event'),
  deviceEntity: Nonempty, timeFired: Nonempty, lastUpdated: Nonempty, hasError: Type.Boolean(),
  task: object({ value: SafeInteger, sourceReadAt: Nonempty }) });
export function prepareJessicaCompletionEvent(raw: unknown): string {
  if (!plain(raw) || raw.type !== 'event' || !plain(raw.event) || raw.event.event_type !== 'state_changed' ||
    !plain(raw.event.data) || !plain(raw.event.data.new_state)) fail('jessica_completion_event_invalid');
  const event = raw.event, data = event.data;
  if (!plain(data)) fail('jessica_completion_event_invalid');
  const state = data.new_state;
  if (!plain(state) || state.entity_id !== data.entity_id || !plain(state.attributes) ||
    !plain(state.attributes.task_status_device_observation)) fail('jessica_completion_event_invalid');
  const task = state.attributes.task_status_device_observation;
  return JSON.stringify({ schemaVersion: 1, kind: 'jessica.completion-event', deviceEntity: state.entity_id,
    timeFired: event.time_fired, lastUpdated: state.last_updated, hasError: state.attributes.has_error,
    task: { value: task.value, sourceReadAt: task.source_read_at } });
}
export function projectJessicaCompletionEvent(raw: unknown, registry: Registry, now: number) {
  const event = decode(CompletionEventSchema, raw, 'jessica_completion_projection_invalid');
  const times = [event.task.sourceReadAt, event.lastUpdated, event.timeFired];
  if (event.deviceEntity !== registry.mapBinding.deviceEntity || !Number.isSafeInteger(now) ||
    !times.every(timestamp) || Date.parse(times[0]!) > Date.parse(times[1]!) ||
    Date.parse(times[1]!) > Date.parse(times[2]!) || Date.parse(times[2]!) > now ||
    now - Date.parse(times[0]!) > WARNING_EVENT_MAX_AGE_MS) fail('jessica_completion_event_not_current');
  return freeze(event);
}
/** Private source/domain contract, not vendor wire fields. The host must retain
 * an independently qualified witness for this entire proof. No installed Dreame
 * producer currently satisfies it. Fixtures explicitly supply simulated proof.
 * A provider taskId is unnecessary if the complete composite is actually proven. */
export const JessicaCompletionProofSchema = object({ version: Type.Literal('1'),
  level: Type.Enum(['simulated', 'authenticated']), sourceRef: Nonempty, inputId: Nonempty,
  operationId: Nonempty, ownerGeneration: SafeInteger, requestHash: Nonempty, planHash: Nonempty,
  identity: object({ kind: Type.Literal('single-active-operation'), sourceGeneration: Nonempty,
    observedFrom: Nonempty, observedThrough: Nonempty, gap: Type.Boolean(), replaced: Type.Boolean(), rebooted: Type.Boolean() }),
  mapId: Positive, mapFingerprint: Nonempty, mapGeneration: Nonempty, segments: Type.Array(Positive, { minItems: 1, maxItems: 1 }),
  start: object({ observedAt: Nonempty, sourceReadAt: Nonempty, positiveProgress: Type.Number({ exclusiveMinimum: 0 }) }),
  terminal: object({ observedAt: Nonempty, sourceReadAt: Nonempty, successful: Type.Boolean(), interrupted: Type.Boolean(),
    historyRef: Nonempty, mapId: Positive, segments: Type.Array(Positive, { minItems: 1, maxItems: 1 }) }) });
export function verifyJessicaCompletionProof(raw: unknown, event: ReturnType<typeof projectJessicaCompletionEvent>,
  binding: import('./operation-state.js').OperationCorrelation, source: { ref: string; inputId: string },
  startObservedAt: string, registry: Registry) {
  const proof = decode(JessicaCompletionProofSchema, raw, 'jessica_completion_proof_invalid');
  const identity = proof.identity, start = proof.start, terminal = proof.terminal;
  const times = [identity.observedFrom, start.sourceReadAt, start.observedAt, terminal.sourceReadAt,
    terminal.observedAt, identity.observedThrough, startObservedAt, binding.createdAt];
  if (!times.every(timestamp) || event.task.value !== 0 || event.hasError ||
    proof.sourceRef !== source.ref || proof.inputId !== source.inputId || proof.operationId !== binding.owner.operationId ||
    proof.ownerGeneration !== binding.owner.generation || proof.requestHash !== binding.requestHash || proof.planHash !== binding.planHash ||
    identity.gap || identity.replaced || identity.rebooted || !terminal.successful || terminal.interrupted ||
    proof.mapId !== registry.mapBinding.mapId || proof.mapFingerprint !== binding.plan.mapFingerprint ||
    proof.mapFingerprint !== registry.mapFingerprint || proof.mapGeneration !== binding.plan.mapGeneration ||
    proof.mapGeneration !== registry.mapBinding.generation || terminal.mapId !== proof.mapId ||
    binding.plan.rooms.length !== 1 || proof.segments[0] !== binding.plan.rooms[0]?.segmentId ||
    terminal.segments[0] !== proof.segments[0] ||
    Date.parse(identity.observedFrom) > Date.parse(binding.createdAt) ||
    Date.parse(start.sourceReadAt) < Date.parse(binding.createdAt) ||
    Date.parse(start.sourceReadAt) > Date.parse(start.observedAt) ||
    Date.parse(start.observedAt) < Date.parse(startObservedAt) ||
    Date.parse(start.observedAt) >= Date.parse(terminal.sourceReadAt) ||
    Date.parse(terminal.sourceReadAt) > Date.parse(terminal.observedAt) ||
    terminal.sourceReadAt !== event.task.sourceReadAt || terminal.observedAt !== event.timeFired ||
    Date.parse(identity.observedThrough) !== Date.parse(event.timeFired)) return null;
  return freeze(proof);
}

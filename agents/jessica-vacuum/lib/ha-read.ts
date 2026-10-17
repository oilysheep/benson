import Type, { type Static } from 'typebox';
import { decode, plain } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { MapSchema, Positive, SafeInteger, Nonempty, ShortcutTaskSchema, type MapEvidence } from './schemas.js';
import { deny } from './errors.js';
import type { ReadData, ReadItem } from './results.js';

export const VACUUM_ENTITY = 'vacuum.jesica_jesica';
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

import { readFile } from 'node:fs/promises';
import { deny } from './errors.mjs';

const HA_URL = 'http://127.0.0.1:8123';
const TOKEN_FILE = '/home/oa/.openclaw/secrets/homeassistant-token';
const VACUUM_ENTITY = 'vacuum.jesica_jesica';
const TASK_FIELDS = [
  'order', 'segment_id', 'suction_level', 'water_volume', 'cleaning_times',
  'cleaning_mode', 'wetness_level', 'mopping_settings', 'cleaning_route', 'task_type',
];
const SENSOR_FIELDS = Object.freeze({
  chargingStatus: 'sensor.jesica_charging_status',
  error: 'sensor.jesica_error',
  lowWaterWarning: 'sensor.jesica_low_water_warning',
  taskStatus: 'sensor.jesica_task_status',
  dustBag: 'sensor.jesica_dust_bag_status',
  cleanWaterTank: 'sensor.jesica_clean_water_tank_status',
  dirtyWaterTank: 'sensor.jesica_dirty_water_tank_status',
  detergent: 'sensor.jesica_detergent_status',
  mainBrushPercent: 'sensor.jesica_main_brush_left',
  mainBrushHours: 'sensor.jesica_main_brush_time_left',
  sideBrushPercent: 'sensor.jesica_side_brush_left',
  sideBrushHours: 'sensor.jesica_side_brush_time_left',
  filterPercent: 'sensor.jesica_filter_left',
  filterHours: 'sensor.jesica_filter_time_left',
  sensorCarePercent: 'sensor.jesica_sensor_dirty_left',
  sensorCareHours: 'sensor.jesica_sensor_dirty_time_left',
  totalCleaningMinutes: 'sensor.jesica_total_cleaning_time',
  cleaningCount: 'sensor.jesica_cleaning_count',
  totalCleanedArea: 'sensor.jesica_total_cleaned_area',
  currentCleaningMinutes: 'sensor.jesica_cleaning_time',
  currentCleanedArea: 'sensor.jesica_cleaned_area',
});
const MAINTENANCE = Object.freeze([
  ['mainBrushPercent', '%', 'number'], ['mainBrushHours', 'h', 'number'],
  ['sideBrushPercent', '%', 'number'], ['sideBrushHours', 'h', 'number'],
  ['filterPercent', '%', 'number'], ['filterHours', 'h', 'number'],
  ['sensorCarePercent', '%', 'number'], ['sensorCareHours', 'h', 'number'],
  ['dustBag', null, 'text'], ['cleanWaterTank', null, 'text'],
  ['dirtyWaterTank', null, 'text'], ['detergent', null, 'text'],
]);
const STATISTICS = Object.freeze([
  ['totalCleaningMinutes', 'min', 'number'], ['cleaningCount', 'count', 'number'],
  ['totalCleanedArea', 'm²', 'number'], ['currentCleaningMinutes', 'min', 'number'],
  ['currentCleanedArea', 'm²', 'number'],
]);

export async function haFetch(path, init = {}, fetchImpl = fetch, assertCurrent = () => {}) {
  assertCurrent();
  const token = (await readFile(TOKEN_FILE, 'utf8')).trim();
  if (!token) deny('READ_UNAVAILABLE', 'verification', 'Home Assistant credential is unavailable');
  assertCurrent();
  return fetchImpl(`${HA_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(8_000),
  });
}

export async function readVacuumState(fetchImpl = fetch, assertCurrent = () => {}) {
  const response = await haFetch(`/api/states/${VACUUM_ENTITY}`, { method: 'GET' }, fetchImpl, assertCurrent);
  if (!response.ok) deny('READ_UNAVAILABLE', 'verification', 'Home Assistant state is unavailable');
  const state = await response.json();
  if (!state || state.entity_id !== VACUUM_ENTITY || typeof state.state !== 'string' ||
      !state.attributes || typeof state.attributes !== 'object') {
    deny('READ_INVALID', 'verification', 'Home Assistant state shape is invalid');
  }
  return { state, observedAt: new Date().toISOString() };
}

export async function readJessicaSensors(fetchImpl = fetch, assertCurrent = () => {}) {
  const response = await haFetch('/api/states', { method: 'GET' }, fetchImpl, assertCurrent);
  if (!response.ok) deny('READ_UNAVAILABLE', 'verification', 'Home Assistant sensors are unavailable');
  const states = await response.json();
  if (!Array.isArray(states)) deny('READ_INVALID', 'verification', 'Home Assistant sensor inventory is invalid');
  const allowed = new Set(Object.values(SENSOR_FIELDS));
  const selected = new Map();
  for (const state of states) {
    if (!allowed.has(state?.entity_id)) continue;
    if (selected.has(state.entity_id)) deny('READ_INVALID', 'verification', 'Duplicate Jessica sensor identity');
    selected.set(state.entity_id, state);
  }
  return selected;
}

function sensorEvidence(states, name, type, unit = null, observedAt = new Date().toISOString()) {
  const state = states.get(SENSOR_FIELDS[name]);
  const raw = state?.state;
  const sourceUpdatedAt = state?.last_updated;
  if (state && (typeof sourceUpdatedAt !== 'string' || !Number.isFinite(Date.parse(sourceUpdatedAt)) ||
      Date.parse(sourceUpdatedAt) > Date.parse(observedAt))) {
    deny('READ_INVALID', 'verification', `Invalid ${name} source timestamp`);
  }
  const unavailable = !state || raw === 'unknown' || raw === 'unavailable' || raw === null;
  let value = null;
  if (!unavailable) {
    if (type === 'number') {
      value = Number(raw);
      if (typeof raw !== 'string' || !raw.trim() || !Number.isFinite(value) || value < 0 ||
          (unit === '%' && value > 100)) deny('READ_INVALID', 'verification', `Invalid ${name} sensor value`);
    } else {
      if (typeof raw !== 'string' || !raw.trim() || raw.length > 80) deny('READ_INVALID', 'verification', `Invalid ${name} sensor value`);
      value = raw;
    }
  }
  return { name, value, unit, availability: unavailable ? 'unavailable' : 'available',
    sourceUpdatedAt: state ? sourceUpdatedAt : null, sourceKind: 'ha_cached_entity' };
}

export function projectSensorCollection(states, operation, observedAt) {
  const spec = operation === 'maintenance' ? MAINTENANCE : operation === 'statistics' ? STATISTICS : null;
  if (!spec) deny('READ_INVALID', 'verification', 'Unsupported sensor collection');
  return spec.map(([name, unit, type]) => sensorEvidence(states, name, type, unit, observedAt));
}

export function projectHealth(states, observedAt) {
  return ['chargingStatus', 'error', 'lowWaterWarning', 'taskStatus'].map((name) =>
    sensorEvidence(states, name, 'text', null, observedAt));
}

export function projectMap(state, observedAt) {
  const attrs = state?.attributes;
  const selected = attrs?.selected_map;
  const rooms = selected && attrs?.rooms?.[selected];
  if (!Number.isSafeInteger(attrs?.selected_map_id) || typeof selected !== 'string' ||
      !Array.isArray(rooms) || !attrs.shortcuts || typeof attrs.shortcuts !== 'object') {
    deny('INVALID_MAP', 'precondition', 'Selected Home Assistant map is unavailable');
  }
  return {
    observedAt,
    mapId: attrs.selected_map_id,
    mapName: selected,
    rooms: rooms.map((room) => ({ id: room.id, name: room.name })),
    shortcuts: Object.values(attrs.shortcuts)
      .filter((item) => item?.map_id === attrs.selected_map_id)
      .map((item) => ({
        id: item.id,
        mapId: item.map_id,
        tasks: item.tasks?.map((pass) => pass.map((task) =>
          Object.fromEntries(TASK_FIELDS.map((field) => [field, task[field]])))),
      })),
  };
}

export function projectStatus(state, observedAt) {
  const attrs = state.attributes;
  const batteryLevel = attrs.battery ?? null;
  const activeSegments = attrs.active_segments ?? null;
  const currentSegment = attrs.current_segment ?? null;
  if ((batteryLevel !== null && (!Number.isSafeInteger(batteryLevel) || batteryLevel < 0 || batteryLevel > 100)) ||
      (activeSegments !== null && (!Array.isArray(activeSegments) ||
        !activeSegments.every((id) => Number.isSafeInteger(id) && id > 0))) ||
      (currentSegment !== null && (!Number.isSafeInteger(currentSegment) || currentSegment < 1)) ||
      (state.last_updated !== undefined && (!Number.isFinite(Date.parse(state.last_updated)) ||
        Date.parse(state.last_updated) > Date.parse(observedAt)))) {
    deny('READ_INVALID', 'verification', 'Home Assistant status values are invalid');
  }
  return {
    kind: 'status', observedAt,
    sourceUpdatedAt: typeof state.last_updated === 'string' ? state.last_updated : null,
    freshness: 'fresh', state: state.state, batteryLevel, activeSegments, currentSegment,
    sourceKind: 'ha_cached_entity', locationMeaning: state.state === 'docked' ? 'map_localization' : 'reported_current_segment',
    health: [],
  };
}

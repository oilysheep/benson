import Type from 'typebox';
import { object, decode } from '../../../../integrations/openclaw/benson-routing/core/value.js';
import { deny } from '../errors.js';
import { VACUUM_ENTITY, projectStatus, projectMap } from '../ha-read.js';
import { Nonempty, SafeInteger, Positive, SuctionSchema, type Settings } from '../schemas.js';
import { DeviceStepSchema, type JessicaDevice, type InvocationAuthority, type DeviceSnapshot } from '../ports.js';
import { createHaReader, type HaTransport } from './ha-transport.js';

interface DispatchScope { readonly segments: readonly number[]; readonly suction?: Settings['suction'];
  readonly control?: 'pause' | 'dock'; readonly pauseSets?: readonly (readonly number[])[]; readonly home?: boolean }
const EntitySignal = Type.Object({ entity_id: Nonempty, state: Nonempty, last_updated: Nonempty });
const SuctionEntity = Type.Object({ ...EntitySignal.properties, state: SuctionSchema, attributes: Type.Object({ options: Type.Array(SuctionSchema) }) });
const HomeTask = object({ value: SafeInteger, source_read_at: Nonempty });
const Geometry = object({ availability: Type.Literal('available'), sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }), map_id: Positive,
  device_map_list_read_at: Nonempty, saved_map_loaded_at: Nonempty, visible_segment_ids: Type.Array(Positive, { uniqueItems: true }),
  hidden_segment_ids: Type.Array(Positive, { uniqueItems: true }), no_go_count: Type.Integer({ minimum: 0 }),
  no_mop_count: Type.Integer({ minimum: 0 }), virtual_wall_count: Type.Integer({ minimum: 0 }) });
const validIds = (ids: readonly number[]) => ids.length > 0 && new Set(ids).size === ids.length && ids.every(id => Number.isSafeInteger(id) && id > 0);
const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && new Set(a).size === a.length && a.every(id => b.includes(id));
export function createHaDevice(transport: HaTransport, scope: DispatchScope, clock = () => new Date()): JessicaDevice {
  const reviewed = structuredClone(scope);
  if (reviewed.home ? reviewed.segments.length !== 0 || reviewed.suction !== undefined || reviewed.control !== undefined || (reviewed.pauseSets?.length ?? 0) !== 0 : !validIds(reviewed.segments)) throw new Error('Reviewed Jessica dispatch scope is invalid');
  if (reviewed.suction !== undefined) decode(SuctionSchema, reviewed.suction, 'suction_scope_invalid');
  if (reviewed.pauseSets?.some(set => reviewed.control !== 'pause' || set.length < 2 || !validIds(set) || !set.every(id => reviewed.segments.includes(id)))) throw new Error('Reviewed Jessica pause scope is invalid');
  const reader = createHaReader(transport, clock);
  const beforeNow = (value: string) => Number.isFinite(Date.parse(value)) && Date.parse(value) <= clock().getTime();
  async function signal(entity: string, authority: InvocationAuthority) {
    const value = decode(EntitySignal, await transport.get(`/api/states/${entity}`, authority), 'ha_signal_invalid');
    if (value.entity_id !== entity || !beforeNow(value.last_updated)) deny('READ_INVALID', 'verification', 'Jessica signal identity or timestamp is invalid');
    return { value: value.state, sourceUpdatedAt: value.last_updated, observedAt: clock().toISOString() };
  }
  async function progress(entity: string, authority: InvocationAuthority) {
    const value = await signal(entity, authority), numeric = Number(value.value);
    if (!value.value.trim() || !Number.isFinite(numeric) || numeric < 0) deny('READ_INVALID', 'verification', 'Jessica progress signal is invalid');
    return { ...value, value: numeric };
  }
  return { async read(authority) {
    const { state } = await reader.readState(authority), task = await signal('sensor.jesica_task_status', authority);
    const currentArea = reviewed.control ? await progress('sensor.jesica_cleaned_area', authority) : null;
    const currentTime = reviewed.control ? await progress('sensor.jesica_cleaning_time', authority) : null;
    const chargingStatus = reviewed.control === 'dock' ? await signal('sensor.jesica_charging_status', authority) : null;
    if (chargingStatus && !['not_charging', 'return_to_charge', 'charging', 'charging_completed'].includes(chargingStatus.value)) deny('READ_INVALID', 'verification', 'Jessica charging state is invalid');
    const settings: Settings = {};
    let settingSources: DeviceSnapshot['settingSources'] = null, deviceSuction: string | null = null, options: DeviceSnapshot['options'];
    if (reviewed.suction !== undefined) {
      const rawSuction = state.attributes.suction_level;
      if (typeof rawSuction !== 'string') deny('READ_INVALID', 'verification', 'Jessica device suction is unavailable');
      deviceSuction = decode(SuctionSchema, rawSuction.toLowerCase(), 'device_suction_invalid');
      const setting = decode(SuctionEntity, await transport.get('/api/states/select.jesica_suction_level', authority), 'suction_entity_invalid');
      if (setting.entity_id !== 'select.jesica_suction_level' || !beforeNow(setting.last_updated) || !setting.attributes.options.includes(setting.state) || !setting.attributes.options.includes(reviewed.suction)) deny('READ_INVALID', 'verification', 'Jessica suction state or options are invalid');
      const observedAt = clock().toISOString();
      settings.suction = setting.state; options = { observedAt, suction: setting.attributes.options };
      settingSources = { suction: { observedAt, sourceUpdatedAt: setting.last_updated } };
    }
    const observedAt = clock().toISOString();
    let home: Pick<DeviceSnapshot, 'taskDevice' | 'homeGeometry'> = {};
    if (reviewed.home) {
      const t = decode(HomeTask, state.attributes.task_status_device_observation, 'home_task_invalid');
      const g = decode(Geometry, state.attributes.selected_map_geometry_observation, 'home_geometry_invalid');
      if (![t.source_read_at, g.device_map_list_read_at, g.saved_map_loaded_at].every(beforeNow) || g.hidden_segment_ids.some(id => g.visible_segment_ids.includes(id))) deny('READ_INVALID', 'verification', 'Device-confirmed home evidence is unavailable');
      home = { taskDevice: { value: t.value, sourceReadAt: t.source_read_at }, homeGeometry: { sha256: g.sha256, mapId: g.map_id,
        deviceMapListReadAt: g.device_map_list_read_at, savedMapLoadedAt: g.saved_map_loaded_at, visibleSegmentIds: g.visible_segment_ids,
        hiddenSegmentIds: g.hidden_segment_ids, noGoCount: g.no_go_count, noMopCount: g.no_mop_count, virtualWallCount: g.virtual_wall_count } };
    }
    const status = projectStatus(state, observedAt);
    return { ...home, map: projectMap(state, observedAt), status: { observedAt: status.observedAt, sourceUpdatedAt: status.sourceUpdatedAt,
      state: status.state, activeSegments: status.activeSegments, currentSegment: status.currentSegment },
      taskStatus: { state: task.value, observedAt: task.observedAt, sourceUpdatedAt: task.sourceUpdatedAt }, currentArea, currentTime, chargingStatus,
      taskId: null, taskScope: null, ...(options ? { options } : {}), settings, settingSources, deviceSuction,
      error: state.attributes.has_error === false ? null : 'DEVICE_ERROR_OR_UNKNOWN' };
  }, async dispatch(raw, guard) {
    const step = decode(DeviceStepSchema, raw, 'jessica_step_invalid');
    let path: string, body: object;
    if (reviewed.home && step.kind === 'command' && step.operation === 'clean' && step.targetKind === 'home' && step.segments.length === 0) {
      path = '/api/services/vacuum/start'; body = { entity_id: VACUUM_ENTITY };
    } else if (step.kind === 'setting' && step.name === 'suction' && reviewed.suction !== undefined && step.value === reviewed.suction) {
      path = '/api/services/select/select_option'; body = { entity_id: 'select.jesica_suction_level', option: step.value };
    } else if (!reviewed.home && step.kind === 'command' && step.operation === reviewed.control && step.targetKind === null &&
      (step.segments.length === 1 && step.segments.every(id => reviewed.segments.includes(id)) || reviewed.pauseSets?.some(set => sameIds(step.segments, set)))) {
      path = reviewed.control === 'pause' ? '/api/services/vacuum/pause' : '/api/services/vacuum/return_to_base'; body = { entity_id: VACUUM_ENTITY };
    } else if (!reviewed.home && step.kind === 'command' && step.operation === 'clean' && step.targetKind === 'rooms' &&
      step.segments.length === reviewed.segments.length && step.segments.every((id, index) => id === reviewed.segments[index])) {
      path = '/api/services/dreame_vacuum/vacuum_clean_segment'; body = { entity_id: VACUUM_ENTITY, segments: reviewed.segments.length === 1 ? reviewed.segments[0] : reviewed.segments };
    } else throw new Error('HA adapter received an unapproved command');
    return transport.post(path, body, guard);
  } };
}

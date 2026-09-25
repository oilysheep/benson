import { deny } from './errors.mjs';
import { haFetch, projectMap, projectStatus, readVacuumState } from './ha-read.mjs';

const VACUUM_ENTITY = 'vacuum.jesica_jesica';
const TASK_STATUS_ENTITY = 'sensor.jesica_task_status';
const AREA_ENTITY = 'sensor.jesica_cleaned_area';
const TIME_ENTITY = 'sensor.jesica_cleaning_time';
const CHARGING_ENTITY = 'sensor.jesica_charging_status';
const SUCTION_ENTITY = 'select.jesica_suction_level';
const SUCTION_OPTIONS = ['quiet', 'standard', 'strong', 'turbo'];

function projectHomeObservation(state, observedAt) {
  const task = state.attributes.task_status_device_observation;
  const geometry = state.attributes.selected_map_geometry_observation;
  const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    Date.parse(value) <= Date.parse(observedAt);
  const ids = (value) => Array.isArray(value) && new Set(value).size === value.length &&
    value.every((id) => Number.isSafeInteger(id) && id > 0);
  if (!task || Object.keys(task).sort().join(',') !== 'source_read_at,value' ||
      !Number.isSafeInteger(task.value) || !validTime(task.source_read_at) ||
      !geometry || geometry.availability !== 'available' ||
      Object.keys(geometry).sort().join(',') !==
        'availability,device_map_list_read_at,hidden_segment_ids,map_id,no_go_count,no_mop_count,saved_map_loaded_at,sha256,virtual_wall_count,visible_segment_ids' ||
      !/^[a-f0-9]{64}$/u.test(geometry.sha256 ?? '') ||
      !Number.isSafeInteger(geometry.map_id) || geometry.map_id < 1 ||
      !validTime(geometry.device_map_list_read_at) || !validTime(geometry.saved_map_loaded_at) ||
      !ids(geometry.visible_segment_ids) || !ids(geometry.hidden_segment_ids) ||
      geometry.hidden_segment_ids.some((id) => geometry.visible_segment_ids.includes(id)) ||
      ![geometry.no_go_count, geometry.no_mop_count, geometry.virtual_wall_count]
        .every((count) => Number.isSafeInteger(count) && count >= 0)) {
    deny('READ_INVALID', 'verification', 'Device-confirmed home evidence is unavailable');
  }
  return {
    taskDevice: { value: task.value, sourceReadAt: task.source_read_at },
    homeGeometry: {
      sha256: geometry.sha256, mapId: geometry.map_id,
      deviceMapListReadAt: geometry.device_map_list_read_at,
      savedMapLoadedAt: geometry.saved_map_loaded_at,
      visibleSegmentIds: [...geometry.visible_segment_ids],
      hiddenSegmentIds: [...geometry.hidden_segment_ids],
      noGoCount: geometry.no_go_count, noMopCount: geometry.no_mop_count,
      virtualWallCount: geometry.virtual_wall_count,
    },
  };
}

export function createHaCanaryDriver({ expectedSegmentId, expectedSegments = null, canarySuction = null,
  controlOperation = null, controlCanarySegments = null, controlVerifiedSets = [], homeCanary = false,
  readState = readVacuumState, request = haFetch } = {}) {
  const reviewedSegments = expectedSegments ?? (expectedSegmentId === undefined ? null : [expectedSegmentId]);
  if (!Array.isArray(reviewedSegments) || (homeCanary ? reviewedSegments.length !== 0 : !reviewedSegments.length) ||
      reviewedSegments.some((segment) => !Number.isSafeInteger(segment) || segment < 1) ||
      new Set(reviewedSegments).size !== reviewedSegments.length) {
    throw new Error('A reviewed canary segment set is required');
  }
  if (homeCanary && (canarySuction !== null || controlOperation !== null ||
      controlCanarySegments !== null || controlVerifiedSets.length !== 0)) {
    throw new Error('Home canary cannot share setting or control dispatch authority');
  }
  if (canarySuction !== null && !SUCTION_OPTIONS.includes(canarySuction)) {
    throw new Error('A reviewed suction option is required');
  }
  if (controlOperation !== null && !['pause', 'dock'].includes(controlOperation)) {
    throw new Error('An approved control operation is required');
  }
  if (controlCanarySegments !== null && (controlOperation !== 'pause' ||
      !Array.isArray(controlCanarySegments) || controlCanarySegments.length < 2 ||
      new Set(controlCanarySegments).size !== controlCanarySegments.length ||
      controlCanarySegments.some((segment) => !reviewedSegments.includes(segment)))) {
    throw new Error('A reviewed multi-room pause scope is required');
  }
  if (!Array.isArray(controlVerifiedSets) || controlVerifiedSets.some((set) =>
      controlOperation !== 'pause' || !Array.isArray(set) || set.length < 2 ||
      new Set(set).size !== set.length || set.some((segment) => !reviewedSegments.includes(segment)))) {
    throw new Error('A reviewed multi-room pause scope is required');
  }
  async function readSignal(entity, allowed) {
    const response = await request(`/api/states/${entity}`, { method: 'GET' });
    if (!response.ok) deny('READ_UNAVAILABLE', 'verification', `${entity} is unavailable`);
    const signal = await response.json();
    const observedAt = new Date().toISOString();
    if (signal?.entity_id !== entity || !allowed(signal.state) ||
        !Number.isFinite(Date.parse(signal.last_updated)) ||
        Date.parse(signal.last_updated) > Date.parse(observedAt)) {
      deny('READ_INVALID', 'verification', `${entity} is invalid`);
    }
    return { value: signal.state, sourceUpdatedAt: signal.last_updated, observedAt };
  }
  return Object.freeze({
    async read() {
      const { state } = await readState();
      const response = await request(`/api/states/${TASK_STATUS_ENTITY}`, { method: 'GET' });
      if (!response.ok) deny('READ_UNAVAILABLE', 'verification', 'Jessica task status is unavailable');
      const task = await response.json();
      const taskObservedAt = new Date().toISOString();
      if (task?.entity_id !== TASK_STATUS_ENTITY || typeof task.state !== 'string' ||
          !Number.isFinite(Date.parse(task.last_updated)) ||
          Date.parse(task.last_updated) > Date.parse(taskObservedAt)) {
        deny('READ_INVALID', 'verification', 'Jessica task status is invalid');
      }
      const currentArea = controlOperation === null ? null : await readSignal(AREA_ENTITY,
        (value) => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0);
      if (currentArea) currentArea.value = Number(currentArea.value);
      const currentTime = controlOperation === null ? null : await readSignal(TIME_ENTITY,
        (value) => typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0);
      if (currentTime) currentTime.value = Number(currentTime.value);
      const chargingStatus = controlOperation === 'dock' ? await readSignal(CHARGING_ENTITY,
        (value) => ['not_charging', 'return_to_charge', 'charging', 'charging_completed'].includes(value)) : null;
      let options = null;
      let settings = {};
      let settingSources = null;
      let deviceSuction = null;
      if (canarySuction !== null) {
        const rawDeviceSuction = state.attributes.suction_level;
        if (typeof rawDeviceSuction !== 'string' ||
            !SUCTION_OPTIONS.includes(rawDeviceSuction.toLowerCase())) {
          deny('READ_INVALID', 'verification', 'Jessica device suction is unavailable');
        }
        deviceSuction = rawDeviceSuction.toLowerCase();
        const settingResponse = await request(`/api/states/${SUCTION_ENTITY}`, { method: 'GET' });
        if (!settingResponse.ok) deny('READ_UNAVAILABLE', 'verification', 'Jessica suction state is unavailable');
        const setting = await settingResponse.json();
        const settingObservedAt = new Date().toISOString();
        if (setting?.entity_id !== SUCTION_ENTITY || !SUCTION_OPTIONS.includes(setting.state) ||
            !Array.isArray(setting.attributes?.options) ||
            !setting.attributes.options.every((value) => SUCTION_OPTIONS.includes(value)) ||
            !setting.attributes.options.includes(setting.state) ||
            !setting.attributes.options.includes(canarySuction) ||
            !Number.isFinite(Date.parse(setting.last_updated)) ||
            Date.parse(setting.last_updated) > Date.parse(settingObservedAt)) {
          deny('READ_INVALID', 'verification', 'Jessica suction state or options are invalid');
        }
        options = { observedAt: settingObservedAt, suction: setting.attributes.options };
        settings = { suction: setting.state };
        settingSources = { suction: { observedAt: settingObservedAt, sourceUpdatedAt: setting.last_updated } };
      }
      const completedReadAt = new Date().toISOString();
      const homeObservation = homeCanary ? projectHomeObservation(state, completedReadAt) : {};
      return {
        map: projectMap(state, completedReadAt), status: projectStatus(state, completedReadAt),
        taskStatus: { state: task.state, sourceUpdatedAt: task.last_updated, observedAt: taskObservedAt },
        currentArea, currentTime, chargingStatus, ...homeObservation,
        taskId: null, taskScope: null, options, settings, settingSources, deviceSuction,
        error: state.attributes.has_error === false ? null : 'DEVICE_ERROR_OR_UNKNOWN',
      };
    },
    async dispatch(step) {
      if (homeCanary && step?.kind === 'command' && step.operation === 'clean' &&
          step.targetKind === 'home' && step.workflowId === null &&
          Array.isArray(step.segments) && step.segments.length === 0) {
        const response = await request('/api/services/vacuum/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity_id: VACUUM_ENTITY }),
        });
        return { accepted: response.ok };
      }
      if (step?.kind === 'command' && step.operation === controlOperation &&
          ['pause', 'dock'].includes(controlOperation) &&
          step.targetKind === null && step.workflowId === null &&
          Array.isArray(step.segments) && (step.segments.length === 1 &&
            reviewedSegments.includes(step.segments[0]) ||
            controlCanarySegments !== null && step.segments.length === controlCanarySegments.length &&
            new Set(step.segments).size === step.segments.length &&
            step.segments.every((segment) => controlCanarySegments.includes(segment)) ||
            controlVerifiedSets.some((set) => step.segments.length === set.length &&
              new Set(step.segments).size === step.segments.length &&
              step.segments.every((segment) => set.includes(segment))))) {
        const service = controlOperation === 'pause' ? 'pause' : 'return_to_base';
        const response = await request(`/api/services/vacuum/${service}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity_id: VACUUM_ENTITY }),
        });
        return { accepted: response.ok };
      }
      if (canarySuction !== null && step?.kind === 'setting' && step.name === 'suction' &&
          step.value === canarySuction) {
        const response = await request('/api/services/select/select_option', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entity_id: SUCTION_ENTITY, option: canarySuction }),
        });
        return { accepted: response.ok };
      }
      if (homeCanary || step?.kind !== 'command' || step.operation !== 'clean' ||
          step.targetKind !== 'rooms' || step.workflowId !== null ||
          !Array.isArray(step.segments) || step.segments.length !== reviewedSegments.length ||
          !step.segments.every((segment, index) => segment === reviewedSegments[index])) {
        throw new Error('HA canary driver received an unapproved command');
      }
      const response = await request('/api/services/dreame_vacuum/vacuum_clean_segment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: VACUUM_ENTITY,
          segments: reviewedSegments.length === 1 ? reviewedSegments[0] : reviewedSegments }),
      });
      return { accepted: response.ok };
    },
  });
}

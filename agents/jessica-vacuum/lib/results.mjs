import { deny } from './errors.mjs';
import { EXECUTE_OPERATIONS, READ_OPERATIONS, RESULT_VERSION } from './schemas.mjs';

const OUTCOMES = ['not_sent', 'accepted', 'preparing', 'started', 'paused', 'stopped', 'returning', 'docked', 'completed', 'unknown'];
const DISPATCH = ['not_attempted', 'accepted', 'rejected', 'unknown'];
const STAGES = ['input', 'identity', 'authorization', 'resolution', 'precondition', 'dispatch', 'verification', 'integrity'];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, keys, label) {
  if (!record(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    deny('INVALID_RESULT', 'integrity', `${label} has missing or unknown fields`);
  }
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function nonempty(value) {
  return typeof value === 'string' && value.length > 0;
}

function validReadItem(item, observedAt) {
  if (!record(item) || !nonempty(item.name) ||
      (item.value !== null && typeof item.value !== 'string' &&
        (typeof item.value !== 'number' || !Number.isFinite(item.value))) ||
      (item.unit !== null && !nonempty(item.unit))) return false;
  const keys = Object.keys(item).sort().join(',');
  if (keys === 'name,unit,value') return true;
  return keys === 'availability,name,sourceKind,sourceUpdatedAt,unit,value' &&
    ['available', 'unavailable'].includes(item.availability) &&
    item.sourceKind === 'ha_cached_entity' &&
    (item.sourceUpdatedAt === null || (timestamp(item.sourceUpdatedAt) &&
      Date.parse(item.sourceUpdatedAt) <= Date.parse(observedAt))) &&
    (item.availability === 'available') === (item.value !== null);
}

function observation(value) {
  const base = ['observedAt', 'sourceUpdatedAt', 'state', 'activeSegments', 'currentSegment'];
  const keys = [...base, ...(value?.taskStatus === undefined ? [] : ['taskStatus']),
    ...(value?.chargingStatus === undefined ? [] : ['chargingStatus']),
    ...(value?.homeTask === undefined ? [] : ['homeTask'])];
  exact(value, keys, 'observation');
  if (!timestamp(value.observedAt) || (value.sourceUpdatedAt !== null && !timestamp(value.sourceUpdatedAt)) ||
      !nonempty(value.state) ||
      (value.activeSegments !== null && (!Array.isArray(value.activeSegments) ||
        !value.activeSegments.every((id) => Number.isSafeInteger(id) && id > 0))) ||
      (value.currentSegment !== null && (!Number.isSafeInteger(value.currentSegment) || value.currentSegment < 1))) {
    deny('INVALID_RESULT', 'integrity', 'Observation is invalid');
  }
  if (value.taskStatus !== undefined) {
    exact(value.taskStatus, ['state', 'sourceUpdatedAt'], 'task status');
    if (!nonempty(value.taskStatus.state) || !timestamp(value.taskStatus.sourceUpdatedAt) ||
        Date.parse(value.taskStatus.sourceUpdatedAt) > Date.parse(value.observedAt)) {
      deny('INVALID_RESULT', 'integrity', 'Task status evidence is invalid');
    }
  }
  if (value.homeTask !== undefined) {
    exact(value.homeTask, ['value', 'sourceReadAt', 'geometrySha256', 'mapListReadAt'], 'home task');
    if (value.homeTask.value !== 1 || !timestamp(value.homeTask.sourceReadAt) ||
        !timestamp(value.homeTask.mapListReadAt) || !/^[a-f0-9]{64}$/u.test(value.homeTask.geometrySha256 ?? '') ||
        Date.parse(value.homeTask.sourceReadAt) > Date.parse(value.observedAt) ||
        Date.parse(value.homeTask.mapListReadAt) > Date.parse(value.observedAt)) {
      deny('INVALID_RESULT', 'integrity', 'Home task evidence is invalid');
    }
  }
  if (value.chargingStatus !== undefined) {
    exact(value.chargingStatus, ['value', 'sourceUpdatedAt'], 'charging status');
    if (!['charging', 'charging_completed'].includes(value.chargingStatus.value) ||
        !timestamp(value.chargingStatus.sourceUpdatedAt) ||
        Date.parse(value.chargingStatus.sourceUpdatedAt) > Date.parse(value.observedAt)) {
      deny('INVALID_RESULT', 'integrity', 'Charging evidence is invalid');
    }
  }
}

function actionData(data) {
  const allowed = ['operationId', 'rooms', 'outcome', 'dispatch', 'observation', 'appliedSettings', 'completionEvidence'];
  if (!record(data) || Object.keys(data).some((key) => !allowed.includes(key)) ||
      !allowed.slice(0, 6).every((key) => Object.hasOwn(data, key)) ||
      !nonempty(data.operationId) || !Array.isArray(data.rooms) ||
      !data.rooms.every(nonempty) || new Set(data.rooms).size !== data.rooms.length ||
      !OUTCOMES.includes(data.outcome) || !DISPATCH.includes(data.dispatch) ||
      !record(data.appliedSettings) ||
      Object.keys(data.appliedSettings).some((key) => !['suction', 'mode', 'wetness'].includes(key)) ||
      (data.appliedSettings.suction !== undefined && !['quiet', 'standard', 'strong', 'turbo'].includes(data.appliedSettings.suction)) ||
      (data.appliedSettings.mode !== undefined && !['sweeping', 'mopping', 'sweeping_and_mopping', 'mopping_after_sweeping'].includes(data.appliedSettings.mode)) ||
      (data.appliedSettings.wetness !== undefined && !Number.isSafeInteger(data.appliedSettings.wetness)) ||
      (data.observation !== null && !record(data.observation))) {
    deny('INVALID_RESULT', 'integrity', 'Action data is invalid');
  }
  if (data.observation !== null) observation(data.observation);
  if (data.completionEvidence !== undefined) {
    exact(data.completionEvidence, ['operationId', 'observedAt', 'source'], 'completionEvidence');
    if (data.completionEvidence.operationId !== data.operationId ||
        !timestamp(data.completionEvidence.observedAt) || !nonempty(data.completionEvidence.source)) {
      deny('INVALID_RESULT', 'integrity', 'Completion evidence does not match operation');
    }
  }
}

function readData(operation, data) {
  const fields = {
    status: ['kind', 'observedAt', 'sourceUpdatedAt', 'freshness', 'state', 'batteryLevel', 'activeSegments', 'currentSegment', 'sourceKind', 'locationMeaning', 'health'],
    rooms: ['kind', 'observedAt', 'sourceUpdatedAt', 'freshness', 'mapFingerprint', 'rooms'],
    capabilities: ['kind', 'observedAt', 'sourceUpdatedAt', 'freshness', 'capabilities', 'inventoryScope', 'liveAvailability'],
    maintenance: ['kind', 'observedAt', 'sourceUpdatedAt', 'freshness', 'items'],
    statistics: ['kind', 'observedAt', 'sourceUpdatedAt', 'freshness', 'metrics'],
    room_settings: ['kind', 'observedAt', 'sourceUpdatedAt', 'freshness', 'room', 'suction', 'mode', 'wetness'],
    operation_status: ['kind', 'observedAt', 'sourceUpdatedAt', 'freshness', 'operationId', 'outcome', 'dispatch', 'observation'],
  };
  const legacyFields = operation === 'status' ? fields.status.slice(0, -3) :
    operation === 'capabilities' ? fields.capabilities.slice(0, -2) : fields[operation];
  const actualKeys = Object.keys(data ?? {}).sort().join(',');
  if (actualKeys !== [...fields[operation]].sort().join(',') &&
      actualKeys !== [...legacyFields].sort().join(',')) exact(data, fields[operation], 'read data');
  if (data.kind !== operation || !timestamp(data.observedAt) ||
      (data.sourceUpdatedAt !== null && (!timestamp(data.sourceUpdatedAt) ||
        Date.parse(data.sourceUpdatedAt) > Date.parse(data.observedAt))) ||
      !['fresh', 'stale'].includes(data.freshness)) {
    deny('INVALID_RESULT', 'integrity', 'Read evidence is invalid');
  }
  if (operation === 'status') {
    if (!nonempty(data.state) || (data.batteryLevel !== null && (!Number.isSafeInteger(data.batteryLevel) ||
        data.batteryLevel < 0 || data.batteryLevel > 100)) ||
        (data.activeSegments !== null && (!Array.isArray(data.activeSegments) ||
          !data.activeSegments.every((id) => Number.isSafeInteger(id) && id > 0))) ||
        (data.currentSegment !== null && (!Number.isSafeInteger(data.currentSegment) || data.currentSegment < 1))) {
      deny('INVALID_RESULT', 'integrity', 'Status fields are invalid');
    }
    if (data.health !== undefined && (!Array.isArray(data.health) ||
        !['ha_cached_entity'].includes(data.sourceKind) ||
        !['map_localization', 'reported_current_segment'].includes(data.locationMeaning) ||
        !data.health.every((item) => validReadItem(item, data.observedAt)))) {
      deny('INVALID_RESULT', 'integrity', 'Health evidence is invalid');
    }
  } else if (operation === 'rooms') {
    if (!/^[a-f0-9]{64}$/u.test(data.mapFingerprint) || !Array.isArray(data.rooms) ||
        !data.rooms.every((room) => record(room) && Object.keys(room).sort().join(',') === 'enabled,label,segmentId,slug' &&
          nonempty(room.slug) && nonempty(room.label) && Number.isSafeInteger(room.segmentId) && typeof room.enabled === 'boolean')) {
      deny('INVALID_RESULT', 'integrity', 'Room data is invalid');
    }
  } else if (operation === 'capabilities') {
    if (data.inventoryScope !== undefined &&
        (data.inventoryScope !== 'accepted_registry_only' || data.liveAvailability !== 'not_checked')) {
      deny('INVALID_RESULT', 'integrity', 'Capability scope is invalid');
    }
    if (!Array.isArray(data.capabilities) || !data.capabilities.every((cap) => record(cap) &&
        Object.keys(cap).sort().join(',') ===
          ['name', 'observedAt', 'provenance', 'support',
            ...(cap.verifiedRooms === undefined ? [] : ['verifiedRooms']),
            ...(cap.verifiedRoomSets === undefined ? [] : ['verifiedRoomSets']),
            ...(cap.verifiedSettings === undefined ? [] : ['verifiedSettings'])].sort().join(',') &&
        nonempty(cap.name) && nonempty(cap.provenance) && ['disabled', 'reported', 'verified'].includes(cap.support) &&
        (cap.observedAt === null || timestamp(cap.observedAt)) &&
        (cap.verifiedRooms === undefined || (['clean_single_room', 'pause', 'dock'].includes(cap.name) &&
          (cap.name === 'clean_single_room' ? cap.support === 'reported' : cap.support === 'verified') &&
          Array.isArray(cap.verifiedRooms) && cap.verifiedRooms.length > 0 &&
          cap.verifiedRooms.every((item) => record(item) &&
            Object.keys(item).sort().join(',') === 'observedAt,provenance,room' &&
            nonempty(item.room) && timestamp(item.observedAt) && nonempty(item.provenance)))) &&
        (cap.verifiedRoomSets === undefined || (['clean_multi_room', 'pause'].includes(cap.name) &&
          (cap.name === 'clean_multi_room' ? cap.support === 'reported' : cap.support === 'verified') &&
          Array.isArray(cap.verifiedRoomSets) && cap.verifiedRoomSets.length > 0 &&
          cap.verifiedRoomSets.every((item) => record(item) &&
            Object.keys(item).sort().join(',') === 'observedAt,provenance,rooms' &&
            Array.isArray(item.rooms) && item.rooms.length >= 2 &&
            new Set(item.rooms).size === item.rooms.length &&
            item.rooms.every(nonempty) && timestamp(item.observedAt) && nonempty(item.provenance)))) &&
        (cap.verifiedSettings === undefined || (cap.name === 'clean_settings' && cap.support === 'reported' &&
          Array.isArray(cap.verifiedSettings) && cap.verifiedSettings.length === 1 &&
          cap.verifiedSettings.every((item) => record(item) &&
            Object.keys(item).sort().join(',') === 'observedAt,provenance,room,settings' &&
            nonempty(item.room) && timestamp(item.observedAt) && nonempty(item.provenance) &&
            record(item.settings) && Object.keys(item.settings).join(',') === 'suction' &&
            ['quiet', 'standard', 'strong', 'turbo'].includes(item.settings.suction)))))) {
      deny('INVALID_RESULT', 'integrity', 'Capability data is invalid');
    }
  } else if (operation === 'maintenance' || operation === 'statistics') {
    const collection = operation === 'maintenance' ? data.items : data.metrics;
    if (!Array.isArray(collection) || !collection.every((item) => validReadItem(item, data.observedAt))) {
      deny('INVALID_RESULT', 'integrity', 'Read collection is invalid');
    }
  } else if (operation === 'room_settings') {
    if (!nonempty(data.room) || ![null, 'quiet', 'standard', 'strong', 'turbo'].includes(data.suction) ||
        ![null, 'sweeping', 'mopping', 'sweeping_and_mopping', 'mopping_after_sweeping'].includes(data.mode) ||
        (data.wetness !== null && !Number.isSafeInteger(data.wetness))) {
      deny('INVALID_RESULT', 'integrity', 'Room settings are invalid');
    }
  } else if (operation === 'operation_status') {
    if (!nonempty(data.operationId) || !OUTCOMES.includes(data.outcome) || !DISPATCH.includes(data.dispatch)) {
      deny('INVALID_RESULT', 'integrity', 'Operation status is invalid');
    }
    if (data.observation !== null) observation(data.observation);
  }
}

function assertActionSuccess(result, expectedPlan, now) {
  const { operation, data } = result;
  if (!record(expectedPlan) || expectedPlan.operation !== operation ||
      !Array.isArray(expectedPlan.rooms) ||
      data.rooms.length !== expectedPlan.rooms.length ||
      data.rooms.some((slug, index) => slug !== expectedPlan.rooms[index]?.slug)) {
    deny('FALSE_SUCCESS', 'integrity', 'Action result is not bound to its validated plan');
  }
  if (result.verified !== true || data.dispatch !== 'accepted' || data.observation === null ||
      data.observation.sourceUpdatedAt === null ||
      ['accepted', 'preparing', 'not_sent', 'unknown'].includes(data.outcome)) {
    deny('FALSE_SUCCESS', 'integrity', 'Physical action has no verified outcome');
  }
  const observationAge = now.getTime() - Date.parse(data.observation.observedAt);
  if (!Number.isFinite(observationAge) || observationAge < 0 || observationAge > 60_000 ||
      Date.parse(data.observation.sourceUpdatedAt) > Date.parse(data.observation.observedAt)) {
    deny('FALSE_SUCCESS', 'integrity', 'Physical observation is stale or inconsistent');
  }
  if (expectedPlan.settings !== null) {
    for (const [key, value] of Object.entries(expectedPlan.settings)) {
      if (data.appliedSettings[key] !== value) {
        deny('FALSE_SUCCESS', 'integrity', 'Requested setting lacks verified application');
      }
    }
  }
  const state = data.observation.state;
  const allowed = {
    clean: { started: ['cleaning'], completed: ['docked', 'idle'] },
    pause: { paused: ['paused'] },
    resume: { started: ['cleaning'] },
    stop: { stopped: ['stopped', 'idle'] },
    dock: { returning: ['returning'], docked: ['docked'] },
  };
  if (!allowed[operation]?.[data.outcome]?.includes(state)) {
    deny('FALSE_SUCCESS', 'integrity', 'Observed state does not prove the claimed outcome');
  }
  if (operation === 'pause' && (data.outcome !== 'paused' ||
      data.observation.taskStatus?.state !== 'room_cleaning_paused' ||
      !Number.isFinite(Date.parse(data.observation.taskStatus?.sourceUpdatedAt)))) {
    deny('FALSE_SUCCESS', 'integrity', 'Pause requires a room-task pause signal');
  }
  if (operation === 'dock' && (data.outcome !== 'docked' ||
      !['charging', 'charging_completed'].includes(data.observation.chargingStatus?.value) ||
      !Number.isFinite(Date.parse(data.observation.chargingStatus?.sourceUpdatedAt)))) {
    deny('FALSE_SUCCESS', 'integrity', 'Dock requires a charging transition');
  }
  if (data.outcome === 'completed' && data.completionEvidence === undefined) {
    deny('FALSE_SUCCESS', 'integrity', 'Completion requires separate task evidence');
  }
  if (operation === 'clean' && data.outcome === 'started' && data.rooms.length > 0 &&
      (!Array.isArray(data.observation.activeSegments) ||
       [...data.observation.activeSegments].sort((a, b) => a - b).join(',') !==
       expectedPlan.rooms.map((room) => room.segmentId).sort((a, b) => a - b).join(','))) {
    deny('FALSE_SUCCESS', 'integrity', 'Active segments do not match the validated target');
  }
  if (operation === 'clean' && expectedPlan.roomTaskSignal && data.outcome === 'started' &&
      data.observation.taskStatus?.state !== 'room_cleaning') {
    deny('FALSE_SUCCESS', 'integrity', 'Room start lacks room-cleaning task evidence');
  }
  if (operation === 'clean' && expectedPlan.targetKind === 'home') {
    const home = data.observation.homeTask;
    if (data.outcome !== 'started' || data.rooms.length !== 0 ||
        !nonempty(expectedPlan.underTestId) ||
        !/^[a-f0-9]{64}$/u.test(expectedPlan.homeGeometrySha256 ?? '') ||
        home?.value !== 1 || home.geometrySha256 !== expectedPlan.homeGeometrySha256 ||
        !timestamp(home.sourceReadAt) || !timestamp(home.mapListReadAt) ||
        now.getTime() - Date.parse(home.sourceReadAt) < 0 ||
        now.getTime() - Date.parse(home.sourceReadAt) > 90_000 ||
        now.getTime() - Date.parse(home.mapListReadAt) < 0 ||
        now.getTime() - Date.parse(home.mapListReadAt) > 90_000 ||
        !(data.observation.activeSegments === null ||
          Array.isArray(data.observation.activeSegments) && data.observation.activeSegments.length === 0)) {
      deny('FALSE_SUCCESS', 'integrity', 'Home start lacks device-confirmed task and reviewed map evidence');
    }
  }
}

export function validateResult(result, expectedPlan = null, now = new Date()) {
  exact(result, ['schemaVersion', 'status', 'domain', 'operation', 'verified', 'data', 'warnings', 'error', 'pendingContext'], 'result');
  if (result.schemaVersion !== RESULT_VERSION || result.domain !== 'jessica-vacuum' ||
      !['success', 'clarification_required', 'failure'].includes(result.status) ||
      (result.operation !== null && ![...READ_OPERATIONS, ...EXECUTE_OPERATIONS].includes(result.operation)) ||
      typeof result.verified !== 'boolean' || !Array.isArray(result.warnings)) {
    deny('INVALID_RESULT', 'integrity', 'Result header is invalid');
  }
  for (const warning of result.warnings) {
    exact(warning, ['code', 'message'], 'warning');
    if (!nonempty(warning.code) || !nonempty(warning.message)) deny('INVALID_RESULT', 'integrity', 'Warning is invalid');
  }
  if (result.error !== null) {
    exact(result.error, ['code', 'stage', 'retryable', 'retryMode', 'sideEffects', 'message'], 'error');
    if (!nonempty(result.error.code) || !STAGES.includes(result.error.stage) ||
        typeof result.error.retryable !== 'boolean' ||
        !['none', 'read_only', 'reconcile'].includes(result.error.retryMode) ||
        !['none', 'possible', 'observed'].includes(result.error.sideEffects) ||
        !nonempty(result.error.message)) {
      deny('INVALID_RESULT', 'integrity', 'Error metadata is invalid');
    }
  }
  if (result.status === 'clarification_required') {
    exact(result.data, ['question', 'candidates'], 'clarification data');
    exact(result.pendingContext, ['version', 'clarificationId', 'expiresAt'], 'pending context');
    if (result.verified || result.error !== null || !nonempty(result.data.question) ||
        !Array.isArray(result.data.candidates) || !result.data.candidates.every((candidate) => {
          try { exact(candidate, ['room', 'label'], 'candidate'); return nonempty(candidate.room) && nonempty(candidate.label); }
          catch { return false; }
        }) || result.pendingContext.version !== '1' ||
        !nonempty(result.pendingContext.clarificationId) || !timestamp(result.pendingContext.expiresAt) ||
        Date.parse(result.pendingContext.expiresAt) <= now.getTime()) {
      deny('INVALID_RESULT', 'integrity', 'Clarification contract is invalid');
    }
  } else {
    if (result.pendingContext !== null || (result.status === 'failure') !== (result.error !== null)) {
      deny('INVALID_RESULT', 'integrity', 'Result status and error disagree');
    }
    if (result.operation === null) {
      if (result.status !== 'failure' || result.data !== null || result.verified) {
        deny('INVALID_RESULT', 'integrity', 'Unknown operation may only fail without facts');
      }
    } else if (READ_OPERATIONS.includes(result.operation)) {
      if (result.data === null) {
        if (result.status !== 'failure' || result.verified) deny('INVALID_RESULT', 'integrity', 'Read facts are missing');
      } else {
        readData(result.operation, result.data);
        const age = now.getTime() - Date.parse(result.data.observedAt);
        if (result.status === 'success' && (result.data.freshness !== 'fresh' || !result.verified ||
            !Number.isFinite(age) || age < 0 || age > 60_000)) {
          deny('FALSE_SUCCESS', 'integrity', 'Read success requires fresh evidence');
        }
      }
    } else {
      if (result.data === null) {
        if (result.status !== 'failure' || result.verified) deny('INVALID_RESULT', 'integrity', 'Action facts are missing');
      } else {
        actionData(result.data);
        if (result.status === 'success') assertActionSuccess(result, expectedPlan, now);
      }
    }
    if (result.status === 'success' && result.operation === null) {
      deny('FALSE_SUCCESS', 'integrity', 'Success has no operation');
    }
  }
  return structuredClone(result);
}

import { createHash } from 'node:crypto';
import { createDomainCore } from '../../../../../agents/jessica-vacuum/lib/domain-core.mjs';
import { DomainError } from '../../../../../agents/jessica-vacuum/lib/errors.mjs';
import { authorize, loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.mjs';
import { assertFreshMap, loadRegistry } from '../../../../../agents/jessica-vacuum/lib/registry.mjs';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.mjs';
import { parseExecuteRequest, EXECUTE_OPERATIONS } from '../../../../../agents/jessica-vacuum/lib/schemas.mjs';
import { createOperationState } from './operation-state.js';

const DEVICE = 'jessica-vacuum';
const POLL_MS = 2_000;
const TIMEOUT_MS = { clean: 240_000, pause: 30_000, resume: 240_000, stop: 15_000, dock: 240_000 };
const waitDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sortObject = (value) => Array.isArray(value) ? value.map(sortObject) :
  value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortObject(item)])) : value;
const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function fail(operation, code, stage, message, { active = null, sideEffects = 'none', retryMode = 'none' } = {}, now = new Date()) {
  const data = active ? {
    operationId: active.operationId,
    rooms: active.plan.rooms.map((room) => room.slug),
    outcome: sideEffects === 'none' ? 'not_sent' : 'unknown',
    dispatch: sideEffects === 'none' ? 'not_attempted' : 'unknown',
    observation: active.lastObservation ?? null,
    appliedSettings: active.appliedSettings ?? {},
  } : null;
  return validateResult({
    schemaVersion: '1', status: 'failure', domain: DEVICE, operation, verified: false,
    data, warnings: [], error: { code, stage, retryable: retryMode !== 'none', retryMode, sideEffects, message },
    pendingContext: null,
  }, null, now);
}

function actionSuccess(active, outcome, observation, now) {
  return validateResult({
    schemaVersion: '1', status: 'success', domain: DEVICE, operation: active.plan.operation, verified: true,
    data: {
      operationId: active.operationId,
      rooms: active.plan.rooms.map((room) => room.slug),
      outcome, dispatch: 'accepted', observation,
      appliedSettings: { ...active.appliedSettings,
        ...(active.suctionAlreadySet ? { suction: active.plan.settings.suction } : {}) },
    },
    warnings: [], error: null, pendingContext: null,
  }, active.plan, now);
}

function observation(evidence, now) {
  const status = evidence?.status;
  if (!status || !validTime(status.observedAt) || !validTime(status.sourceUpdatedAt) ||
      typeof status.state !== 'string' || !status.state ||
      now.getTime() - Date.parse(status.observedAt) < 0 ||
      now.getTime() - Date.parse(status.observedAt) > 60_000 ||
      Date.parse(status.sourceUpdatedAt) > Date.parse(status.observedAt) ||
      (status.activeSegments !== null && (!Array.isArray(status.activeSegments) ||
        !status.activeSegments.every((id) => Number.isSafeInteger(id) && id > 0))) ||
      (status.currentSegment !== null && (!Number.isSafeInteger(status.currentSegment) || status.currentSegment < 1))) {
    throw new DomainError('STATE_UNVERIFIED', 'precondition', 'Fresh vacuum state is unavailable');
  }
  return {
    observedAt: status.observedAt, sourceUpdatedAt: status.sourceUpdatedAt,
    state: status.state, activeSegments: status.activeSegments,
    currentSegment: status.currentSegment,
  };
}

function freshSignal(signal, now, maxAgeMs = 30_000) {
  return signal && validTime(signal.sourceUpdatedAt) && validTime(signal.observedAt) &&
    Date.parse(signal.sourceUpdatedAt) <= Date.parse(signal.observedAt) &&
    now.getTime() >= Date.parse(signal.observedAt) &&
    now.getTime() - Date.parse(signal.observedAt) <= 60_000 &&
    now.getTime() >= Date.parse(signal.sourceUpdatedAt) &&
    now.getTime() - Date.parse(signal.sourceUpdatedAt) <= maxAgeMs;
}

function freshPositiveProgress(evidence, task, now) {
  if (!validTime(task?.sourceUpdatedAt)) return null;
  for (const [name, signal] of [['area', evidence.currentArea], ['time', evidence.currentTime]]) {
    if (freshSignal(signal, now) && signal.value > 0 &&
        Date.parse(signal.sourceUpdatedAt) > Date.parse(task.sourceUpdatedAt)) {
      return { name, ...structuredClone(signal) };
    }
  }
  return null;
}

function freshDeviceRead(value, now, maxAgeMs = 90_000) {
  return validTime(value) && Date.parse(value) <= now.getTime() &&
    now.getTime() - Date.parse(value) <= maxAgeMs;
}

function sameIds(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    [...actual].sort((a, b) => a - b).join(',') === [...expected].sort((a, b) => a - b).join(',');
}

function homeGeometryMatches(plan, evidence, now, registry) {
  const geometry = evidence.homeGeometry;
  if (!geometry || geometry.sha256 !== plan.homeGeometrySha256 ||
      geometry.mapId !== registry.mapBinding.mapId ||
      !freshDeviceRead(geometry.deviceMapListReadAt, now) ||
      !validTime(geometry.savedMapLoadedAt) || Date.parse(geometry.savedMapLoadedAt) > now.getTime()) return false;
  const visible = registry.rooms.filter((room) => room.enabled).map((room) => room.segmentId);
  const hidden = registry.rooms.filter((room) => !room.enabled).map((room) => room.segmentId);
  return sameIds(geometry.visibleSegmentIds, visible) &&
    Array.isArray(geometry.hiddenSegmentIds) && geometry.hiddenSegmentIds.length === 4 &&
    hidden.every((id) => geometry.hiddenSegmentIds.includes(id)) &&
    geometry.noGoCount === 1 && geometry.noMopCount === 0 && geometry.virtualWallCount === 5;
}

function requireHomeBefore(plan, evidence, now, registry) {
  if (!homeGeometryMatches(plan, evidence, now, registry)) {
    throw new DomainError('MAP_CHANGED', 'precondition', 'Reviewed home geometry or exclusions are unavailable');
  }
  if (evidence.taskDevice?.value !== 0 || !freshDeviceRead(evidence.taskDevice.sourceReadAt, now) ||
      evidence.taskStatus?.state !== 'completed' ||
      !['idle', 'docked'].includes(evidence.status?.state) ||
      !(evidence.status?.activeSegments === null ||
        Array.isArray(evidence.status?.activeSegments) && evidence.status.activeSegments.length === 0)) {
    throw new DomainError('STATE_UNVERIFIED', 'precondition', 'A fresh idle home-task baseline is unavailable');
  }
}

function preconditions(plan, evidence, now, registry) {
  const before = observation(evidence, now);
  let progress = null;
  if (['unavailable', 'unknown'].includes(before.state) || evidence.error) {
    throw new DomainError('STATE_UNVERIFIED', 'precondition', 'Vacuum state or error is not suitable for control');
  }
  if (plan.operation === 'clean') {
    if (plan.targetKind === 'home') requireHomeBefore(plan, evidence, now, registry);
    const noSegments = Array.isArray(before.activeSegments) && before.activeSegments.length === 0;
    const roomSignalIdle = plan.roomTaskSignal && before.activeSegments === null &&
      evidence.taskStatus?.state === 'completed' && validTime(evidence.taskStatus.sourceUpdatedAt) &&
      Date.parse(evidence.taskStatus.sourceUpdatedAt) <= Date.parse(before.observedAt);
    if (!['idle', 'docked'].includes(before.state) || (plan.targetKind !== 'home' && !(noSegments || roomSignalIdle)) ||
        (plan.roomTaskSignal && evidence.taskStatus?.state !== 'completed')) {
      throw new DomainError('CONFLICT_ACTIVE_TASK', 'precondition', 'Vacuum already has an active task');
    }
  } else if (['resume', 'stop'].includes(plan.operation)) {
    throw new DomainError('VERIFICATION_UNAVAILABLE', 'precondition', 'Reliable task correlation or stop verification is unavailable');
  } else if (['pause', 'dock'].includes(plan.operation)) {
    const task = evidence.taskStatus;
    progress = freshPositiveProgress(evidence, task, now);
    const expectedSegments = plan.rooms.map((room) => room.segmentId);
    const activeMatches = Array.isArray(before.activeSegments) &&
      before.activeSegments.length === expectedSegments.length &&
      expectedSegments.every((segment) => before.activeSegments.includes(segment));
    if (before.state !== 'cleaning' || !activeMatches ||
        task?.state !== 'room_cleaning' || !freshSignal(task, now, 600_000) || !progress) {
      throw new DomainError('STATE_UNVERIFIED', 'precondition', 'Fresh active room cleaning is not proved');
    }
    if (plan.operation === 'dock' && (!freshSignal(evidence.chargingStatus, now, 600_000) ||
        evidence.chargingStatus.value !== 'not_charging')) {
      throw new DomainError('STATE_UNVERIFIED', 'precondition', 'Robot is not independently proved away from the charger');
    }
  }
  if (plan.settings) {
    for (const [name, value] of Object.entries(plan.settings)) {
      const source = evidence.settingSources?.[name];
      if (!validTime(source?.observedAt) || !validTime(source?.sourceUpdatedAt) ||
          Date.parse(source.sourceUpdatedAt) > Date.parse(source.observedAt) ||
          now.getTime() - Date.parse(source.observedAt) < 0 ||
          now.getTime() - Date.parse(source.observedAt) > 60_000 ||
          evidence.settings?.[name] === undefined) {
        throw new DomainError('SETTING_UNVERIFIED', 'precondition', 'Fresh setting read-back is unavailable');
      }
      if (evidence.settings[name] === value && (name !== 'suction' || plan.underTestId)) {
        throw new DomainError('SETTING_UNCHANGED', 'precondition', 'Requested setting already has this value');
      }
      if (name === 'suction' && evidence.deviceSuction !== evidence.settings[name]) {
        throw new DomainError('SETTING_UNVERIFIED', 'precondition', 'Device and selector suction disagree');
      }
    }
  }
  return { ...before, taskId: evidence.taskId ?? null, taskScope: evidence.taskScope ?? null,
    taskStatus: plan.roomTaskSignal ? structuredClone(evidence.taskStatus) : null,
    ...(plan.targetKind === 'home' ? { taskDevice: structuredClone(evidence.taskDevice),
      homeGeometry: structuredClone(evidence.homeGeometry) } : {}),
    progress: ['pause', 'dock'].includes(plan.operation) ? progress : null,
    chargingStatus: plan.operation === 'dock' ? structuredClone(evidence.chargingStatus) : null,
    settings: structuredClone(evidence.settings ?? {}),
    settingSources: structuredClone(evidence.settingSources ?? null) };
}

function stepsFor(active) {
  const plan = active.plan;
  const settings = plan.settings ?? {};
  return [
    ...['suction', 'mode', 'wetness'].filter((name) => Object.hasOwn(settings, name))
      .filter((name) => name !== 'suction' || !active.suctionAlreadySet)
      .map((name) => ({ kind: 'setting', name, value: settings[name] })),
    { kind: 'command', operation: plan.operation, targetKind: plan.targetKind,
      segments: plan.rooms.map((room) => room.segmentId), workflowId: plan.workflowId },
  ];
}

function changedSince(before, after) {
  return validTime(after.sourceUpdatedAt) && Date.parse(after.sourceUpdatedAt) > Date.parse(before.sourceUpdatedAt);
}

function verifyStep(active, step, evidence, now, registry) {
  let after;
  try { after = observation(evidence, now); }
  catch { return { kind: 'pending' }; }
  if (step.kind === 'setting') {
    const beforeSource = active.before.settingSources?.[step.name];
    const afterSource = evidence.settingSources?.[step.name];
    if (!validTime(beforeSource?.sourceUpdatedAt) || !validTime(afterSource?.sourceUpdatedAt) ||
        !validTime(afterSource?.observedAt) ||
        Date.parse(afterSource.sourceUpdatedAt) <= Date.parse(beforeSource.sourceUpdatedAt) ||
        Date.parse(afterSource.sourceUpdatedAt) < Date.parse(active.dispatchStartedAt) ||
        Date.parse(afterSource.sourceUpdatedAt) > Date.parse(afterSource.observedAt) ||
        now.getTime() - Date.parse(afterSource.observedAt) < 0 ||
        now.getTime() - Date.parse(afterSource.observedAt) > 60_000) {
      return { kind: 'pending', observation: after };
    }
    if (evidence.settings?.[step.name] !== step.value) return { kind: 'mismatch', observation: after };
    return { kind: 'verified', observation: after, outcome: null,
      settings: structuredClone(evidence.settings), settingSources: structuredClone(evidence.settingSources) };
  }
  if (!changedSince(active.before, after)) return { kind: 'pending', observation: after };
  if (step.operation === 'clean') {
    if (after.state !== 'cleaning') return { kind: 'pending', observation: after };
    if (step.targetKind === 'home') {
      const geometry = evidence.homeGeometry;
      const device = evidence.taskDevice;
      if (geometry?.sha256 !== active.plan.homeGeometrySha256 ||
          Array.isArray(after.activeSegments) && after.activeSegments.length > 0) {
        return { kind: 'mismatch', observation: after };
      }
      try { assertFreshMap(registry, evidence.map, now); }
      catch { return { kind: 'mismatch', observation: after }; }
      if (!homeGeometryMatches(active.plan, evidence, now, registry) ||
          Date.parse(geometry.deviceMapListReadAt) < Date.parse(active.dispatchStartedAt) ||
          !freshDeviceRead(device?.sourceReadAt, now) ||
          Date.parse(device.sourceReadAt) <= Date.parse(active.before.taskDevice.sourceReadAt) ||
          Date.parse(device.sourceReadAt) < Date.parse(active.dispatchStartedAt)) {
        return { kind: 'pending', observation: after };
      }
      if (device.value !== 1) return device.value === 0 ?
        { kind: 'pending', observation: after } : { kind: 'mismatch', observation: after };
      return { kind: 'verified', observation: { ...after, homeTask: {
        value: 1, sourceReadAt: device.sourceReadAt,
        geometrySha256: geometry.sha256, mapListReadAt: geometry.deviceMapListReadAt,
      } }, outcome: 'started' };
    }
    if (active.plan.roomTaskSignal) {
      const task = evidence.taskStatus;
      if (task?.state !== 'room_cleaning' || !validTime(task.sourceUpdatedAt) ||
          Date.parse(task.sourceUpdatedAt) <= Date.parse(active.before.taskStatus.sourceUpdatedAt) ||
          Date.parse(task.sourceUpdatedAt) < Date.parse(active.dispatchStartedAt)) {
        return { kind: 'pending', observation: after };
      }
    } else if (!evidence.taskId || evidence.taskId === active.before.taskId) {
      return { kind: 'pending', observation: after };
    }
    if (!Array.isArray(after.activeSegments)) return { kind: 'pending', observation: after };
    const actual = [...after.activeSegments].sort((a, b) => a - b).join(',');
    const expected = [...step.segments].sort((a, b) => a - b).join(',');
    if (active.plan.settings?.suction && (evidence.deviceSuction !== active.plan.settings.suction ||
        evidence.settings?.suction !== active.plan.settings.suction)) {
      return { kind: 'pending', observation: after };
    }
    return actual === expected ? { kind: 'verified',
      observation: active.plan.roomTaskSignal ? { ...after, taskStatus: {
        state: evidence.taskStatus.state, sourceUpdatedAt: evidence.taskStatus.sourceUpdatedAt,
      } } : after,
      outcome: 'started' } :
      { kind: 'mismatch', observation: after };
  }
  if (step.operation === 'pause') {
    const task = evidence.taskStatus;
    return after.state === 'paused' && task?.state === 'room_cleaning_paused' &&
      freshSignal(task, now, 60_000) &&
      Date.parse(task.sourceUpdatedAt) > Date.parse(active.before.taskStatus.sourceUpdatedAt) &&
      Date.parse(task.sourceUpdatedAt) >= Date.parse(active.dispatchStartedAt) &&
      JSON.stringify(after.activeSegments) === JSON.stringify(active.before.activeSegments) ?
      { kind: 'verified', observation: { ...after, taskStatus: {
        state: task.state, sourceUpdatedAt: task.sourceUpdatedAt,
      } }, outcome: 'paused' } :
      { kind: 'pending', observation: after };
  }
  if (['resume', 'stop'].includes(step.operation)) return { kind: 'pending', observation: after };
  if (step.operation === 'dock') {
    const charging = evidence.chargingStatus;
    return after.state === 'docked' && ['charging', 'charging_completed'].includes(charging?.value) &&
      freshSignal(charging, now, 60_000) &&
      Date.parse(charging.sourceUpdatedAt) > Date.parse(active.before.chargingStatus.sourceUpdatedAt) &&
      Date.parse(charging.sourceUpdatedAt) >= Date.parse(active.dispatchStartedAt) ?
      { kind: 'verified', observation: { ...after, chargingStatus: {
        value: charging.value, sourceUpdatedAt: charging.sourceUpdatedAt,
      } }, outcome: 'docked' } :
      { kind: 'pending', observation: after };
  }
  return { kind: 'pending', observation: after };
}

export function createJessicaExecutor({ registryConfig, policyConfig, store, driver,
  clock = () => new Date(), wait = waitDefault, pollCounts = {} , hooks = {} }) {
  if (!driver || typeof driver.read !== 'function' || typeof driver.dispatch !== 'function') {
    throw new Error('Stage 4 requires an injected HA driver');
  }
  const core = createDomainCore(registryConfig, policyConfig);
  const registry = loadRegistry(registryConfig);
  const policy = loadPolicy(policyConfig);
  const state = createOperationState(store);
  const current = () => clock();

  function identityAndKey(rawRequest, context) {
    const request = parseExecuteRequest(rawRequest);
    const auth = authorize(policy, context?.identity, 'control');
    const epoch = context?.requestEpoch;
    if (typeof epoch !== 'string' || !epoch || epoch.length > 160) {
      throw new DomainError('EPOCH_UNTRUSTED', 'identity', 'Trusted external request epoch is unavailable');
    }
    const key = digest([DEVICE, auth.subject, epoch]);
    return { request, key, requestHash: digest(sortObject(request)) };
  }

  function pending(active, code = 'OPERATION_PENDING') {
    return fail(active.plan.operation, code, 'verification', 'Operation needs read-only reconciliation',
      { active, sideEffects: active.appliedSettings && Object.keys(active.appliedSettings).length ? 'observed' : 'possible',
        retryMode: 'reconcile' }, current());
  }

  async function poll(active, step) {
    const count = pollCounts[step.kind === 'setting' ? 'setting' : active.plan.operation] ??
      Math.ceil((step.kind === 'setting' ? 15_000 : TIMEOUT_MS[active.plan.operation]) / POLL_MS);
    for (let index = 0; index < count; index++) {
      try {
        const evidence = await driver.read();
        const verdict = verifyStep(active, step, evidence, current(), registry);
        if (verdict.kind !== 'pending') return verdict;
      } catch { /* GET may be retried within the bounded read budget. */ }
      if (index + 1 < count) await wait(POLL_MS);
    }
    return { kind: 'pending' };
  }

  async function advance(active) {
    const key = active.requestKey;
    const steps = stepsFor(active);
    while (active.stepIndex < steps.length) {
      const step = steps[active.stepIndex];
      // Recheck current state before the irreversible marker. A failed read
      // leaves the prepared intent durable and sends no POST.
      let evidence;
      try {
        evidence = await driver.read();
        observation(evidence, current());
        if (active.plan.mapFingerprint) assertFreshMap(registry, evidence.map, current());
        if (active.plan.targetKind === 'home') requireHomeBefore(active.plan, evidence, current(), registry);
      } catch (error) {
        if (error instanceof DomainError && ['MAP_CHANGED', 'MAP_STALE', 'ROOM_MAP_MISMATCH', 'WORKFLOW_CHANGED'].includes(error.code)) {
          const result = fail(active.plan.operation, error.code, error.stage, error.message, { active }, current());
          return state.finish(key, active.requestHash, active.planHash, result);
        }
        return fail(active.plan.operation, 'READ_UNAVAILABLE', 'precondition', 'Fresh pre-dispatch state is unavailable',
          { active, retryMode: 'read_only' }, current());
      }
      if (evidence.status.state !== active.before.state ||
          evidence.status.sourceUpdatedAt !== active.before.sourceUpdatedAt ||
          (evidence.taskId ?? null) !== active.before.taskId || evidence.error ||
          JSON.stringify(evidence.status.activeSegments) !== JSON.stringify(active.before.activeSegments) ||
          evidence.status.currentSegment !== active.before.currentSegment ||
          (active.plan.settings && Object.keys(active.plan.settings).some((name) =>
            evidence.settings?.[name] !== active.before.settings?.[name] ||
            evidence.settingSources?.[name]?.sourceUpdatedAt !== active.before.settingSources?.[name]?.sourceUpdatedAt)) ||
          (active.plan.roomTaskSignal && (evidence.taskStatus?.state !== active.before.taskStatus?.state ||
            evidence.taskStatus?.sourceUpdatedAt !== active.before.taskStatus?.sourceUpdatedAt)) ||
          (['pause', 'dock'].includes(active.plan.operation) &&
            (evidence[active.before.progress?.name === 'area' ? 'currentArea' : 'currentTime']?.value !== active.before.progress?.value ||
             evidence[active.before.progress?.name === 'area' ? 'currentArea' : 'currentTime']?.sourceUpdatedAt !== active.before.progress?.sourceUpdatedAt)) ||
          (active.plan.operation === 'dock' &&
            (evidence.chargingStatus?.value !== active.before.chargingStatus?.value ||
             evidence.chargingStatus?.sourceUpdatedAt !== active.before.chargingStatus?.sourceUpdatedAt))) {
        const result = fail(active.plan.operation, 'PRECONDITION_CHANGED', 'precondition', 'Vacuum changed before dispatch',
          { active }, current());
        return state.finish(key, active.requestHash, active.planHash, result);
      }
      if (active.plan.underTestId && (registry.underTest?.id !== active.plan.underTestId ||
          current().getTime() >= Date.parse(registry.underTest.expiresAt))) {
        const sideEffects = Object.keys(active.appliedSettings ?? {}).length ? 'observed' : 'none';
        const result = fail(active.plan.operation, 'CANARY_SCOPE_EXPIRED', 'precondition',
          'Under-test scope expired before dispatch', { active, sideEffects }, current());
        return state.finish(key, active.requestHash, active.planHash, result);
      }
      if (active.plan.underTestId && !state.claimUnderTest(active.plan.underTestId, key,
        active.operationId, current())) {
        const result = fail(active.plan.operation, 'CANARY_ALREADY_USED', 'precondition', 'Under-test dispatch has already been claimed',
          { active }, current());
        return state.finish(key, active.requestHash, active.planHash, result);
      }
      const claimed = state.transition(key, ['prepared'], (value) =>
        value.stepIndex === active.stepIndex ? { ...value, phase: 'dispatching',
          dispatchStartedAt: current().toISOString() } : undefined);
      if (!claimed.changed) return pending(state.active() ?? active);
      active = claimed.active;
      hooks.afterDispatchMarker?.(structuredClone(active));
      let accepted = false;
      try { accepted = (await driver.dispatch(step))?.accepted === true; }
      catch { /* A broken connection after POST cannot prove no side effect. */ }
      hooks.afterPost?.(structuredClone(active));
      const moved = state.transition(key, ['dispatching'], (value) =>
        value.stepIndex === active.stepIndex ? { ...value, phase: 'verifying',
          dispatch: accepted ? 'accepted' : 'unknown' } : undefined);
      if (!moved.changed) return pending(state.active() ?? active);
      active = moved.active;
      hooks.afterAcceptedState?.(structuredClone(active));
      const verdict = await poll(active, step);
      if (verdict.kind === 'mismatch' || verdict.kind === 'pending') {
        const code = verdict.kind === 'mismatch' ? 'TARGET_MISMATCH' : 'VERIFICATION_TIMEOUT';
        const updated = state.transition(key, ['verifying'], (value) => ({ ...value, phase: 'uncertain',
          lastObservation: verdict.observation ?? null }));
        return pending(updated.active ?? active, code);
      }
      if (active.dispatch !== 'accepted') {
        const updated = state.transition(key, ['verifying'], (value) => ({ ...value, phase: 'uncertain',
          lastObservation: verdict.observation,
          appliedSettings: step.kind === 'setting' ? { ...value.appliedSettings, [step.name]: step.value } : value.appliedSettings }));
        return pending(updated.active ?? active, 'DISPATCH_UNCERTAIN');
      }
      if (step.kind === 'setting') {
        const updated = state.transition(key, ['verifying'], (value) => ({ ...value,
          phase: 'prepared', stepIndex: value.stepIndex + 1,
          before: { ...verdict.observation, taskId: evidence.taskId ?? null, taskScope: evidence.taskScope ?? null,
            taskStatus: active.plan.roomTaskSignal ? structuredClone(evidence.taskStatus) : null,
            settings: verdict.settings, settingSources: verdict.settingSources },
          appliedSettings: { ...value.appliedSettings, [step.name]: step.value },
        }));
        if (!updated.changed) return pending(state.active() ?? active);
        active = updated.active;
        continue;
      }
      let result;
      try { result = actionSuccess(active, verdict.outcome, verdict.observation, current()); }
      catch {
        const updated = state.transition(key, ['verifying'], (value) => ({ ...value, phase: 'uncertain',
          lastObservation: verdict.observation }));
        return pending(updated.active ?? active, 'INTEGRITY_UNVERIFIED');
      }
      return state.finish(key, active.requestHash, active.planHash, result);
    }
    throw new Error('Jessica execution plan has no command step');
  }

  async function execute(rawRequest, context) {
    let operation = EXECUTE_OPERATIONS.includes(rawRequest?.operation) ? rawRequest.operation : null;
    let key;
    try {
      const derived = identityAndKey(rawRequest, context);
      const { request, requestHash } = derived;
      key = derived.key;
      operation = request.operation;
      const prior = state.history(key);
      if (prior) return prior.requestHash === requestHash ? prior.result :
        fail(operation, 'EPOCH_CONFLICT', 'precondition', 'Request epoch belongs to a different operation', {}, current());
      let existing = state.active();
      if (existing?.requestKey === key && existing.requestHash !== requestHash) {
        return fail(operation, 'EPOCH_CONFLICT', 'precondition', 'Request epoch belongs to a different operation', {}, current());
      }
      if (existing?.requestKey === key && existing.phase === 'terminal') {
        return state.finish(key, requestHash, existing.planHash, existing.result);
      }
      if (existing?.requestKey === key && existing.phase !== 'prepared') return pending(existing);
      if (existing && existing.requestKey !== key) {
        return fail(operation, 'CONFLICT_UNRESOLVED', 'precondition', 'Another Jessica operation is unresolved', {}, current());
      }
      const evidence = await driver.read();
      const plan = core.prepareExecute(request, context.identity, evidence, current());
      const before = preconditions(plan, evidence, current(), registry);
      const planHash = digest(sortObject(plan));
      if (existing && existing.planHash !== planHash) {
        return fail(operation, 'PRECONDITION_CHANGED', 'precondition', 'Prepared operation no longer matches current evidence',
          { active: existing }, current());
      }
      if (!existing) {
        const intent = { version: '1', requestKey: key, requestHash, planHash,
          operationId: `j4-${digest([key, requestHash]).slice(0,32)}`, plan, phase: 'prepared', stepIndex: 0,
          before, suctionAlreadySet: plan.settings?.suction !== undefined &&
            before.settings.suction === plan.settings.suction,
          appliedSettings: {}, lastObservation: null, createdAt: current().toISOString() };
        const reservation = state.reserve(intent);
        if (reservation.kind === 'conflict') {
          return fail(operation, 'CONFLICT_UNRESOLVED', 'precondition', 'Another Jessica operation is unresolved', {}, current());
        }
        existing = reservation.active;
        if (existing.requestHash !== requestHash || existing.planHash !== planHash) {
          return fail(operation, 'EPOCH_CONFLICT', 'precondition', 'Request epoch belongs to a different operation', {}, current());
        }
        const raced = state.history(key);
        if (raced) {
          state.transition(key, ['prepared'], () => null);
          return raced.requestHash === requestHash ? raced.result :
            fail(operation, 'EPOCH_CONFLICT', 'precondition', 'Request epoch belongs to a different operation', {}, current());
        }
      }
      hooks.afterIntent?.(structuredClone(existing));
      return await advance(existing);
    } catch (error) {
      const active = key ? state.active() : null;
      if (active && active.requestKey === key && active.phase !== 'prepared') return pending(active, 'EXECUTION_UNCERTAIN');
      const known = error instanceof DomainError;
      return fail(operation, known ? error.code : 'EXECUTION_UNAVAILABLE', known ? error.stage : 'verification',
        known ? error.message : 'Jessica execution is unavailable',
        active && active.requestKey === key ? { active, retryMode: 'read_only' } : {}, current());
    }
  }

  async function reconcile(rawRequest, context) {
    let operation = EXECUTE_OPERATIONS.includes(rawRequest?.operation) ? rawRequest.operation : null;
    try {
      const { request, key, requestHash } = identityAndKey(rawRequest, context);
      operation = request.operation;
      const prior = state.history(key);
      if (prior) return prior.requestHash === requestHash ? prior.result :
        fail(operation, 'EPOCH_CONFLICT', 'precondition', 'Request epoch belongs to a different operation', {}, current());
      const active = state.active();
      if (!active || active.requestKey !== key || active.requestHash !== requestHash) {
        return fail(operation, 'OPERATION_NOT_FOUND', 'precondition', 'No matching Jessica intent exists', {}, current());
      }
      if (active.phase === 'terminal') return state.finish(key, requestHash, active.planHash, active.result);
      if (active.phase === 'prepared') return fail(operation, 'NOT_DISPATCHED', 'verification',
        'Intent exists but dispatch was not marked', { active, retryMode: 'read_only' }, current());
      const step = stepsFor(active)[active.stepIndex];
      let verdict;
      try { verdict = verifyStep(active, step, await driver.read(), current(), registry); }
      catch { verdict = { kind: 'pending' }; }
      if (verdict.kind !== 'verified') {
        const updated = state.transition(key, ['dispatching', 'verifying', 'uncertain'],
          (value) => ({ ...value, phase: 'uncertain', lastObservation: verdict.observation ?? value.lastObservation }));
        return pending(updated.active ?? active, verdict.kind === 'mismatch' ? 'TARGET_MISMATCH' : 'RECONCILIATION_UNRESOLVED');
      }
      if (step.kind === 'setting') {
        const partial = { ...active, appliedSettings: { ...active.appliedSettings, [step.name]: step.value },
          lastObservation: verdict.observation };
        const updated = state.transition(key, ['dispatching', 'verifying', 'uncertain'], () => partial);
        if (!updated.changed) return pending(state.active() ?? active);
        const result = fail(operation, 'PARTIAL_SETTING_APPLIED', 'verification',
          'A setting changed; the cleaning command was not sent',
          { active: partial, sideEffects: 'observed' }, current());
        return state.finish(key, requestHash, active.planHash, result);
      }
      if (active.dispatch !== 'accepted') {
        const updated = state.transition(key, ['dispatching', 'verifying', 'uncertain'],
          (value) => ({ ...value, phase: 'uncertain', lastObservation: verdict.observation }));
        return pending(updated.active ?? active, 'DISPATCH_UNCERTAIN');
      }
      let result;
      try { result = actionSuccess(active, verdict.outcome, verdict.observation, current()); }
      catch { return pending(active, 'INTEGRITY_UNVERIFIED'); }
      return state.finish(key, requestHash, active.planHash, result);
    } catch (error) {
      const known = error instanceof DomainError;
      return fail(operation, known ? error.code : 'RECONCILIATION_UNAVAILABLE',
        known ? error.stage : 'verification', known ? error.message : 'Jessica reconciliation is unavailable',
        {}, current());
    }
  }

  return Object.freeze({ execute, reconcile, state });
}

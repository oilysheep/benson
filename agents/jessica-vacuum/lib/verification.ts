import { DomainError, deny } from './errors.js';
import { assertFreshMap, type Registry } from './registry.js';
import type { ExecutePlan, Settings } from './schemas.js';
import type { Observation } from './results.js';
import type { Active } from './operation-state.js';
import type { DeviceSnapshot, DeviceStep } from './ports.js';

type FreshObservation = Observation & { sourceUpdatedAt: string };
export type Verdict = { kind: 'pending' | 'mismatch'; observation?: FreshObservation } |
  { kind: 'verified'; observation: FreshObservation; outcome: 'started' | 'paused' | 'docked' | null;
    settings: Settings; settingSources: DeviceSnapshot['settingSources'] };
const time = (value: string | null | undefined): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const freshRead = (value: string | undefined, now: Date, age = 90_000): value is string => time(value) &&
  Date.parse(value) <= now.getTime() && now.getTime() - Date.parse(value) <= age;
function freshSignal(value: { observedAt: string; sourceUpdatedAt: string } | null | undefined, now: Date, age = 30_000): boolean {
  return value !== null && value !== undefined && time(value.sourceUpdatedAt) && time(value.observedAt) &&
    Date.parse(value.sourceUpdatedAt) <= Date.parse(value.observedAt) && freshRead(value.observedAt, now, 60_000) && freshRead(value.sourceUpdatedAt, now, age);
}
export function observation(evidence: DeviceSnapshot, now: Date): FreshObservation {
  const status = evidence.status;
  if (!time(status.sourceUpdatedAt) || !freshRead(status.observedAt, now, 60_000) ||
    Date.parse(status.sourceUpdatedAt) > Date.parse(status.observedAt) || !status.state ||
    status.activeSegments !== null && !status.activeSegments.every(id => Number.isSafeInteger(id) && id > 0) ||
    status.currentSegment !== null && (!Number.isSafeInteger(status.currentSegment) || status.currentSegment < 1)) {
    deny('STATE_UNVERIFIED', 'precondition', 'Fresh vacuum state is unavailable');
  }
  return { observedAt: status.observedAt, sourceUpdatedAt: status.sourceUpdatedAt, state: status.state,
    activeSegments: status.activeSegments, currentSegment: status.currentSegment };
}
const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length &&
  [...a].sort((x, y) => x - y).join(',') === [...b].sort((x, y) => x - y).join(',');
function homeGeometryMatches(plan: ExecutePlan, evidence: DeviceSnapshot, now: Date, registry: Registry): boolean {
  const g = evidence.homeGeometry;
  return !!g && g.sha256 === plan.homeGeometrySha256 && g.mapId === registry.mapBinding.mapId &&
    freshRead(g.deviceMapListReadAt, now) && time(g.savedMapLoadedAt) && Date.parse(g.savedMapLoadedAt) <= now.getTime() &&
    sameIds(g.visibleSegmentIds, registry.rooms.filter(room => room.enabled).map(room => room.segmentId)) &&
    g.hiddenSegmentIds.length === 4 && registry.rooms.filter(room => !room.enabled).every(room => g.hiddenSegmentIds.includes(room.segmentId)) &&
    g.noGoCount === 1 && g.noMopCount === 0 && g.virtualWallCount === 5;
}
export function requireHomeBefore(plan: ExecutePlan, evidence: DeviceSnapshot, now: Date, registry: Registry): void {
  if (!homeGeometryMatches(plan, evidence, now, registry)) deny('MAP_CHANGED', 'precondition', 'Reviewed home geometry or exclusions are unavailable');
  if (evidence.taskDevice?.value !== 0 || !freshRead(evidence.taskDevice.sourceReadAt, now) || evidence.taskStatus?.state !== 'completed' ||
    !['idle', 'docked'].includes(evidence.status.state) || evidence.status.activeSegments !== null && evidence.status.activeSegments.length !== 0) {
    deny('STATE_UNVERIFIED', 'precondition', 'A fresh idle home-task baseline is unavailable');
  }
}
export function preconditions(plan: ExecutePlan, evidence: DeviceSnapshot, now: Date, registry: Registry): Active['before'] {
  const before = observation(evidence, now);
  let progress: Active['before']['progress'] = null;
  if (['unavailable', 'unknown'].includes(before.state) || evidence.error) deny('STATE_UNVERIFIED', 'precondition', 'Vacuum state or error is not suitable for control');
  switch (plan.operation) {
    case 'clean': {
      if (plan.targetKind === 'home') requireHomeBefore(plan, evidence, now, registry);
      const idle = before.activeSegments?.length === 0 || plan.roomTaskSignal && before.activeSegments === null &&
        evidence.taskStatus?.state === 'completed' && time(evidence.taskStatus.sourceUpdatedAt) && Date.parse(evidence.taskStatus.sourceUpdatedAt) <= Date.parse(before.observedAt);
      if (!['idle', 'docked'].includes(before.state) || plan.targetKind !== 'home' && !idle || plan.roomTaskSignal && evidence.taskStatus?.state !== 'completed') deny('CONFLICT_ACTIVE_TASK', 'precondition', 'Vacuum already has an active task');
      break;
    }
    case 'resume': case 'stop': deny('VERIFICATION_UNAVAILABLE', 'precondition', 'Reliable task correlation or stop verification is unavailable');
    case 'pause': case 'dock': {
      const task = evidence.taskStatus;
      for (const name of ['area', 'time'] as const) {
        const signal = name === 'area' ? evidence.currentArea : evidence.currentTime;
        if (signal && task && freshSignal(signal, now) && signal.value > 0 && Date.parse(signal.sourceUpdatedAt) > Date.parse(task.sourceUpdatedAt)) {
          progress = { name, ...signal }; break;
        }
      }
      if (before.state !== 'cleaning' || !before.activeSegments || !sameIds(before.activeSegments, plan.rooms.map(room => room.segmentId)) ||
        task?.state !== 'room_cleaning' || !freshSignal(task, now, 600_000) || !progress) deny('STATE_UNVERIFIED', 'precondition', 'Fresh active room cleaning is not proved');
      if (plan.operation === 'dock' && (!freshSignal(evidence.chargingStatus, now, 600_000) || evidence.chargingStatus?.value !== 'not_charging')) deny('STATE_UNVERIFIED', 'precondition', 'Robot is not independently proved away from the charger');
      break;
    }
  }
  for (const name of ['suction', 'mode', 'wetness'] as const) {
    const value = plan.settings?.[name];
    if (value === undefined) continue;
    const source = evidence.settingSources?.[name];
    if (!source || !time(source.sourceUpdatedAt) || !freshRead(source.observedAt, now, 60_000) ||
      Date.parse(source.sourceUpdatedAt) > Date.parse(source.observedAt) || evidence.settings?.[name] === undefined) deny('SETTING_UNVERIFIED', 'precondition', 'Fresh setting read-back is unavailable');
    if (evidence.settings?.[name] === value && (name !== 'suction' || plan.underTestId)) deny('SETTING_UNCHANGED', 'precondition', 'Requested setting already has this value');
    if (name === 'suction' && evidence.deviceSuction !== evidence.settings?.suction) deny('SETTING_UNVERIFIED', 'precondition', 'Device and selector suction disagree');
  }
  return { ...before, taskId: evidence.taskId ?? null, taskScope: evidence.taskScope ?? null,
    taskStatus: plan.roomTaskSignal ? evidence.taskStatus ?? null : null, progress,
    chargingStatus: plan.operation === 'dock' ? evidence.chargingStatus ?? null : null,
    settings: evidence.settings ?? {}, settingSources: evidence.settingSources ?? null,
    ...(plan.targetKind === 'home' ? { taskDevice: evidence.taskDevice ?? null, homeGeometry: evidence.homeGeometry ?? null } : {}) };
}
export function stepsFor(active: Active): DeviceStep[] {
  const { plan } = active;
  const steps: DeviceStep[] = [];
  if (plan.settings?.suction !== undefined && !active.suctionAlreadySet) steps.push({ kind: 'setting', name: 'suction', value: plan.settings.suction });
  if (plan.settings?.mode !== undefined) steps.push({ kind: 'setting', name: 'mode', value: plan.settings.mode });
  if (plan.settings?.wetness !== undefined) steps.push({ kind: 'setting', name: 'wetness', value: plan.settings.wetness });
  steps.push({ kind: 'command', operation: plan.operation, targetKind: plan.targetKind, segments: plan.rooms.map(room => room.segmentId), workflowId: null });
  return steps;
}
export function baselineMatches(active: Active, evidence: DeviceSnapshot): boolean {
  const before = active.before, status = evidence.status;
  const progress = before.progress?.name === 'area' ? evidence.currentArea : evidence.currentTime;
  return status.state === before.state && status.sourceUpdatedAt === before.sourceUpdatedAt && !evidence.error &&
    (evidence.taskId ?? null) === before.taskId && JSON.stringify(status.activeSegments) === JSON.stringify(before.activeSegments) && status.currentSegment === before.currentSegment &&
    (['suction', 'mode', 'wetness'] as const).every(name => active.plan.settings?.[name] === undefined ||
      evidence.settings?.[name] === before.settings[name] && evidence.settingSources?.[name]?.sourceUpdatedAt === before.settingSources?.[name]?.sourceUpdatedAt) &&
    (!active.plan.roomTaskSignal || evidence.taskStatus?.state === before.taskStatus?.state && evidence.taskStatus?.sourceUpdatedAt === before.taskStatus?.sourceUpdatedAt) &&
    (!['pause', 'dock'].includes(active.plan.operation) || progress?.value === before.progress?.value && progress?.sourceUpdatedAt === before.progress?.sourceUpdatedAt) &&
    (active.plan.operation !== 'dock' || evidence.chargingStatus?.value === before.chargingStatus?.value && evidence.chargingStatus?.sourceUpdatedAt === before.chargingStatus?.sourceUpdatedAt);
}
export function verifyStep(active: Active, step: DeviceStep, evidence: DeviceSnapshot, now: Date, registry: Registry): Verdict {
  let after: FreshObservation;
  try { after = observation(evidence, now); } catch (error) { if (error instanceof DomainError) return { kind: 'pending' }; throw error; }
  const pending: Verdict = { kind: 'pending', observation: after };
  const verified = (outcome: 'started' | 'paused' | 'docked' | null, observed = after): Verdict => ({ kind: 'verified', observation: observed,
    outcome, settings: evidence.settings ?? {}, settingSources: evidence.settingSources ?? null });
  const dispatchedAt = active.dispatchStartedAt;
  if (!time(dispatchedAt)) return pending;
  if (step.kind === 'setting') {
    const b = active.before.settingSources?.[step.name], a = evidence.settingSources?.[step.name];
    if (!b || !a || !time(b.sourceUpdatedAt) || !time(a.sourceUpdatedAt) || !freshRead(a.observedAt, now, 60_000) ||
      Date.parse(a.sourceUpdatedAt) <= Date.parse(b.sourceUpdatedAt) || Date.parse(a.sourceUpdatedAt) < Date.parse(dispatchedAt) ||
      Date.parse(a.sourceUpdatedAt) > Date.parse(a.observedAt)) return pending;
    return evidence.settings?.[step.name] === step.value ? verified(null) : { kind: 'mismatch', observation: after };
  }
  if (!time(active.before.sourceUpdatedAt) || Date.parse(after.sourceUpdatedAt) <= Date.parse(active.before.sourceUpdatedAt)) return pending;
  switch (step.operation) {
    case 'clean': {
      if (after.state !== 'cleaning') return pending;
      if (step.targetKind === 'home') {
        const g = evidence.homeGeometry, d = evidence.taskDevice;
        if (g?.sha256 !== active.plan.homeGeometrySha256 || after.activeSegments && after.activeSegments.length > 0) return { kind: 'mismatch', observation: after };
        try { assertFreshMap(registry, evidence.map, now); } catch { return { kind: 'mismatch', observation: after }; }
        if (!g || !d || !homeGeometryMatches(active.plan, evidence, now, registry) || Date.parse(g.deviceMapListReadAt) < Date.parse(dispatchedAt) ||
          !freshRead(d.sourceReadAt, now) || !active.before.taskDevice || Date.parse(d.sourceReadAt) <= Date.parse(active.before.taskDevice.sourceReadAt) ||
          Date.parse(d.sourceReadAt) < Date.parse(dispatchedAt)) return pending;
        return d.value === 1 ? verified('started', { ...after, homeTask: { value: 1, sourceReadAt: d.sourceReadAt, geometrySha256: g.sha256, mapListReadAt: g.deviceMapListReadAt } }) :
          d.value === 0 ? pending : { kind: 'mismatch', observation: after };
      }
      const task = evidence.taskStatus;
      if (active.plan.roomTaskSignal ? !task || task.state !== 'room_cleaning' || !time(task.sourceUpdatedAt) ||
        !active.before.taskStatus || Date.parse(task.sourceUpdatedAt) <= Date.parse(active.before.taskStatus.sourceUpdatedAt) || Date.parse(task.sourceUpdatedAt) < Date.parse(dispatchedAt) :
        !evidence.taskId || evidence.taskId === active.before.taskId) return pending;
      if (!after.activeSegments || active.plan.settings?.suction && (evidence.deviceSuction !== active.plan.settings.suction || evidence.settings?.suction !== active.plan.settings.suction)) return pending;
      if (!sameIds(after.activeSegments, step.segments)) return { kind: 'mismatch', observation: after };
      return verified('started', active.plan.roomTaskSignal && task ? { ...after, taskStatus: { state: task.state, sourceUpdatedAt: task.sourceUpdatedAt } } : after);
    }
    case 'pause': {
      const task = evidence.taskStatus;
      return after.state === 'paused' && task?.state === 'room_cleaning_paused' && freshSignal(task, now, 60_000) && active.before.taskStatus &&
        Date.parse(task.sourceUpdatedAt) > Date.parse(active.before.taskStatus.sourceUpdatedAt) && Date.parse(task.sourceUpdatedAt) >= Date.parse(dispatchedAt) &&
        JSON.stringify(after.activeSegments) === JSON.stringify(active.before.activeSegments) ? verified('paused', { ...after, taskStatus: { state: task.state, sourceUpdatedAt: task.sourceUpdatedAt } }) : pending;
    }
    case 'dock': {
      const c = evidence.chargingStatus;
      return after.state === 'docked' && c && (c.value === 'charging' || c.value === 'charging_completed') && freshSignal(c, now, 60_000) && active.before.chargingStatus &&
        Date.parse(c.sourceUpdatedAt) > Date.parse(active.before.chargingStatus.sourceUpdatedAt) && Date.parse(c.sourceUpdatedAt) >= Date.parse(dispatchedAt) ?
        verified('docked', { ...after, chargingStatus: { value: c.value, sourceUpdatedAt: c.sourceUpdatedAt } }) : pending;
    }
    case 'resume': case 'stop': return pending;
  }
}

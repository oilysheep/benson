import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHaCanaryDriver } from '../lib/ha-control.mjs';
import { assertFreshMap, loadRegistry } from '../lib/registry.mjs';
import { validateResult } from '../lib/results.mjs';

const PLUGIN_ID = 'benson-jessica-tool';
const NAMESPACE = 'jessica-operations-v1';
const CANARY = { id: 'stage6-guest-bathroom-20260920', room: 'guest_bathroom' };
const DB_PATH = '/home/oa/.openclaw/state/openclaw.sqlite';
const REGISTRY_URL = new URL('../config/registry.v1.json', import.meta.url);

function records() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const get = db.prepare('SELECT value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? AND entry_key = ?');
  return {
    lookup: (key) => {
      const row = get.get(PLUGIN_ID, NAMESPACE, key);
      return row ? JSON.parse(row.value_json) : null;
    },
    close: () => db.close(),
  };
}

function targetRooms(registry, canary) {
  const slugs = canary.rooms ?? [canary.room];
  assert(Array.isArray(slugs) && slugs.length >= 1 && new Set(slugs).size === slugs.length,
    'Canary target set is invalid');
  return slugs.map((slug) => {
    const room = registry.rooms.find((item) => item.slug === slug && item.enabled);
    assert(room, `Canary room ${slug} is missing`);
    return room;
  });
}

function targetOutput(rooms) {
  return rooms.length === 1 ? { room: rooms[0].slug, segmentId: rooms[0].segmentId } :
    { rooms: rooms.map((room) => room.slug), segmentIds: rooms.map((room) => room.segmentId) };
}

export function checkPreflight({ registry, claim, device, evidence, now = new Date() }, canary = CANARY) {
  const scope = registry.underTest;
  const rooms = targetRooms(registry, canary);
  assert(scope && scope.id === canary.id && scope.maxDispatches === 1);
  if (rooms.length === 1) assert.equal(scope.room, rooms[0].slug, 'Under-test room differs');
  else {
    assert.equal(scope.capability, 'clean_multi_room');
    assert.deepEqual([...scope.rooms].sort(), rooms.map((room) => room.slug).sort(),
      'Under-test target set differs');
  }
  if (canary.subject) assert.equal(scope.subject, canary.subject, 'Under-test requester scope differs');
  assert(Date.parse(scope.expiresAt) > now.getTime(), 'Under-test scope has expired');
  assert.equal(registry.capabilities.find((item) => item.name === scope.capability)?.support, 'reported');
  assert.equal(claim, null, 'Under-test dispatch was already claimed');
  assert.equal(device?.active ?? null, null, 'An unresolved Jessica operation exists');
  assertFreshMap(registry, evidence.map, now);
  assert(['docked', 'idle'].includes(evidence.status.state), 'Vacuum is not idle');
  assert(evidence.status.activeSegments === null ||
    (Array.isArray(evidence.status.activeSegments) && evidence.status.activeSegments.length === 0),
    'Vacuum reports active segments');
  assert.equal(evidence.taskStatus?.state, 'completed', 'Task status is not completed');
  assert.equal(evidence.error, null, 'Vacuum reports an error');
  return { ...targetOutput(rooms), vacuumState: evidence.status.state, taskStatus: evidence.taskStatus.state };
}

export function checkOutcome({ registry, claim, device, history }, canary = CANARY) {
  assert(claim?.version === '1' && typeof claim.requestKey === 'string' &&
    typeof claim.operationId === 'string' && Number.isFinite(Date.parse(claim.claimedAt)),
  'Under-test dispatch claim is missing or invalid');
  assert.equal(device?.active ?? null, null, `Jessica operation remains ${device?.active?.phase ?? 'active'}`);
  assert(history?.version === '1' && history.result, 'No durable Jessica outcome exists');
  const result = history.result;
  assert.equal(result.status, 'success', `Canary did not verify: ${result.error?.code ?? result.status}`);
  const rooms = targetRooms(registry, canary);
  const expectedPlan = { operation: 'clean', targetKind: 'rooms', rooms: rooms.map((room) => ({ slug: room.slug, segmentId: room.segmentId })),
    settings: null, underTestId: canary.id, roomTaskSignal: true };
  const observedAt = result.data?.observation?.observedAt;
  assert(Number.isFinite(Date.parse(observedAt)), 'Verified observation is missing');
  validateResult(result, expectedPlan, new Date(observedAt));
  assert.equal(result.data.operationId, claim.operationId, 'Result differs from the claimed operation');
  assert.equal(result.data.outcome, 'started');
  assert.equal(result.data.dispatch, 'accepted');
  assert(Date.parse(result.data.observation.taskStatus.sourceUpdatedAt) >= Date.parse(claim.claimedAt),
    'Task transition predates the claimed dispatch');
  return { operationId: result.data.operationId, ...targetOutput(rooms),
    taskUpdatedAt: result.data.observation.taskStatus.sourceUpdatedAt,
    observedAt, outcome: result.data.outcome };
}

export function checkLiveOutcome({ registry, claim, evidence, now = new Date() }, canary) {
  assert(canary, 'Canary scope is required');
  assertFreshMap(registry, evidence.map, now);
  const rooms = targetRooms(registry, canary);
  assert.equal(evidence.status.state, 'cleaning', 'Vacuum is not currently cleaning');
  assert.deepEqual([...evidence.status.activeSegments].sort((a, b) => a - b),
    rooms.map((room) => room.segmentId).sort((a, b) => a - b), 'Live target differs from the canary set');
  assert.equal(evidence.taskStatus?.state, 'room_cleaning', 'Live task signal is not room cleaning');
  assert(Number.isFinite(Date.parse(evidence.taskStatus?.sourceUpdatedAt)), 'Live task timestamp is invalid');
  assert(Date.parse(evidence.taskStatus.sourceUpdatedAt) >= Date.parse(claim.claimedAt),
    'Live task signal predates the claimed dispatch');
  assert.equal(evidence.error, null, 'Vacuum reports an error');
  return { liveState: evidence.status.state, ...(rooms.length === 1 ?
    { liveSegmentId: rooms[0].segmentId } : { liveSegmentIds: rooms.map((room) => room.segmentId) }),
    liveTaskUpdatedAt: evidence.taskStatus.sourceUpdatedAt };
}

const HOME_CANARY = { id: 'fc2-home-20260925', subject: 'oren' };

function freshDeviceTimestamp(value, now) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    Date.parse(value) <= now.getTime() && now.getTime() - Date.parse(value) <= 90_000;
}

function homeGeometry(registry, evidence, now) {
  assertFreshMap(registry, evidence.map, now);
  const geometry = evidence.homeGeometry;
  assert(geometry && geometry.sha256 === registry.underTest?.reviewedGeometrySha256,
    'Reviewed selected-map geometry digest differs');
  assert.equal(geometry.mapId, registry.mapBinding.mapId, 'Selected map differs');
  assert(freshDeviceTimestamp(geometry.deviceMapListReadAt, now), 'MAP_LIST device read is stale');
  assert(Number.isFinite(Date.parse(geometry.savedMapLoadedAt)) &&
    Date.parse(geometry.savedMapLoadedAt) <= now.getTime(), 'Saved map was not loaded');
  const visible = registry.rooms.filter((room) => room.enabled).map((room) => room.segmentId);
  const disabled = registry.rooms.filter((room) => !room.enabled).map((room) => room.segmentId);
  assert.deepEqual([...geometry.visibleSegmentIds].sort((a, b) => a - b),
    [...visible].sort((a, b) => a - b), 'Visible target IDs differ');
  assert(Array.isArray(geometry.hiddenSegmentIds) && geometry.hiddenSegmentIds.length === 4 &&
    new Set(geometry.hiddenSegmentIds).size === 4 &&
    disabled.every((id) => geometry.hiddenSegmentIds.includes(id)) &&
    geometry.hiddenSegmentIds.every((id) => !visible.includes(id)),
  'Four reviewed excluded segments are not preserved');
  assert.equal(geometry.noGoCount, 1, 'Reviewed no-go area differs');
  assert.equal(geometry.noMopCount, 0, 'Reviewed no-mop count differs');
  assert.equal(geometry.virtualWallCount, 5, 'Reviewed virtual walls differ');
  return { geometrySha256: geometry.sha256, visibleSegmentIds: visible,
    hiddenSegmentIds: geometry.hiddenSegmentIds, noGoCount: geometry.noGoCount,
    virtualWallCount: geometry.virtualWallCount, mapListReadAt: geometry.deviceMapListReadAt };
}

export function checkHomePreflight({ registry, claim, device, evidence, now = new Date() },
  canary = HOME_CANARY) {
  const scope = registry.underTest;
  assert(scope && scope.id === canary.id && scope.capability === 'clean_home' &&
    scope.subject === canary.subject && scope.maxDispatches === 1,
  'Oren-only home scope differs');
  assert(Date.parse(scope.expiresAt) > now.getTime(), 'Home scope expired');
  assert.equal(registry.capabilities.find((item) => item.name === 'clean_home')?.support, 'reported');
  assert.equal(claim, null, 'Home scope was already claimed');
  assert.equal(device?.active ?? null, null, 'An unresolved Jessica operation exists');
  const geometry = homeGeometry(registry, evidence, now);
  assert(['docked', 'idle'].includes(evidence.status?.state), 'Vacuum is not idle');
  assert(evidence.status.activeSegments === null ||
    Array.isArray(evidence.status.activeSegments) && evidence.status.activeSegments.length === 0,
  'Vacuum reports active segments');
  assert.equal(evidence.taskStatus?.state, 'completed', 'Task status is not completed');
  assert.equal(evidence.taskDevice?.value, 0, 'Device task is not idle');
  assert(freshDeviceTimestamp(evidence.taskDevice?.sourceReadAt, now), 'TASK_STATUS device read is stale');
  assert.equal(evidence.error, null, 'Vacuum reports an error');
  return { ...geometry, vacuumState: evidence.status.state,
    deviceTaskValue: evidence.taskDevice.value, taskReadAt: evidence.taskDevice.sourceReadAt };
}

export function checkHomeOutcome({ registry, claim, device, history }, canary = HOME_CANARY) {
  assert(claim?.version === '1' && typeof claim.requestKey === 'string' &&
    typeof claim.operationId === 'string' && Number.isFinite(Date.parse(claim.claimedAt)),
  'Home dispatch claim is missing or invalid');
  assert.equal(device?.active ?? null, null, 'Home operation remains unresolved');
  assert(history?.version === '1' && history.result, 'No durable home result exists');
  const result = history.result;
  assert.equal(result.status, 'success', `Home start did not verify: ${result.error?.code ?? result.status}`);
  const expectedPlan = { operation: 'clean', targetKind: 'home', rooms: [],
    settings: null, underTestId: canary.id,
    homeGeometrySha256: registry.underTest?.reviewedGeometrySha256, roomTaskSignal: false };
  const observedAt = result.data?.observation?.observedAt;
  assert(Number.isFinite(Date.parse(observedAt)), 'Home observation is missing');
  validateResult(result, expectedPlan, new Date(observedAt));
  assert.equal(result.data.operationId, claim.operationId, 'Result differs from claimed operation');
  assert(Date.parse(result.data.observation.homeTask.sourceReadAt) >= Date.parse(claim.claimedAt),
    'Home device task read predates claim');
  assert(Date.parse(result.data.observation.homeTask.mapListReadAt) >= Date.parse(claim.claimedAt),
    'Home map read predates claim');
  return { operationId: result.data.operationId, outcome: result.data.outcome,
    taskReadAt: result.data.observation.homeTask.sourceReadAt,
    mapListReadAt: result.data.observation.homeTask.mapListReadAt, observedAt };
}

export function checkHomeLive({ registry, claim, evidence, now = new Date() },
  canary = HOME_CANARY) {
  assert(claim?.operationId, 'Home claim is absent');
  const geometry = homeGeometry(registry, evidence, now);
  assert.equal(evidence.status?.state, 'cleaning', 'Vacuum is not cleaning');
  assert(evidence.status.activeSegments === null ||
    Array.isArray(evidence.status.activeSegments) && evidence.status.activeSegments.length === 0,
  'Room-cleaning target appeared');
  assert.equal(evidence.taskDevice?.value, 1, 'Device does not report AUTO_CLEANING');
  assert(freshDeviceTimestamp(evidence.taskDevice?.sourceReadAt, now) &&
    Date.parse(evidence.taskDevice.sourceReadAt) >= Date.parse(claim.claimedAt),
  'Fresh post-claim AUTO_CLEANING read is missing');
  assert(Date.parse(geometry.mapListReadAt) >= Date.parse(claim.claimedAt),
    'Fresh post-claim MAP_LIST read is missing');
  assert.equal(evidence.error, null, 'Vacuum reports an error');
  return { ...geometry, liveState: evidence.status.state,
    deviceTaskValue: evidence.taskDevice.value, taskReadAt: evidence.taskDevice.sourceReadAt };
}

export function checkHomeCleanup({ registry, claim, evidence, now = new Date() },
  canary = HOME_CANARY) {
  assert(claim?.operationId, 'Home claim is absent');
  const geometry = homeGeometry(registry, evidence, now);
  assert.equal(evidence.status?.state, 'docked', 'Vacuum has not returned to dock');
  assert(evidence.status.activeSegments === null ||
    Array.isArray(evidence.status.activeSegments) && evidence.status.activeSegments.length === 0,
  'Active room target remains');
  assert.equal(evidence.taskStatus?.state, 'completed', 'Task status has not cleared');
  assert.equal(evidence.taskDevice?.value, 0, 'Device task status is not idle');
  assert(freshDeviceTimestamp(evidence.taskDevice?.sourceReadAt, now), 'Cleanup task read is stale');
  assert.equal(evidence.error, null, 'Vacuum reports an error');
  return { ...geometry, liveState: evidence.status.state,
    deviceTaskValue: evidence.taskDevice.value, taskReadAt: evidence.taskDevice.sourceReadAt };
}

export async function runHomeCanary({ mode, canary = HOME_CANARY } = {}) {
  assert(['preflight', 'after', 'cleanup'].includes(mode),
    'Usage: check-fc2-home-canary.mjs preflight|after|cleanup');
  const registry = loadRegistry(JSON.parse(readFileSync(REGISTRY_URL, 'utf8')));
  const { lookup, close } = records();
  try {
    const claim = lookup(`under-test:${canary.id}`);
    const device = lookup('device:jessica-vacuum');
    const evidence = await createHaCanaryDriver({ expectedSegments: [], homeCanary: true }).read();
    if (mode === 'preflight') {
      return { check: 'fc2-home-preflight', status: 'PASS',
        ...checkHomePreflight({ registry, claim, device, evidence }, canary) };
    }
    const history = claim ? lookup(`request:${claim.requestKey}`) : null;
    const durable = checkHomeOutcome({ registry, claim, device, history }, canary);
    const live = mode === 'after' ?
      checkHomeLive({ registry, claim, evidence }, canary) :
      checkHomeCleanup({ registry, claim, evidence }, canary);
    return { check: `fc2-home-${mode}`, status: 'PASS', ...durable, ...live };
  } finally {
    close();
  }
}

export async function runRoomCanary({ canary = CANARY, label = 'stage6', mode, requireLiveAfter = false }) {
  assert(['preflight', 'after'].includes(mode), `Usage: check-${label}-canary.mjs preflight|after`);
  const registry = loadRegistry(JSON.parse(readFileSync(REGISTRY_URL, 'utf8')));
  const { lookup, close } = records();
  try {
    const claim = lookup(`under-test:${canary.id}`);
    const device = lookup('device:jessica-vacuum');
    const rooms = targetRooms(registry, canary);
    if (mode === 'preflight') {
      const evidence = await createHaCanaryDriver({ expectedSegments: rooms.map((room) => room.segmentId) }).read();
      return { check: `${label}-preflight`, status: 'PASS',
        ...checkPreflight({ registry, claim, device, evidence }, canary) };
    }
    const history = claim ? lookup(`request:${claim.requestKey}`) : null;
    const durable = checkOutcome({ registry, claim, device, history }, canary);
    const live = requireLiveAfter ? checkLiveOutcome({ registry, claim,
      evidence: await createHaCanaryDriver({ expectedSegments: rooms.map((room) => room.segmentId) }).read() }, canary) : {};
    return { check: `${label}-after`, status: 'PASS', ...durable, ...live };
  } finally {
    close();
  }
}

async function main() {
  const mode = process.argv[2];
  console.log(JSON.stringify(await runRoomCanary({ canary: CANARY, label: 'stage6', mode })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ check: 'stage6-canary', status: 'FAIL',
      reason: error instanceof Error ? error.message : 'Unknown error' }));
    process.exitCode = 1;
  });
}

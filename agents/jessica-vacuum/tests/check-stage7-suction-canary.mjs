import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHaCanaryDriver } from '../lib/ha-control.mjs';
import { assertFreshMap, loadRegistry } from '../lib/registry.mjs';
import { validateResult } from '../lib/results.mjs';

const PLUGIN_ID = 'benson-jessica-tool';
const NAMESPACE = 'jessica-operations-v1';
const DB_PATH = '/home/oa/.openclaw/state/openclaw.sqlite';
const REGISTRY_URL = new URL('../config/registry.v1.json', import.meta.url);

function scopeFor(registry, now, requireActive = true) {
  const scope = registry.underTest;
  assert(scope?.capability === 'clean_settings' && scope.room === 'guest_bathroom' &&
    scope.maxDispatches === 2 && typeof scope.settings?.suction === 'string',
  'Stage 7 suction scope is not active');
  if (requireActive) assert(Date.parse(scope.expiresAt) > now.getTime(), 'Stage 7 suction scope has expired');
  assert.equal(registry.capabilities.find((item) => item.name === 'clean_settings')?.support, 'reported');
  assert(registry.capabilities.find((item) => item.name === 'clean_single_room')?.verifiedRooms?.some(
    (item) => item.room === scope.room), 'Canary room is not technically verified');
  return scope;
}

export function checkPreflight({ registry, claim, device, evidence, now = new Date() }) {
  const scope = scopeFor(registry, now);
  assert.equal(claim, null, 'Under-test dispatch was already claimed');
  assert.equal(device?.active ?? null, null, 'An unresolved Jessica operation exists');
  assertFreshMap(registry, evidence.map, now);
  assert(['docked', 'idle'].includes(evidence.status.state), 'Vacuum is not idle');
  assert(evidence.status.activeSegments === null ||
    (Array.isArray(evidence.status.activeSegments) && evidence.status.activeSegments.length === 0),
  'Vacuum reports active segments');
  assert.equal(evidence.taskStatus?.state, 'completed', 'Task status is not completed');
  assert.equal(evidence.error, null, 'Vacuum reports an error');
  assert(evidence.options?.suction?.includes(scope.settings.suction), 'Requested suction option is unavailable');
  assert.equal(typeof evidence.settings?.suction, 'string', 'Current suction is unavailable');
  assert.equal(evidence.deviceSuction, evidence.settings.suction,
    'Device and selector suction disagree before dispatch');
  assert.notEqual(evidence.settings.suction, scope.settings.suction,
    'Canary cannot prove a setting transition when suction already matches');
  const source = evidence.settingSources?.suction;
  assert(Number.isFinite(Date.parse(source?.observedAt)) &&
    Number.isFinite(Date.parse(source?.sourceUpdatedAt)) &&
    Date.parse(source.sourceUpdatedAt) <= Date.parse(source.observedAt) &&
    now.getTime() - Date.parse(source.observedAt) >= 0 &&
    now.getTime() - Date.parse(source.observedAt) <= 60_000,
  'Fresh suction read-back is unavailable');
  return { scopeId: scope.id, room: scope.room,
    segmentId: registry.rooms.find((item) => item.slug === scope.room).segmentId,
    baselineSuction: evidence.settings.suction, canarySuction: scope.settings.suction };
}

export function checkOutcome({ registry, claim, device, history, evidence, now = new Date() }) {
  const scope = scopeFor(registry, now, false);
  assert(claim?.version === '1' && typeof claim.requestKey === 'string' &&
    typeof claim.operationId === 'string' && Number.isFinite(Date.parse(claim.claimedAt)),
  'Under-test dispatch claim is missing or invalid');
  assert.equal(device?.active ?? null, null, `Jessica operation remains ${device?.active?.phase ?? 'active'}`);
  assert(history?.version === '1' && history.result, 'No durable Jessica outcome exists');
  const result = history.result;
  assert.equal(result.status, 'success', `Canary did not verify: ${result.error?.code ?? result.status}`);
  const room = registry.rooms.find((item) => item.slug === scope.room);
  const plan = { operation: 'clean', targetKind: 'rooms',
    rooms: [{ slug: room.slug, segmentId: room.segmentId }], settings: scope.settings,
    underTestId: scope.id, roomTaskSignal: true };
  const observedAt = result.data?.observation?.observedAt;
  assert(Number.isFinite(Date.parse(observedAt)), 'Verified observation is missing');
  validateResult(result, plan, new Date(observedAt));
  assert.equal(result.data.operationId, claim.operationId, 'Result differs from the claimed operation');
  assert.equal(result.data.outcome, 'started');
  assert.equal(result.data.dispatch, 'accepted');
  assert.deepEqual(result.data.appliedSettings, scope.settings);
  assert(Date.parse(result.data.observation.taskStatus.sourceUpdatedAt) >= Date.parse(claim.claimedAt),
    'Task transition predates the claimed dispatch');
  assert.equal(evidence.error, null, 'Vacuum reports an error');
  assert.equal(evidence.settings?.suction, scope.settings.suction, 'Current suction differs from the canary value');
  assert.equal(evidence.deviceSuction, scope.settings.suction,
    'Vacuum suction differs from the canary value');
  assert(Number.isFinite(Date.parse(evidence.settingSources?.suction?.observedAt)) &&
    Number.isFinite(Date.parse(evidence.settingSources?.suction?.sourceUpdatedAt)) &&
    Date.parse(evidence.settingSources.suction.sourceUpdatedAt) >= Date.parse(claim.claimedAt) &&
    now.getTime() - Date.parse(evidence.settingSources.suction.observedAt) >= 0 &&
    now.getTime() - Date.parse(evidence.settingSources.suction.observedAt) <= 60_000,
  'Fresh suction read-back is unavailable');
  return { scopeId: scope.id, operationId: result.data.operationId, room: room.slug,
    suction: scope.settings.suction, outcome: result.data.outcome, observedAt };
}

async function main() {
  const mode = process.argv[2];
  assert(['preflight', 'after'].includes(mode), 'Usage: check-stage7-suction-canary.mjs preflight|after');
  const registry = loadRegistry(JSON.parse(readFileSync(REGISTRY_URL, 'utf8')));
  const scope = scopeFor(registry, new Date(), mode === 'preflight');
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const get = db.prepare('SELECT value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? AND entry_key = ?');
    const lookup = (key) => {
      const row = get.get(PLUGIN_ID, NAMESPACE, key);
      return row ? JSON.parse(row.value_json) : null;
    };
    const claim = lookup(`under-test:${scope.id}`);
    const device = lookup('device:jessica-vacuum');
    const segmentId = registry.rooms.find((item) => item.slug === scope.room).segmentId;
    const evidence = await createHaCanaryDriver({ expectedSegmentId: segmentId,
      canarySuction: scope.settings.suction }).read();
    const result = mode === 'preflight' ? checkPreflight({ registry, claim, device, evidence }) :
      checkOutcome({ registry, claim, device,
        history: claim ? lookup(`request:${claim.requestKey}`) : null, evidence });
    console.log(JSON.stringify({ check: `stage7-suction-${mode}`, status: 'PASS', ...result }));
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({ check: 'stage7-suction-canary', status: 'FAIL',
      reason: error instanceof Error ? error.message : 'Unknown error' }));
    process.exitCode = 1;
  });
}

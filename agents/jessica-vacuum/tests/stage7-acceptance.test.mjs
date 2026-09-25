import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadRegistry } from '../lib/registry.mjs';
import { checkOutcome, checkPreflight } from './check-stage7-suction-canary.mjs';

const registryConfig = JSON.parse(readFileSync(new URL('../config/registry.v1.json', import.meta.url), 'utf8'));
registryConfig.underTest = { id: 'stage7-suction-fixture', capability: 'clean_settings',
  room: 'guest_bathroom', settings: { suction: 'strong' },
  expiresAt: '2026-09-27T20:00:00+03:00', maxDispatches: 2 };
const registry = loadRegistry(registryConfig);
const map = JSON.parse(readFileSync(new URL('./fixtures/map-stage2-live.json', import.meta.url), 'utf8'));
const at = map.observedAt;
const now = new Date(at);
const claim = { version: '1', requestKey: 'request-stage7', operationId: 'j4-stage7-test',
  claimedAt: new Date(Date.parse(at) - 1_000).toISOString() };
const evidence = { map, status: { state: 'docked', activeSegments: null },
  taskStatus: { state: 'completed' }, error: null,
  options: { observedAt: at, suction: ['standard', 'strong'] },
  settings: { suction: 'standard' }, deviceSuction: 'standard',
  settingSources: { suction: { observedAt: at, sourceUpdatedAt: at } } };
const result = {
  schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: 'clean', verified: true,
  data: { operationId: claim.operationId, rooms: ['guest_bathroom'], outcome: 'started', dispatch: 'accepted',
    observation: { observedAt: at, sourceUpdatedAt: at, state: 'cleaning', activeSegments: [10], currentSegment: 10,
      taskStatus: { state: 'room_cleaning', sourceUpdatedAt: at } }, appliedSettings: { suction: 'strong' } },
  warnings: [], error: null, pendingContext: null,
};

test('Stage 7 checker binds preflight, durable outcome and fresh setting read-back', () => {
  assert.equal(checkPreflight({ registry, claim: null, device: null, evidence, now }).baselineSuction, 'standard');
  assert.equal(checkOutcome({ registry, claim, device: null,
    history: { version: '1', result }, evidence: { ...evidence, settings: { suction: 'strong' },
      deviceSuction: 'strong' }, now }).suction,
  'strong');
  const afterExpiry = new Date('2026-09-28T17:00:00Z');
  const lateReadback = { ...evidence, settings: { suction: 'strong' }, deviceSuction: 'strong',
    settingSources: { suction: { observedAt: afterExpiry.toISOString(), sourceUpdatedAt: at } } };
  assert.equal(checkOutcome({ registry, claim, device: null,
    history: { version: '1', result }, evidence: lateReadback, now: afterExpiry }).scopeId,
  registry.underTest.id);
});

test('Stage 7 checker rejects used scope, unchanged setting, partial result and stale read-back', () => {
  assert.throws(() => checkPreflight({ registry, claim, device: null, evidence, now }));
  assert.throws(() => checkPreflight({ registry, claim: null, device: null,
    evidence: { ...evidence, settings: { suction: 'strong' } }, now }));
  const partial = structuredClone(result);
  partial.data.appliedSettings = {};
  assert.throws(() => checkOutcome({ registry, claim, device: null,
    history: { version: '1', result: partial }, evidence: { ...evidence, settings: { suction: 'strong' },
      deviceSuction: 'strong' }, now }));
  assert.throws(() => checkOutcome({ registry, claim, device: null,
    history: { version: '1', result }, evidence: { ...evidence, settings: { suction: 'standard' } }, now }));
  assert.throws(() => checkOutcome({ registry, claim, device: null,
    history: { version: '1', result }, evidence: { ...evidence, settings: { suction: 'strong' },
      deviceSuction: 'strong',
      settingSources: { suction: { observedAt: at, sourceUpdatedAt: claim.claimedAt } } },
    now: new Date(Date.parse(at) + 61_000) }));
});

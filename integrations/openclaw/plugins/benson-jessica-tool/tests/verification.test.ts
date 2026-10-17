import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/domain-state.js';
import { createDomainCore } from '../../../../../agents/jessica-vacuum/lib/domain-core.js';
import { loadRegistry } from '../../../../../agents/jessica-vacuum/lib/registry.js';
import { preconditions, verifyStep } from '../../../../../agents/jessica-vacuum/lib/verification.js';
import type { Active } from '../../../../../agents/jessica-vacuum/lib/operation-state.js';
test('pause/dock require positive fresh progress, exact segments and a new physical task/charging transition', () => {
  for (const operation of ['pause', 'dock'] as const) {
    const f = fixture(), registry = loadRegistry(f.registry), room = registry.rooms.find(item => item.slug === 'guest_bathroom'); assert.ok(room);
    const now = f.clock().toISOString(), old = new Date(f.clock().getTime() - 1_000).toISOString();
    f.evidence.status = { observedAt: now, sourceUpdatedAt: old, state: 'cleaning', activeSegments: [room.segmentId], currentSegment: room.segmentId };
    f.evidence.taskStatus = { observedAt: now, sourceUpdatedAt: old, state: 'room_cleaning' };
    f.evidence.currentArea = { observedAt: now, sourceUpdatedAt: now, value: 1 };
    f.evidence.chargingStatus = { observedAt: now, sourceUpdatedAt: old, value: 'not_charging' };
    const plan = createDomainCore(f.registry, f.policy).prepareExecute({ operation }, f.identity, f.evidence, f.clock());
    const before = preconditions(plan, f.evidence, f.clock(), registry);
    const active: Active = { ...f.intent, plan, before, resourceGeneration: 1, revision: 2, phase: 'verifying', dispatch: 'accepted', dispatchStartedAt: now };
    const step = { kind: 'command', operation, targetKind: null, segments: [room.segmentId], workflowId: null } as const;
    assert.equal(verifyStep(active, { ...step, segments: [...step.segments] }, f.evidence, f.clock(), registry).kind, 'pending');
    f.tick(); const after = f.clock().toISOString();
    f.evidence.status = { ...f.evidence.status, state: operation === 'pause' ? 'paused' : 'docked', observedAt: after, sourceUpdatedAt: after };
    // A cached signal cannot prove the transition even if the vacuum state changed.
    assert.equal(verifyStep(active, { ...step, segments: [...step.segments] }, f.evidence, f.clock(), registry).kind, 'pending');
    if (operation === 'pause') f.evidence.taskStatus = { state: 'room_cleaning_paused', observedAt: after, sourceUpdatedAt: after };
    else f.evidence.chargingStatus = { value: 'charging', observedAt: after, sourceUpdatedAt: after };
    assert.equal(verifyStep(active, { ...step, segments: [...step.segments] }, f.evidence, f.clock(), registry).kind, 'verified');
  }
});

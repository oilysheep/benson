import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decode } from '../../../../benson-routing/core/value.js';
import { createDomainCore } from '../../../../../../agents/jessica-vacuum/lib/domain-core.js';
import { RegistrySchema, MapSchema } from '../../../../../../agents/jessica-vacuum/lib/schemas.js';
import { preconditions } from '../../../../../../agents/jessica-vacuum/lib/verification.js';
import { loadRegistry } from '../../../../../../agents/jessica-vacuum/lib/registry.js';
import { createOperationState, type Intent, type StateRecords } from '../../../../../../agents/jessica-vacuum/lib/operation-state.js';
import type { AtomicKeyedState, StateObservation, StateWrite, InvocationAuthority, DeviceSnapshot } from '../../../../../../agents/jessica-vacuum/lib/ports.js';
export class MemoryState implements AtomicKeyedState<StateRecords> {
  readonly data = new Map<string, unknown>();
  readonly tokens = new Map<string, object>();
  writes = 0;
  failWrite = 0;
  beforeLookup: ((key: string) => Promise<void>) | undefined;
  async lookup(key: string): Promise<unknown> { await this.beforeLookup?.(key); return structuredClone(this.data.get(key)); }
  async observe(key: string): Promise<StateObservation<unknown>> {
    let token = this.tokens.get(key); if (!token) { token = {}; this.tokens.set(key, token); }
    return { value: structuredClone(this.data.get(key)), token };
  }
  async compareAndSet(key: string, observed: StateObservation<unknown>, value: unknown): Promise<StateWrite> {
    if (this.tokens.get(key) !== observed.token) return 'conflict';
    this.write(key, value); return 'applied';
  }
  async registerIfAbsent(key: string, value: unknown): Promise<boolean> { if (this.data.has(key)) return false; this.write(key, value); return true; }
  private write(key: string, value: unknown) {
    if (++this.writes === this.failWrite) throw new Error('fixture storage outage');
    this.data.set(key, structuredClone(value)); this.tokens.set(key, {});
  }
}
export function fixture(root = '.', clockSource?: () => Date) {
  const read = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  let millis = Date.parse('2026-10-17T12:00:00Z');
  const clock = clockSource ?? (() => new Date(millis)), tick = () => { millis += 1_000; };
  const registry = decode(RegistrySchema, read('agents/jessica-vacuum/config/registry.v1.json'), 'fixture_registry');
  const policy = read('agents/jessica-vacuum/config/policy.v1.json');
  const map = decode(MapSchema, read('agents/jessica-vacuum/tests/fixtures/map-stage2-live.json'), 'fixture_map'); map.observedAt = clock().toISOString();
  const identity = { source: 'trusted_runtime', senderId: 'oren', channelKind: 'direct', perSenderVerified: true };
  const room = registry.rooms.find(item => item.slug === 'living_room'); if (!room) throw new Error('fixture room missing');
  const request = { operation: 'clean', target: { kind: 'rooms', rooms: [room.slug] } };
  const at = clock().toISOString();
  const evidence: DeviceSnapshot = { map, status: { observedAt: at, sourceUpdatedAt: at, state: 'docked', activeSegments: [], currentSegment: null },
    taskStatus: { state: 'completed', observedAt: at, sourceUpdatedAt: at }, taskId: null, taskScope: null, settings: {}, settingSources: null, error: null };
  const core = createDomainCore(registry, policy), plan = core.prepareExecute(request, identity, evidence, clock());
  const intent: Intent = { version: '1', requestKey: 'key', requestHash: 'request-hash', planHash: 'plan-hash', requestEpoch: 'epoch', requesterId: 'oren', operationId: 'j4-fixture',
    plan, phase: 'prepared', stepIndex: 0, before: preconditions(plan, evidence, clock(), loadRegistry(registry)), suctionAlreadySet: false,
    appliedSettings: {}, lastObservation: null, createdAt: at };
  const store = new MemoryState(), state = createOperationState(store), abort = new AbortController();
  let live = true;
  const authority: InvocationAuthority = { signal: abort.signal, assertCurrent() { if (!live) throw new Error('invocation retired'); } };
  return { store, state, intent, registry, policy, identity, request, evidence, room, clock, tick, authority, abort, retire: () => { live = false; } };
}

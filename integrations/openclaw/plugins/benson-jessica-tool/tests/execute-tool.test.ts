import test from 'node:test';
import assert from 'node:assert/strict';
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import { Compile } from 'typebox/compile';
import Type from 'typebox';
import { fixture } from './fixtures/domain-state.js';
import { createJessicaExecuteToolFactory } from '../src/execute-tool.js';
import { loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import type { JessicaDevice, DeviceStep } from '../../../../../agents/jessica-vacuum/lib/ports.js';
import { plain } from '../../../benson-routing/core/value.js';
import { createOperationState } from '../../../../../agents/jessica-vacuum/lib/operation-state.js';
import type { HaTransport } from '../../../../../agents/jessica-vacuum/lib/adapters/ha-transport.js';

function setup() {
  const f = fixture(), trace: DeviceStep[] = [], policy = loadPolicy(f.policy);
  let childLive = true, revokeOnRead = false, retireAfterPost = false;
  const driver: JessicaDevice = { async read() {
    if (revokeOnRead) f.retire();
    const result = structuredClone(f.evidence); result.status.observedAt = f.clock().toISOString();
    if (result.map) result.map.observedAt = f.clock().toISOString();
    return result;
  }, async dispatch(step, guard) {
    await guard.assertMutationCurrent(); guard.assertCurrent(); guard.signal.throwIfAborted();
    trace.push(step); f.tick();
    const at = f.clock().toISOString();
    f.evidence.status = { observedAt: at, sourceUpdatedAt: at, state: 'cleaning', activeSegments: [f.room.segmentId], currentSegment: null };
    f.evidence.taskStatus = { observedAt: at, sourceUpdatedAt: at, state: 'room_cleaning' };
    if (retireAfterPost) f.retire();
    return { accepted: true };
  } };
  const source = { identity: f.identity, requestEpoch: 'original-message-id', authority: f.authority };
  const create = createJessicaExecuteToolFactory({ registryConfig: f.registry, policyConfig: f.policy,
    roster: { accountId: 'fixture', approvedIds: [...new Set(policy.rules.map(rule => rule.subject))], subjectForRoute: () => null },
    store: f.store, driver, clock: f.clock, wait: async () => {}, pollCounts: { clean: 1 }, source,
    jsonResult: value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value }) });
  const context: OpenClawPluginToolContext<2> = { agentId: 'jessica-vacuum', sessionKey: 'agent:jessica-vacuum:subagent:actual-child',
    assertInvocationCurrent() { assert(childLive, 'child retired'); } };
  const tool = create(context); assert(tool && !Array.isArray(tool));
  return { ...f, create, context, tool, source, trace,
    retireChild() { childLive = false; }, revokeRead() { revokeOnRead = true; }, retireAfterPost() { retireAfterPost = true; } };
}
test('native mutation tool uses original epoch across child sessions and preserves one verified effect', async () => {
  const f = setup();
  const first = await f.tool.execute('call-a', f.request);
  const result = first.details; assert(plain(result)); assert.equal(result.status, 'success'); assert.equal(result.verified, true); assert.equal(f.trace.length, 1);
  const next = f.create({ ...f.context, sessionKey: 'agent:jessica-vacuum:subagent:different-child' }); assert(next && !Array.isArray(next));
  assert.deepEqual((await next.execute('different-call', f.request)).details, first.details); assert.equal(f.trace.length, 1);
  assert.equal((await createOperationState(f.store).resource()).owner?.requestEpoch, 'original-message-id');
  const parameters = Compile(Type.Unsafe(f.tool.parameters));
  assert(parameters.Check(f.request)); assert(!parameters.Check({ operation: 'resume' }));
  assert(!parameters.Check({ ...f.request, requestEpoch: 'forged' }));
});
test('missing child custody, retired source/child, cancellation and revocation during read prevent mutation', async () => {
  const f = setup(); assert.equal(f.create({ ...f.context, agentId: 'main' }), null);
  assert.equal(f.create({ ...f.context, sessionKey: 'agent:jessica-vacuum:main' }), null);
  for (const invalidation of ['source', 'child', 'abort', 'read'] as const) {
    const g = setup();
    if (invalidation === 'source') g.retire();
    if (invalidation === 'child') g.retireChild();
    if (invalidation === 'abort') g.abort.abort();
    if (invalidation === 'read') g.revokeRead();
    await assert.rejects(g.tool.execute('blocked', g.request)); assert.equal(g.trace.length, 0);
  }
});
test('retirement after a dispatch preserves uncertain durable ownership and never replays', async () => {
  const f = setup(); f.retireAfterPost();
  await assert.rejects(f.tool.execute('uncertain', f.request)); assert.equal(f.trace.length, 1);
  const records = structuredClone(f.store.data);
  await assert.rejects(f.tool.execute('retry', f.request)); assert.equal(f.trace.length, 1); assert.deepEqual(f.store.data, records);
});

function haSetup(activeRooms: readonly string[] = []) {
  const f = fixture(), policy = loadPolicy(f.policy), posts: { path: string; body: unknown }[] = [], reads: string[] = [];
  const map = f.evidence.map; assert(map);
  let state = activeRooms.length ? 'cleaning' : 'docked', task = activeRooms.length ? 'room_cleaning' : 'completed';
  let active: number[] = activeRooms.map(slug => { const room = f.registry.rooms.find(item => item.slug === slug); assert(room); return room.segmentId; });
  let suction = 'standard';
  let updatedAt = f.clock().toISOString();
  let suctionUpdatedAt = updatedAt;
  // A newer, independent progress observation proves the pre-existing task is
  // active; merely copying the task transition timestamp is insufficient.
  if (activeRooms.length) f.tick();
  const transport: HaTransport = {
    async get(path, authority) {
      authority.assertCurrent(); reads.push(path);
      if (path.endsWith('vacuum.jesica_jesica')) return { entity_id: 'vacuum.jesica_jesica', state, last_updated: updatedAt,
        attributes: { has_error: false, active_segments: active, current_segment: null, suction_level: suction,
          selected_map_id: map.mapId, selected_map: map.mapName, rooms: { [map.mapName]: map.rooms },
          shortcuts: Object.fromEntries(map.shortcuts.map(item => [String(item.id), { id: item.id, map_id: item.mapId, tasks: item.tasks }])) } };
      const entity = path.slice('/api/states/'.length);
      if (entity === 'sensor.jesica_task_status') return { entity_id: entity, state: task, last_updated: updatedAt };
      if (entity === 'select.jesica_suction_level') return { entity_id: entity, state: suction, last_updated: suctionUpdatedAt,
        attributes: { options: ['standard', 'strong'] } };
      if (['sensor.jesica_cleaned_area', 'sensor.jesica_cleaning_time'].includes(entity)) return { entity_id: entity, state: '2', last_updated: f.clock().toISOString() };
      throw new Error('Unexpected HA read: ' + path);
    },
    async post(path, body, guard) {
      await guard.assertMutationCurrent(); guard.assertCurrent(); posts.push({ path, body }); f.tick();
      assert(plain(body));
      if (path.endsWith('vacuum_clean_segment')) {
        updatedAt = f.clock().toISOString();
        assert(typeof body.segments === 'number' || Array.isArray(body.segments));
        active = typeof body.segments === 'number' ? [body.segments] : body.segments as number[];
        state = 'cleaning'; task = 'room_cleaning';
      } else if (path.endsWith('select_option')) { assert(typeof body.option === 'string'); suction = body.option; suctionUpdatedAt = f.clock().toISOString(); }
      else if (path.endsWith('/pause')) { updatedAt = f.clock().toISOString(); state = 'paused'; task = 'room_cleaning_paused'; }
      else throw new Error('Unexpected HA mutation');
      return { accepted: true };
    },
  };
  const options = { registryConfig: f.registry, policyConfig: f.policy,
    roster: { accountId: 'fixture', approvedIds: [...new Set(policy.rules.map(rule => rule.subject))], subjectForRoute: () => null },
    store: f.store, transport, clock: f.clock, wait: async () => {}, pollCounts: { clean: 1, pause: 1 },
    source: { identity: f.identity, requestEpoch: 'ha-original-input', authority: f.authority },
    jsonResult: (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value }) };
  const context: OpenClawPluginToolContext<2> = { agentId: 'jessica-vacuum', sessionKey: 'agent:jessica-vacuum:subagent:ha',
    assertInvocationCurrent() { f.authority.assertCurrent(); } };
  const create = createJessicaExecuteToolFactory(options), tool = create(context); assert(tool && !Array.isArray(tool));
  return { ...f, options, context, tool, reads, posts };
}

test('HA composition preserves exact single/pair/settings dispatch and current-task pause envelopes', async () => {
  for (const mode of ['single', 'pair', 'settings'] as const) {
    const f = haSetup(), rooms = mode === 'settings' ? ['guest_bathroom'] : mode === 'pair' ? ['living_room', 'hallway'] : ['living_room'];
    const request = { operation: 'clean', target: { kind: 'rooms', rooms }, ...(mode === 'settings' ? { settings: { suction: 'strong' } } : {}) };
    const cleaned = await f.tool.execute('ha-clean', request); assert(plain(cleaned.details));
    assert.equal(cleaned.details.status, 'success', JSON.stringify(cleaned.details));
    const expected = rooms.map(slug => { const room = f.registry.rooms.find(item => item.slug === slug); assert(room); return room.segmentId; });
    assert.deepEqual(f.posts.at(-1), { path: '/api/services/dreame_vacuum/vacuum_clean_segment',
      body: { entity_id: 'vacuum.jesica_jesica', segments: expected.length === 1 ? expected[0] : expected } });
    if (mode === 'settings') assert.deepEqual(f.posts[0], { path: '/api/services/select/select_option', body: { entity_id: 'select.jesica_suction_level', option: 'strong' } });
    const count = f.posts.length;
    await f.tool.execute('ha-repeat', request); assert.equal(f.posts.length, count, 'original request must never replay');
  }
  const f = haSetup(['living_room', 'hallway']);
  const paused = await f.tool.execute('ha-pause', { operation: 'pause' }); assert(plain(paused.details));
  assert.equal(paused.details.status, 'success', JSON.stringify(paused.details));
  assert.deepEqual(f.posts, [{ path: '/api/services/vacuum/pause', body: { entity_id: 'vacuum.jesica_jesica' } }]);
});

test('HA composition rejects unsupported request envelopes before transport access', async () => {
  for (const request of [
    { operation: 'clean', target: { kind: 'rooms', rooms: ['living_room', 'kitchen'] } },
    { operation: 'clean', target: { kind: 'rooms', rooms: ['living_room', 'living_room'] } },
    { operation: 'clean', target: { kind: 'rooms', rooms: ['missing'] } },
    { operation: 'clean', target: { kind: 'rooms', rooms: ['living_room'] }, settings: { suction: 'strong' } },
    { operation: 'resume' }, { operation: 'clean', target: { kind: 'home' } },
  ]) {
    const f = haSetup(); await assert.rejects(f.tool.execute('blocked-ha', request));
    assert.deepEqual(f.posts, []); assert.deepEqual(f.reads, []);
  }
  const f = haSetup(); f.retire(); await assert.rejects(f.tool.execute('retired-ha', f.request));
  assert.deepEqual(f.reads, []); assert.deepEqual(f.posts, []);
});

test('HA composition never bypasses retained physical ownership for a fresh control request', async () => {
  const f = haSetup(); await f.tool.execute('owned-clean', f.request);
  const retained = structuredClone(f.store.data), count = f.posts.length;
  const control = createJessicaExecuteToolFactory({ ...f.options, source: { ...f.options.source, requestEpoch: 'new-control-input' } })(f.context);
  assert(control && !Array.isArray(control));
  const result = await control.execute('owned-pause', { operation: 'pause' }); assert(plain(result.details) && plain(result.details.error));
  assert.equal(result.details.error.code, 'RESOURCE_BUSY'); assert.equal(f.posts.length, count); assert.deepEqual(f.store.data, retained);
});

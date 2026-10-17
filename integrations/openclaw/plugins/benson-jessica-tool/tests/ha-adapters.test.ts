import test from 'node:test';
import assert from 'node:assert/strict';
import { createHaTransport } from '../../../../../agents/jessica-vacuum/lib/adapters/ha-transport.js';
import { createHaDevice } from '../../../../../agents/jessica-vacuum/lib/adapters/ha-device.js';
import { projectMap } from '../../../../../agents/jessica-vacuum/lib/ha-read.js';
import type { MutationGuard } from '../../../../../agents/jessica-vacuum/lib/ports.js';
import { fixture } from './fixtures/domain-state.js';
test('HA map projection retains only canonical selected-map fields before closed validation', () => {
  const f = fixture(), map = f.evidence.map;
  assert.ok(map);
  const shortcuts = Object.fromEntries(map.shortcuts.map(shortcut => [String(shortcut.id), { id: shortcut.id, map_id: shortcut.mapId,
    tasks: shortcut.tasks.map(pass => pass.map(task => ({ ...task, vendor_extra: true }))), vendor_extra: true }]));
  const raw = { entity_id: 'vacuum.jesica_jesica', state: 'docked', attributes: { selected_map_id: map.mapId, selected_map: map.mapName,
    rooms: { [map.mapName]: map.rooms.map(room => ({ ...room, vendor_extra: true })), unused_map: null },
    shortcuts: { ...shortcuts, unused_map: { map_id: map.mapId + 1, tasks: null } } } };
  assert.deepEqual(projectMap(raw, f.clock().toISOString()), map);
  assert.throws(() => projectMap({ ...raw, attributes: { ...raw.attributes, rooms: { [map.mapName]: null } } }, f.clock().toISOString()), /Selected Home Assistant map/);
});
test('final POST fence runs after credential await, with no request after cancellation or owner loss', async () => {
  for (const stale of ['invocation', 'mutation', 'abort'] as const) {
    const f = fixture(); let posts = 0, owner = true;
    const guard: MutationGuard = { ...f.authority, async assertMutationCurrent() { if (!owner) throw new Error('stale owner'); } };
    const transport = createHaTransport({ async readCredential() { if (stale === 'invocation') f.retire(); else if (stale === 'mutation') owner = false; else f.abort.abort(); return 'fixture-credential'; },
      fetchImpl: async () => { posts++; return new Response('{}'); } });
    await assert.rejects(transport.post('/api/services/vacuum/start', {}, guard)); assert.equal(posts, 0);
  }
});
test('HA dispatch is allowlisted and preserves scalar/ordered collection payload semantics', async () => {
  const f = fixture(), effects: { path: string; body: unknown }[] = [];
  const transport = { async get() { throw new Error('unexpected GET'); }, async post(path: string, body: unknown) { effects.push({ path, body }); return { accepted: true }; } };
  const guard = { ...f.authority, async assertMutationCurrent() {} };
  for (const segments of [[8], [8, 11, 12]]) {
    const driver = createHaDevice(transport, { segments });
    await driver.dispatch({ kind: 'command', operation: 'clean', targetKind: 'rooms', workflowId: null, segments }, guard);
    assert.deepEqual(effects.at(-1)?.body, { entity_id: 'vacuum.jesica_jesica', segments: segments.length === 1 ? segments[0] : segments });
    await assert.rejects(driver.dispatch({ kind: 'command', operation: 'clean', targetKind: 'rooms', workflowId: null, segments: [999] }, guard), /unapproved/);
  }
  assert.equal(effects.length, 2);
});

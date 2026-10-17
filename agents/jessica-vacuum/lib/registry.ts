import { createHash } from 'node:crypto';
import { type Static } from 'typebox';
import { decode, freeze } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { RegistrySchema, MapSchema, type Capability, type MapEvidence } from './schemas.js';
import { deny } from './errors.js';

type RegistryInput = Static<typeof RegistrySchema>;
export type Registry = Omit<RegistryInput, 'underTest'> & {
  underTest: Exclude<RegistryInput['underTest'], undefined> | null; aliasOwners: Record<string, string>;
};
const instant = (value: string) => Number.isFinite(Date.parse(value));
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(value => b.includes(value));
export function normalizeAlias(value: unknown): string {
  if (typeof value !== 'string') deny('INVALID_ROOM_REFERENCE', 'resolution', 'Room reference must be text');
  return value.normalize('NFKC').trim().toLocaleLowerCase('und').replace(/[\s_-]+/gu, ' ');
}
function mapData(raw: unknown): MapEvidence {
  try { return decode(MapSchema, raw, 'map_invalid'); }
  catch { return deny('INVALID_MAP', 'precondition', 'Map inventory or identity is invalid'); }
}
export function fingerprintMap(raw: unknown): string {
  const map = mapData(raw), roomIds = new Set<number>(), shortcutIds = new Set<number>();
  const rooms = map.rooms.map(room => {
    if (!room.name.trim() || roomIds.has(room.id)) deny('INVALID_MAP', 'precondition', 'Map room inventory is invalid');
    roomIds.add(room.id); return { id: room.id, name: room.name.normalize('NFKC').trim() };
  }).sort((a, b) => a.id - b.id);
  const shortcuts = map.shortcuts.map(shortcut => {
    if (shortcut.mapId !== map.mapId || shortcutIds.has(shortcut.id)) deny('INVALID_MAP', 'precondition', 'Shortcut inventory is invalid');
    shortcutIds.add(shortcut.id);
    return { id: shortcut.id, mapId: shortcut.mapId, tasks: shortcut.tasks.map(pass => pass.map(task => ({
      order: task.order, segment_id: task.segment_id, suction_level: task.suction_level, water_volume: task.water_volume,
      cleaning_times: task.cleaning_times, cleaning_mode: task.cleaning_mode, wetness_level: task.wetness_level,
      mopping_settings: task.mopping_settings, cleaning_route: task.cleaning_route, task_type: task.task_type,
    }))) };
  }).sort((a, b) => a.id - b.id);
  if (!map.mapName.trim()) deny('INVALID_MAP', 'precondition', 'Map identity is missing');
  return createHash('sha256').update(JSON.stringify({ mapId: map.mapId, mapName: map.mapName.normalize('NFKC').trim(), rooms, shortcuts })).digest('hex');
}
/** Shared evidence refinements for registry admission and result verification. */
export function validCapability(cap: Capability): boolean {
  if (cap.observedAt !== null && !instant(cap.observedAt)) return false;
  if (cap.verifiedRooms && (!['clean_single_room', 'pause', 'dock'].includes(cap.name) ||
      cap.support !== (cap.name === 'clean_single_room' ? 'reported' : 'verified') ||
      cap.verifiedRooms.some(item => !instant(item.observedAt)))) return false;
  if (cap.verifiedRoomSets && (!['clean_multi_room', 'pause'].includes(cap.name) ||
      cap.support !== (cap.name === 'clean_multi_room' ? 'reported' : 'verified') ||
      cap.verifiedRoomSets.some(item => !instant(item.observedAt)))) return false;
  return !cap.verifiedSettings || (cap.name === 'clean_settings' && cap.support === 'reported' &&
    cap.verifiedSettings.every(item => instant(item.observedAt)));
}
export function loadRegistry(raw: unknown): Registry {
  let input: RegistryInput;
  try { input = decode(RegistrySchema, raw, 'registry_invalid'); }
  catch { return deny('INVALID_REGISTRY', 'precondition', 'Registry structure or version is invalid'); }
  const reject = (message: string): never => deny('INVALID_REGISTRY', 'precondition', message);
  const binding = input.mapBinding;
  if (!binding.mapName.trim() || binding.generation !== `map-${binding.mapId}-${input.mapFingerprint}` || !instant(binding.observedAt)) reject('Reviewed map binding is invalid');
  const aliases: Record<string, string> = {}; Object.setPrototypeOf(aliases, null);
  const slugs = new Set<string>(), segments = new Set<number>(), names = new Set<string>(), workflowIds = new Set<string>();
  for (const room of input.rooms) {
    if (!room.label.trim() || (room.enabled ? room.disabledReason !== null : !room.disabledReason?.trim()) ||
        slugs.has(room.slug) || segments.has(room.segmentId) ||
        (room.enabled && room.binding === null) || (room.binding !== null &&
          (room.binding.generation !== binding.generation || !instant(room.binding.observedAt)))) reject('Room entry or binding is invalid');
    slugs.add(room.slug); segments.add(room.segmentId);
    for (const value of [room.slug, room.label, ...room.aliases]) {
      const key = normalizeAlias(value);
      if (!key || key.length > 80) reject('Room alias is empty or too long');
      if (aliases[key] && aliases[key] !== room.slug) deny('DUPLICATE_ALIAS', 'precondition', `Alias ${key} belongs to multiple rooms`);
      aliases[key] = room.slug;
    }
  }
  const enabled = (slug: string) => input.rooms.some(room => room.slug === slug && room.enabled) &&
    !input.workflows.some(workflow => workflow.room === slug && workflow.enabled);
  const capability = (name: string) => input.capabilities.find(cap => cap.name === name);
  for (const cap of input.capabilities) {
    if (names.has(cap.name) || !validCapability(cap) ||
        (['clean_single_room', 'clean_multi_room'].includes(cap.name) && cap.support === 'verified') ||
        (cap.verifiedSettings !== undefined && (cap.verifiedRooms !== undefined || cap.verifiedRoomSets !== undefined))) reject('Capability evidence is invalid');
    names.add(cap.name);
    if (cap.verifiedRooms && (new Set(cap.verifiedRooms.map(item => item.room)).size !== cap.verifiedRooms.length ||
        cap.verifiedRooms.some(item => !enabled(item.room)))) reject('Verified room evidence is invalid');
    if (cap.verifiedRoomSets && (new Set(cap.verifiedRoomSets.map(item => [...item.rooms].sort().join(','))).size !== cap.verifiedRoomSets.length ||
        cap.verifiedRoomSets.some(item => item.rooms.some(slug => !enabled(slug))))) reject('Verified room-set evidence is invalid');
    if (cap.verifiedSettings?.some(item => !enabled(item.room) ||
        !capability('clean_single_room')?.verifiedRooms?.some(verified => verified.room === item.room))) reject('Verified setting evidence is invalid');
  }
  const cleanRooms = new Set(capability('clean_single_room')?.verifiedRooms?.map(item => item.room) ?? []);
  const cleanSets = capability('clean_multi_room')?.verifiedRoomSets ?? [];
  if (cleanSets.some(set => set.rooms.some(slug => !cleanRooms.has(slug))) ||
      capability('pause')?.verifiedRoomSets?.some(set => !cleanSets.some(clean => sameSet(set.rooms, clean.rooms)))) reject('Verified multi-room scope exceeds accepted cleaning scope');
  for (const cap of input.capabilities.filter(item => ['pause', 'dock'].includes(item.name) && item.support === 'verified')) {
    if (!cap.verifiedRooms?.length || cap.verifiedRooms.some(item => !cleanRooms.has(item.room))) reject('Verified control scope exceeds accepted cleaning scope');
  }
  const scope = input.underTest;
  if (scope) {
    const cap = capability(scope.capability);
    let valid = instant(scope.expiresAt) && (['pause', 'dock'].includes(scope.capability) ?
      cap?.support === 'reported' || cap?.support === 'verified' : cap?.support === 'reported');
    if (scope.capability === 'clean_home') { /* Closed schema binds Oren and reviewed geometry. */ }
    else if (scope.capability === 'clean_settings') valid &&= enabled(scope.room) && cleanRooms.has(scope.room) &&
      !input.workflows.some(workflow => workflow.room === scope.room);
    else if ('rooms' in scope) valid &&= scope.rooms.every(enabled) && scope.rooms.every(slug => cleanRooms.has(slug)) &&
      !(scope.capability === 'clean_multi_room' ? cleanSets : cap?.verifiedRoomSets ?? []).some(set => sameSet(set.rooms, scope.rooms)) &&
      (scope.capability !== 'pause' || capability('clean_multi_room')?.support === 'reported');
    else valid &&= enabled(scope.room) && !cap?.verifiedRooms?.some(item => item.room === scope.room) &&
      (scope.capability === 'clean_single_room' || cleanRooms.has(scope.room));
    if (!valid) reject('Under-test scope is invalid');
  }
  for (const workflow of input.workflows) {
    if (workflowIds.has(workflow.id) || !slugs.has(workflow.room)) reject('Workflow definition is invalid'); workflowIds.add(workflow.id);
  }
  return freeze({ ...structuredClone(input), underTest: scope === undefined ? null : structuredClone(scope), aliasOwners: aliases });
}
export function assertFreshMap(registry: Registry, raw: unknown, now = new Date(), maxAgeMs = 60_000): string {
  const map = mapData(raw), age = now.getTime() - Date.parse(map.observedAt ?? '');
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) deny('MAP_STALE', 'precondition', 'Map observation is stale');
  if (map.mapId !== registry.mapBinding.mapId || map.mapName.normalize('NFKC').trim() !== registry.mapBinding.mapName ||
      fingerprintMap(map) !== registry.mapFingerprint) deny('MAP_CHANGED', 'precondition', 'Map fingerprint differs from approved registry');
  for (const room of registry.rooms.filter(item => item.enabled)) {
    const live = map.rooms.find(item => item.id === room.segmentId);
    if (room.binding?.generation !== registry.mapBinding.generation || !live || live.name.normalize('NFKC').trim() !== room.label) {
      deny('ROOM_MAP_MISMATCH', 'precondition', `Room ${room.slug} differs from approved map`);
    }
  }
  for (const workflow of registry.workflows.filter(item => item.enabled)) {
    if (map.shortcuts.find(item => item.id === workflow.shortcutId)?.tasks.length !== workflow.expectedPasses) deny('WORKFLOW_CHANGED', 'precondition', `Workflow ${workflow.id} differs from approved map`);
  }
  return registry.mapBinding.generation;
}
export function resolveRoom(registry: Registry, reference: unknown) {
  const key = normalizeAlias(reference);
  if (!key || key.length > 80) deny('INVALID_ROOM_REFERENCE', 'resolution', 'Room reference is empty or too long');
  const slug = registry.aliasOwners[key], room = registry.rooms.find(item => item.slug === slug);
  if (room) { if (!room.enabled) deny('ROOM_DISABLED', 'resolution', `Room ${slug} is not approved for control`); return room; }
  const candidates = registry.rooms.filter(item => item.enabled && [item.slug, item.label, ...item.aliases].some(alias => normalizeAlias(alias).startsWith(key)));
  if (candidates.length > 1) deny('AMBIGUOUS_ROOM', 'resolution', 'Room reference matches several rooms', { candidates: candidates.map(({ slug: room, label }) => ({ room, label })) });
  return deny('UNKNOWN_ROOM', 'resolution', 'Room reference is not approved');
}
export function resolveRooms(registry: Registry, references: readonly string[]) {
  if (!Array.isArray(references) || references.length < 1 || references.length > registry.rooms.filter(room => room.enabled).length) deny('INVALID_ROOM_SET', 'resolution', 'Room count is outside approved map');
  const rooms = references.map(reference => resolveRoom(registry, reference));
  if (new Set(rooms.map(room => room.slug)).size !== rooms.length) deny('DUPLICATE_ROOM', 'resolution', 'Several references resolve to the same room');
  return rooms;
}
export function requireCapability(registry: Registry, name: string, write = false): Capability {
  const cap = registry.capabilities.find(item => item.name === name);
  if (!cap || cap.support === 'disabled' || (write && cap.support !== 'verified')) deny('CAPABILITY_UNSUPPORTED', 'precondition', `Capability ${name} is not verified`);
  return cap;
}

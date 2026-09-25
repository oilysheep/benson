import { createHash } from 'node:crypto';
import { deny } from './errors.mjs';
import { deepFreeze } from './immutable.mjs';

const TASK_FIELDS = [
  'order', 'segment_id', 'suction_level', 'water_volume', 'cleaning_times',
  'cleaning_mode', 'wetness_level', 'mopping_settings', 'cleaning_route', 'task_type',
];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function normalizeAlias(value) {
  if (typeof value !== 'string') deny('INVALID_ROOM_REFERENCE', 'resolution', 'Room reference must be text');
  return value.normalize('NFKC').trim().toLocaleLowerCase('und').replace(/[\s_-]+/gu, ' ');
}

function canonicalMap(map) {
  if (!record(map) || !positiveId(map.mapId) || typeof map.mapName !== 'string' || !map.mapName.trim()) {
    deny('INVALID_MAP', 'precondition', 'Map identity is missing');
  }
  if (!Array.isArray(map.rooms) || !map.rooms.length || !Array.isArray(map.shortcuts)) {
    deny('INVALID_MAP', 'precondition', 'Map rooms or shortcuts are missing');
  }
  const roomIds = new Set();
  const rooms = map.rooms.map((room) => {
    if (!record(room) || !positiveId(room.id) || typeof room.name !== 'string' || !room.name.trim() || roomIds.has(room.id)) {
      deny('INVALID_MAP', 'precondition', 'Map room inventory is invalid');
    }
    roomIds.add(room.id);
    return { id: room.id, name: room.name.normalize('NFKC').trim() };
  }).sort((a, b) => a.id - b.id);
  const shortcutIds = new Set();
  const shortcuts = map.shortcuts.map((shortcut) => {
    if (!record(shortcut) || !positiveId(shortcut.id) || shortcut.mapId !== map.mapId ||
        shortcutIds.has(shortcut.id) || !Array.isArray(shortcut.tasks) || !shortcut.tasks.length) {
      deny('INVALID_MAP', 'precondition', 'Shortcut inventory is invalid');
    }
    shortcutIds.add(shortcut.id);
    const tasks = shortcut.tasks.map((pass) => {
      if (!Array.isArray(pass) || !pass.length) deny('INVALID_MAP', 'precondition', 'Shortcut pass is empty');
      return pass.map((task) => {
        if (!record(task) || Object.keys(task).length !== TASK_FIELDS.length ||
            !TASK_FIELDS.every((key) => Number.isSafeInteger(task[key]))) {
          deny('INVALID_MAP', 'precondition', 'Shortcut task structure is invalid');
        }
        return Object.fromEntries(TASK_FIELDS.map((key) => [key, task[key]]));
      });
    });
    return { id: shortcut.id, mapId: shortcut.mapId, tasks };
  }).sort((a, b) => a.id - b.id);
  return { mapId: map.mapId, mapName: map.mapName.normalize('NFKC').trim(), rooms, shortcuts };
}

export function fingerprintMap(map) {
  return createHash('sha256').update(JSON.stringify(canonicalMap(map))).digest('hex');
}

export function loadRegistry(input) {
  if (!record(input) || input.version !== '1' || !/^[a-f0-9]{64}$/u.test(input.mapFingerprint ?? '') ||
      !record(input.mapBinding) || !Array.isArray(input.rooms) ||
      !Array.isArray(input.workflows) || !Array.isArray(input.capabilities)) {
    deny('INVALID_REGISTRY', 'precondition', 'Registry structure or version is invalid');
  }
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'capabilities,mapBinding,mapFingerprint,rooms,version,workflows' &&
      keys !== 'capabilities,mapBinding,mapFingerprint,rooms,underTest,version,workflows') {
    deny('INVALID_REGISTRY', 'precondition', 'Registry has unknown fields');
  }
  if (Object.keys(input.mapBinding).sort().join(',') !==
      'deviceEntity,generation,mapId,mapName,observedAt,reviewProvenance,source' ||
      input.mapBinding.deviceEntity !== 'vacuum.jesica_jesica' ||
      !positiveId(input.mapBinding.mapId) || typeof input.mapBinding.mapName !== 'string' ||
      !input.mapBinding.mapName.trim() ||
      !new RegExp(`^map-${input.mapBinding.mapId}-${input.mapFingerprint}$`, 'u').test(input.mapBinding.generation ?? '') ||
      !Number.isFinite(Date.parse(input.mapBinding.observedAt)) ||
      typeof input.mapBinding.source !== 'string' || !input.mapBinding.source ||
      typeof input.mapBinding.reviewProvenance !== 'string' || !input.mapBinding.reviewProvenance) {
    deny('INVALID_REGISTRY', 'precondition', 'Reviewed map binding is invalid');
  }
  const roomSlugs = new Set();
  const segmentIds = new Set();
  const aliasOwners = new Map();
  for (const room of input.rooms) {
    if (!record(room) || Object.keys(room).sort().join(',') !== 'aliases,binding,disabledReason,enabled,label,segmentId,slug' ||
        !/^[a-z][a-z0-9_]*$/u.test(room.slug ?? '') || !positiveId(room.segmentId) ||
        typeof room.label !== 'string' || !room.label.trim() || !Array.isArray(room.aliases) ||
        typeof room.enabled !== 'boolean' || (room.enabled ? room.disabledReason !== null :
          typeof room.disabledReason !== 'string' || !room.disabledReason.trim()) ||
        roomSlugs.has(room.slug) || segmentIds.has(room.segmentId)) {
      deny('INVALID_REGISTRY', 'precondition', 'Room entry or segment mapping is invalid');
    }
    if (room.binding !== null && (!record(room.binding) ||
        Object.keys(room.binding).sort().join(',') !== 'generation,observedAt,reviewProvenance,source' ||
        room.binding.generation !== input.mapBinding.generation ||
        !Number.isFinite(Date.parse(room.binding.observedAt)) ||
        typeof room.binding.source !== 'string' || !room.binding.source ||
        typeof room.binding.reviewProvenance !== 'string' || !room.binding.reviewProvenance)) {
      deny('INVALID_REGISTRY', 'precondition', 'Room binding evidence is invalid');
    }
    if (room.enabled && room.binding === null) {
      deny('INVALID_REGISTRY', 'precondition', 'Enabled room lacks reviewed binding evidence');
    }
    roomSlugs.add(room.slug);
    segmentIds.add(room.segmentId);
    for (const alias of [room.slug, room.label, ...room.aliases]) {
      const key = normalizeAlias(alias);
      if (!key || key.length > 80) deny('INVALID_REGISTRY', 'precondition', 'Room alias is empty or too long');
      const previous = aliasOwners.get(key);
      if (previous && previous !== room.slug) deny('DUPLICATE_ALIAS', 'precondition', `Alias ${key} belongs to multiple rooms`);
      aliasOwners.set(key, room.slug);
    }
  }
  const capabilityNames = new Set();
  for (const cap of input.capabilities) {
    const fields = Object.keys(cap ?? {}).sort().join(',');
    if (!record(cap) || (fields !== 'name,observedAt,provenance,support' &&
        fields !== 'name,observedAt,provenance,support,verifiedRooms' &&
        fields !== 'name,observedAt,provenance,support,verifiedRoomSets' &&
        fields !== 'name,observedAt,provenance,support,verifiedRoomSets,verifiedRooms' &&
        fields !== 'name,observedAt,provenance,support,verifiedSettings') ||
        typeof cap.name !== 'string' || !cap.name || capabilityNames.has(cap.name) ||
        !['disabled', 'reported', 'verified'].includes(cap.support) ||
        typeof cap.provenance !== 'string' || !cap.provenance ||
        (cap.observedAt !== null && !Number.isFinite(Date.parse(cap.observedAt)))) {
      deny('INVALID_REGISTRY', 'precondition', 'Capability evidence is invalid');
    }
    if (cap.name === 'clean_single_room' && cap.support === 'verified') {
      deny('INVALID_REGISTRY', 'precondition', 'Single-room support must be verified per room');
    }
    if (cap.name === 'clean_multi_room' && cap.support === 'verified') {
      deny('INVALID_REGISTRY', 'precondition', 'Multi-room support must be verified per exact room set');
    }
    if (cap.verifiedRooms !== undefined &&
        (!['clean_single_room', 'pause', 'dock'].includes(cap.name) ||
          (cap.name === 'clean_single_room' ? cap.support !== 'reported' : cap.support !== 'verified') ||
          !Array.isArray(cap.verifiedRooms) || !cap.verifiedRooms.length ||
          new Set(cap.verifiedRooms.map((item) => item?.room)).size !== cap.verifiedRooms.length ||
          cap.verifiedRooms.some((item) => !record(item) ||
            Object.keys(item).sort().join(',') !== 'observedAt,provenance,room' ||
            !input.rooms.some((room) => room.slug === item.room && room.enabled) ||
            input.workflows.some((workflow) => workflow.room === item.room && workflow.enabled) ||
            typeof item.observedAt !== 'string' || !Number.isFinite(Date.parse(item.observedAt)) ||
            typeof item.provenance !== 'string' || !item.provenance))) {
      deny('INVALID_REGISTRY', 'precondition', 'Verified room evidence is invalid');
    }
    if (cap.verifiedRoomSets !== undefined &&
        (!['clean_multi_room', 'pause'].includes(cap.name) ||
          (cap.name === 'clean_multi_room' ? cap.support !== 'reported' : cap.support !== 'verified') ||
          !Array.isArray(cap.verifiedRoomSets) || !cap.verifiedRoomSets.length ||
          new Set(cap.verifiedRoomSets.map((item) => Array.isArray(item?.rooms) ?
            [...item.rooms].sort().join(',') : null)).size !== cap.verifiedRoomSets.length ||
          cap.verifiedRoomSets.some((item) => !record(item) ||
            Object.keys(item).sort().join(',') !== 'observedAt,provenance,rooms' ||
            !Array.isArray(item.rooms) || item.rooms.length < 2 ||
            new Set(item.rooms).size !== item.rooms.length ||
            item.rooms.some((slug) => !input.rooms.some((room) => room.slug === slug && room.enabled) ||
              input.workflows.some((workflow) => workflow.room === slug && workflow.enabled)) ||
            typeof item.observedAt !== 'string' || !Number.isFinite(Date.parse(item.observedAt)) ||
            typeof item.provenance !== 'string' || !item.provenance))) {
      deny('INVALID_REGISTRY', 'precondition', 'Verified room-set evidence is invalid');
    }
    if (cap.verifiedSettings !== undefined &&
        (cap.name !== 'clean_settings' || cap.support !== 'reported' ||
          !Array.isArray(cap.verifiedSettings) || cap.verifiedSettings.length !== 1 ||
          cap.verifiedSettings.some((item) => !record(item) ||
            Object.keys(item).sort().join(',') !== 'observedAt,provenance,room,settings' ||
            !input.rooms.some((room) => room.slug === item.room && room.enabled) ||
            !input.capabilities.find((entry) => entry.name === 'clean_single_room')?.verifiedRooms?.some(
              (entry) => entry.room === item.room) ||
            input.workflows.some((workflow) => workflow.room === item.room && workflow.enabled) ||
            !record(item.settings) || Object.keys(item.settings).join(',') !== 'suction' ||
            !['quiet', 'standard', 'strong', 'turbo'].includes(item.settings.suction) ||
            typeof item.observedAt !== 'string' || !Number.isFinite(Date.parse(item.observedAt)) ||
            typeof item.provenance !== 'string' || !item.provenance))) {
      deny('INVALID_REGISTRY', 'precondition', 'Verified setting evidence is invalid');
    }
    capabilityNames.add(cap.name);
  }
  const verifiedCleanRooms = new Set(input.capabilities.find((cap) => cap.name === 'clean_single_room')?.verifiedRooms
    ?.map((item) => item.room) ?? []);
  const cleanRoomSets = input.capabilities.find((cap) => cap.name === 'clean_multi_room')?.verifiedRoomSets ?? [];
  for (const roomSet of cleanRoomSets) {
    if (roomSet.rooms.some((slug) => !verifiedCleanRooms.has(slug))) {
      deny('INVALID_REGISTRY', 'precondition', 'Verified multi-room scope exceeds accepted cleaning rooms');
    }
  }
  for (const roomSet of input.capabilities.find((cap) => cap.name === 'pause')?.verifiedRoomSets ?? []) {
    if (!cleanRoomSets.some((cleanSet) => cleanSet.rooms.length === roomSet.rooms.length &&
        roomSet.rooms.every((slug) => cleanSet.rooms.includes(slug)))) {
      deny('INVALID_REGISTRY', 'precondition', 'Verified multi-room pause exceeds accepted cleaning sets');
    }
  }
  for (const control of input.capabilities.filter((cap) => ['pause', 'dock'].includes(cap.name) && cap.support === 'verified')) {
    if (!control.verifiedRooms?.length || control.verifiedRooms.some((item) => !verifiedCleanRooms.has(item.room))) {
      deny('INVALID_REGISTRY', 'precondition', 'Verified control scope exceeds accepted cleaning scope');
    }
  }
  const underTest = input.underTest;
  if (underTest !== undefined) {
    const fields = Object.keys(underTest ?? {}).sort().join(',');
    const roomScope = underTest?.capability === 'clean_single_room' &&
      fields === 'capability,expiresAt,id,maxDispatches,room,subject' && underTest.maxDispatches === 1 &&
      /^[a-z][a-z0-9:_-]{0,79}$/u.test(underTest.subject ?? '') &&
      !input.capabilities.find((cap) => cap.name === 'clean_single_room')?.verifiedRooms?.some((item) => item.room === underTest.room);
    const multiScope = underTest?.capability === 'clean_multi_room' &&
      fields === 'capability,expiresAt,id,maxDispatches,rooms,subject' && underTest.maxDispatches === 1 &&
      /^[a-z][a-z0-9:_-]{0,79}$/u.test(underTest.subject ?? '') &&
      Array.isArray(underTest.rooms) && underTest.rooms.length === 2 &&
      new Set(underTest.rooms).size === 2 &&
      !cleanRoomSets.some((set) => set.rooms.length === underTest.rooms.length &&
        set.rooms.every((slug) => underTest.rooms.includes(slug))) &&
      underTest.rooms.every((slug) => input.rooms.some((room) => room.slug === slug && room.enabled) &&
        input.capabilities.find((cap) => cap.name === 'clean_single_room')?.verifiedRooms?.some(
          (item) => item.room === slug) &&
        !input.workflows.some((workflow) => workflow.room === slug && workflow.enabled));
    const homeScope = underTest?.capability === 'clean_home' &&
      fields === 'capability,expiresAt,id,maxDispatches,reviewedGeometrySha256,subject' &&
      underTest.maxDispatches === 1 && underTest.subject === 'oren' &&
      /^[a-f0-9]{64}$/u.test(underTest.reviewedGeometrySha256 ?? '');
    const settingScope = underTest?.capability === 'clean_settings' &&
      fields === 'capability,expiresAt,id,maxDispatches,room,settings' && underTest.maxDispatches === 2 &&
      record(underTest.settings) && Object.keys(underTest.settings).join(',') === 'suction' &&
      ['quiet', 'standard', 'strong', 'turbo'].includes(underTest.settings.suction) &&
      input.capabilities.find((cap) => cap.name === 'clean_single_room')?.verifiedRooms?.some((item) => item.room === underTest.room) &&
      !input.workflows.some((workflow) => workflow.room === underTest.room);
    const controlCapability = input.capabilities.find((cap) => cap.name === underTest?.capability);
    const controlScope = ['pause', 'dock'].includes(underTest?.capability) &&
      fields === 'capability,expiresAt,id,maxDispatches,room,subject' && underTest.maxDispatches === 1 &&
      /^[a-z][a-z0-9:_-]{0,79}$/u.test(underTest.subject ?? '') &&
      ['reported', 'verified'].includes(controlCapability?.support) &&
      !controlCapability.verifiedRooms?.some((item) => item.room === underTest.room) &&
      input.capabilities.find((cap) => cap.name === 'clean_single_room')?.verifiedRooms?.some(
        (item) => item.room === underTest.room);
    const multiControlScope = underTest?.capability === 'pause' &&
      fields === 'capability,expiresAt,id,maxDispatches,rooms,subject' && underTest.maxDispatches === 1 &&
      /^[a-z][a-z0-9:_-]{0,79}$/u.test(underTest.subject ?? '') &&
      ['reported', 'verified'].includes(controlCapability?.support) &&
      input.capabilities.find((cap) => cap.name === 'clean_multi_room')?.support === 'reported' &&
      Array.isArray(underTest.rooms) && underTest.rooms.length === 2 &&
      new Set(underTest.rooms).size === underTest.rooms.length &&
      !controlCapability.verifiedRoomSets?.some((set) => set.rooms.length === underTest.rooms.length &&
        set.rooms.every((slug) => underTest.rooms.includes(slug))) &&
      underTest.rooms.every((slug) => verifiedCleanRooms.has(slug) &&
        !input.workflows.some((workflow) => workflow.room === slug && workflow.enabled));
    if (!record(underTest) || !/^[a-z0-9-]{1,80}$/u.test(underTest.id ?? '') ||
        !Number.isFinite(Date.parse(underTest.expiresAt)) ||
        !(homeScope || multiScope || multiControlScope || input.rooms.some((room) => room.slug === underTest.room && room.enabled)) ||
        ((controlScope || multiControlScope) ? false :
          input.capabilities.find((cap) => cap.name === underTest.capability)?.support !== 'reported') ||
        !(homeScope || roomScope || multiScope || settingScope || controlScope || multiControlScope)) {
      deny('INVALID_REGISTRY', 'precondition', 'Under-test scope is invalid');
    }
  }
  const workflowIds = new Set();
  for (const workflow of input.workflows) {
    if (!record(workflow) || Object.keys(workflow).sort().join(',') !== 'enabled,expectedPasses,id,kind,room,shortcutId' ||
        typeof workflow.id !== 'string' || !workflow.id || workflowIds.has(workflow.id) ||
        workflow.kind !== 'shortcut' || !roomSlugs.has(workflow.room) || !positiveId(workflow.shortcutId) ||
        !positiveId(workflow.expectedPasses) || typeof workflow.enabled !== 'boolean') {
      deny('INVALID_REGISTRY', 'precondition', 'Workflow definition is invalid');
    }
    workflowIds.add(workflow.id);
  }
  return deepFreeze({
    version: input.version,
    mapFingerprint: input.mapFingerprint,
    mapBinding: structuredClone(input.mapBinding),
    rooms: structuredClone(input.rooms),
    workflows: structuredClone(input.workflows),
    capabilities: structuredClone(input.capabilities),
    underTest: underTest === undefined ? null : structuredClone(underTest),
    aliasOwners: Object.assign(Object.create(null), Object.fromEntries(aliasOwners)),
  });
}

export function assertFreshMap(registry, map, now = new Date(), maxAgeMs = 60_000) {
  if (!record(map) || typeof map.observedAt !== 'string') deny('MAP_STALE', 'precondition', 'Map observation is missing');
  const age = now.getTime() - Date.parse(map.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) deny('MAP_STALE', 'precondition', 'Map observation is stale');
  if (map.mapId !== registry.mapBinding.mapId || map.mapName.normalize('NFKC').trim() !== registry.mapBinding.mapName) {
    deny('MAP_CHANGED', 'precondition', 'Selected map identity differs from reviewed binding');
  }
  if (fingerprintMap(map) !== registry.mapFingerprint) deny('MAP_CHANGED', 'precondition', 'Map fingerprint differs from approved registry');
  for (const room of registry.rooms.filter((item) => item.enabled)) {
    if (room.binding?.generation !== registry.mapBinding.generation) {
      deny('ROOM_MAP_MISMATCH', 'precondition', `Room ${room.slug} lacks the current reviewed generation`);
    }
    const live = map.rooms.find((item) => item.id === room.segmentId);
    if (!live || live.name.normalize('NFKC').trim() !== room.label) {
      deny('ROOM_MAP_MISMATCH', 'precondition', `Room ${room.slug} differs from approved map`);
    }
  }
  for (const workflow of registry.workflows.filter((item) => item.enabled)) {
    const live = map.shortcuts.find((item) => item.id === workflow.shortcutId);
    if (!live || live.tasks.length !== workflow.expectedPasses) {
      deny('WORKFLOW_CHANGED', 'precondition', `Workflow ${workflow.id} differs from approved map`);
    }
  }
  return registry.mapBinding.generation;
}

export function resolveRoom(registry, reference) {
  const key = normalizeAlias(reference);
  if (!key || key.length > 80) deny('INVALID_ROOM_REFERENCE', 'resolution', 'Room reference is empty or too long');
  const slug = registry.aliasOwners[key];
  if (slug) {
    const room = registry.rooms.find((item) => item.slug === slug);
    if (!room.enabled) deny('ROOM_DISABLED', 'resolution', `Room ${slug} is not approved for control`);
    return room;
  }
  const candidates = registry.rooms.filter((room) => room.enabled &&
    [room.slug, room.label, ...room.aliases].some((alias) => normalizeAlias(alias).startsWith(key)));
  if (candidates.length > 1) {
    deny('AMBIGUOUS_ROOM', 'resolution', 'Room reference matches several rooms', {
      candidates: candidates.map(({ slug: room, label }) => ({ room, label })),
    });
  }
  deny('UNKNOWN_ROOM', 'resolution', 'Room reference is not approved');
}

export function resolveRooms(registry, references) {
  if (!Array.isArray(references) || references.length < 1 || references.length > registry.rooms.filter((room) => room.enabled).length) {
    deny('INVALID_ROOM_SET', 'resolution', 'Room count is outside approved map');
  }
  const rooms = references.map((reference) => resolveRoom(registry, reference));
  if (new Set(rooms.map((room) => room.slug)).size !== rooms.length) {
    deny('DUPLICATE_ROOM', 'resolution', 'Several references resolve to the same room');
  }
  return rooms;
}

export function requireCapability(registry, name, write = false) {
  const capability = registry.capabilities.find((item) => item.name === name);
  if (!capability || capability.support === 'disabled' || (write && capability.support !== 'verified')) {
    deny('CAPABILITY_UNSUPPORTED', 'precondition', `Capability ${name} is not verified`);
  }
  return capability;
}

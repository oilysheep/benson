import { deny } from './errors.mjs';
import { deepFreeze } from './immutable.mjs';
import { parseExecuteRequest, parseReadRequest } from './schemas.mjs';
import { authorize, loadPolicy } from './policy.mjs';
import { assertFreshMap, loadRegistry, requireCapability, resolveRoom, resolveRooms } from './registry.mjs';

function validateOptions(settings, options, now) {
  if (!options || typeof options !== 'object' || typeof options.observedAt !== 'string' ||
      !Number.isFinite(Date.parse(options.observedAt)) ||
      now.getTime() - Date.parse(options.observedAt) < 0 ||
      now.getTime() - Date.parse(options.observedAt) > 60_000) {
    deny('OPTIONS_UNVERIFIED', 'precondition', 'Current setting options are unavailable');
  }
  if (settings.suction !== undefined && (!Array.isArray(options.suction) || !options.suction.includes(settings.suction))) {
    deny('SETTING_UNSUPPORTED', 'precondition', 'Suction option is not currently available');
  }
  if (settings.mode !== undefined && (!Array.isArray(options.mode) || !options.mode.includes(settings.mode))) {
    deny('SETTING_UNSUPPORTED', 'precondition', 'Cleaning mode is not currently available');
  }
  if (settings.wetness !== undefined) {
    const range = options.wetness;
    if (!range || !Number.isSafeInteger(range.min) || !Number.isSafeInteger(range.max) ||
        !Number.isSafeInteger(range.step) || range.step < 1 || range.min > range.max ||
        settings.wetness < range.min || settings.wetness > range.max ||
        (settings.wetness - range.min) % range.step !== 0) {
      deny('SETTING_UNSUPPORTED', 'precondition', 'Wetness is outside current verified entity range');
    }
  }
}

export function createDomainCore(registryConfig, policyConfig) {
  const registry = loadRegistry(registryConfig);
  const policy = loadPolicy(policyConfig);

  function prepareRead(rawRequest, trustedIdentity, evidence = {}, now = new Date()) {
    const request = parseReadRequest(rawRequest);
    const authorization = authorize(policy, trustedIdentity, 'read');
    requireCapability(registry, `read_${request.operation}`);
    let room = null;
    let roomInventory = null;
    if (request.operation === 'rooms' || request.operation === 'room_settings') {
      if (request.operation === 'room_settings') room = resolveRoom(registry, request.room);
      assertFreshMap(registry, evidence.map, now);
      if (request.operation === 'rooms') roomInventory = evidence.map.rooms.map((live) => {
        const approved = registry.rooms.find((item) => item.segmentId === live.id);
        if (!approved) deny('ROOM_MAP_MISMATCH', 'precondition', 'Live room lacks a reviewed registry entry');
        return { slug: approved.slug, label: live.name, segmentId: live.id, enabled: approved.enabled };
      });
    }
    return deepFreeze({
      operation: request.operation,
      room: room?.slug ?? null,
      roomInventory,
      capabilityInventory: request.operation === 'capabilities' ? structuredClone(registry.capabilities) : null,
      mapFingerprint: room || request.operation === 'rooms' ? registry.mapFingerprint : null,
      registryVersion: registry.version,
      policyVersion: authorization.policyVersion,
      requesterSubject: authorization.subject,
    });
  }

  function prepareExecute(rawRequest, trustedIdentity, evidence = {}, now = new Date()) {
    const request = parseExecuteRequest(rawRequest);
    const authorization = authorize(policy, trustedIdentity, 'control');
    let rooms = [];
    let workflow = null;
    let underTestId = null;
    let roomTaskSignal = false;
    let mapGeneration = null;
    if (request.operation === 'clean') {
      if (request.target.kind === 'rooms') rooms = resolveRooms(registry, request.target.rooms);
      mapGeneration = assertFreshMap(registry, evidence.map, now);
      if (request.target.kind === 'home') {
        const capability = registry.capabilities.find((item) => item.name === 'clean_home');
        const scope = registry.underTest;
        if (capability?.support !== 'reported' || scope?.capability !== 'clean_home' ||
            scope.subject !== authorization.subject || request.settings !== undefined ||
            now.getTime() >= Date.parse(scope.expiresAt)) {
          deny('CAPABILITY_UNSUPPORTED', 'precondition', 'Full-home cleaning is outside the active canary scope');
        }
        underTestId = scope.id;
      } else if (rooms.length > 1) {
        const capability = registry.capabilities.find((item) => item.name === 'clean_multi_room');
        const verifiedSet = capability?.verifiedRoomSets?.some((set) => set.rooms.length === rooms.length &&
          rooms.every((room) => set.rooms.includes(room.slug)));
        if (!verifiedSet) {
          const scope = registry.underTest;
          if (capability?.support !== 'reported' || scope?.capability !== 'clean_multi_room' ||
              scope.subject !== authorization.subject || request.settings !== undefined ||
              now.getTime() >= Date.parse(scope.expiresAt) ||
              rooms.length !== scope.rooms.length ||
              !rooms.every((room) => scope.rooms.includes(room.slug))) {
            deny('CAPABILITY_UNSUPPORTED', 'precondition', 'Multi-room cleaning is outside the active canary scope');
          }
          underTestId = scope.id;
        }
        roomTaskSignal = true;
      } else {
        const capability = registry.capabilities.find((item) => item.name === 'clean_single_room');
        if (capability?.verifiedRooms?.some((item) => item.room === rooms[0].slug)) {
          roomTaskSignal = true;
        } else {
          const scope = registry.underTest;
          if (capability?.support !== 'reported' || scope?.capability !== 'clean_single_room' ||
              rooms[0].slug !== scope.room || scope.subject !== authorization.subject ||
              request.settings !== undefined || now.getTime() >= Date.parse(scope.expiresAt)) {
            deny('CAPABILITY_UNSUPPORTED', 'precondition', 'Single-room cleaning is not verified or in the active canary scope');
          }
          underTestId = scope.id;
          roomTaskSignal = true;
        }
      }
      if (request.settings !== undefined) {
        const scope = registry.underTest;
        const verifiedSetting = registry.capabilities.find((item) => item.name === 'clean_settings')
          ?.verifiedSettings?.some((item) => request.target.kind === 'rooms' && rooms.length === 1 &&
            roomTaskSignal && rooms[0].slug === item.room &&
            Object.keys(request.settings).length === 1 &&
            request.settings.suction === item.settings.suction);
        const scopedSetting = scope?.capability === 'clean_settings' &&
          registry.capabilities.find((item) => item.name === 'clean_settings')?.support === 'reported' &&
          request.target.kind === 'rooms' && rooms.length === 1 && roomTaskSignal &&
          rooms[0].slug === scope.room && now.getTime() < Date.parse(scope.expiresAt) &&
          Object.keys(request.settings).length === 1 &&
          request.settings.suction === scope.settings.suction;
        if (scopedSetting) underTestId = scope.id;
        else if (!verifiedSetting) requireCapability(registry, 'clean_settings', true);
        validateOptions(request.settings, evidence.options, now);
      }
    } else if (request.operation === 'pause' || request.operation === 'dock') {
      const capability = registry.capabilities.find((item) => item.name === request.operation);
      const scope = registry.underTest;
      mapGeneration = assertFreshMap(registry, evidence.map, now);
      const active = evidence.status?.activeSegments;
      if (!Array.isArray(active) || active.length === 0 || new Set(active).size !== active.length) {
        deny('NO_ACTIVE_TASK', 'precondition', 'One reviewed active task is required');
      }
      rooms = active.map((segment) => registry.rooms.find((item) => item.enabled && item.segmentId === segment));
      if (rooms.some((room) => !room)) deny('CAPABILITY_UNSUPPORTED', 'precondition', 'Active room is not reviewed');
      const verifiedRoom = rooms.length === 1 && capability?.verifiedRooms?.some((item) => item.room === rooms[0].slug);
      const verifiedSet = rooms.length > 1 && capability?.verifiedRoomSets?.some((set) =>
        set.rooms.length === rooms.length && rooms.every((room) => set.rooms.includes(room.slug)));
      const scopeRooms = scope?.rooms ?? (scope?.room ? [scope.room] : []);
      const canary = scope?.capability === request.operation &&
        scopeRooms.length === rooms.length && rooms.every((room) => scopeRooms.includes(room.slug)) &&
        scope.subject === authorization.subject && now.getTime() < Date.parse(scope.expiresAt);
      if (!canary) requireCapability(registry, request.operation, true);
      if (!verifiedRoom && !verifiedSet && !canary) {
        deny('CAPABILITY_UNSUPPORTED', 'precondition', 'Active task is outside reviewed control scope');
      }
      underTestId = canary ? scope.id : null;
      roomTaskSignal = true;
    } else {
      requireCapability(registry, request.operation, true);
    }
    return deepFreeze({
      operation: request.operation,
      targetKind: request.operation === 'clean' ? request.target.kind : null,
      rooms: rooms.map((room) => ({ slug: room.slug, segmentId: room.segmentId })),
      workflowId: workflow?.id ?? null,
      settings: request.settings === undefined ? null : structuredClone(request.settings),
      mapFingerprint: ['clean', 'pause', 'dock'].includes(request.operation) ? registry.mapFingerprint : null,
      mapGeneration,
      registryVersion: registry.version,
      policyVersion: authorization.policyVersion,
      requesterSubject: authorization.subject,
      underTestId,
      ...(request.operation === 'clean' && request.target.kind === 'home' ?
        { homeGeometrySha256: registry.underTest.reviewedGeometrySha256 } : {}),
      roomTaskSignal,
    });
  }

  return Object.freeze({ prepareRead, prepareExecute });
}

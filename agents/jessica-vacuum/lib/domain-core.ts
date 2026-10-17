import Type from 'typebox';
import { decode, freeze } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { deny } from './errors.js';
import { parseReadRequest, parseExecuteRequest, Nonempty, SafeInteger, Positive, type ExecutePlan,
  type Settings, type Room } from './schemas.js';
import { authorize, loadPolicy } from './policy.js';
import { assertFreshMap, loadRegistry, requireCapability, resolveRoom, resolveRooms } from './registry.js';

export interface DomainEvidence { map?: unknown; options?: unknown; status?: unknown }
const OptionsSchema = Type.Object({ observedAt: Nonempty, suction: Type.Optional(Type.Array(Type.String())),
  mode: Type.Optional(Type.Array(Type.String())), wetness: Type.Optional(Type.Object({ min: SafeInteger, max: SafeInteger, step: Positive })) });
const ActiveSchema = Type.Object({ activeSegments: Type.Array(Positive, { minItems: 1, uniqueItems: true }) });
const sameRooms = (scope: readonly string[], rooms: readonly Room[]) => scope.length === rooms.length && rooms.every(room => scope.includes(room.slug));
function validateOptions(settings: Settings, raw: unknown, now: Date): void {
  let options;
  try { options = decode(OptionsSchema, raw, 'options_invalid'); }
  catch { return deny('OPTIONS_UNVERIFIED', 'precondition', 'Current setting options are unavailable'); }
  const age = now.getTime() - Date.parse(options.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 60_000) deny('OPTIONS_UNVERIFIED', 'precondition', 'Current setting options are unavailable');
  if ((settings.suction !== undefined && !options.suction?.includes(settings.suction)) ||
      (settings.mode !== undefined && !options.mode?.includes(settings.mode))) deny('SETTING_UNSUPPORTED', 'precondition', 'Setting option is not currently available');
  if (settings.wetness !== undefined) {
    const range = options.wetness;
    if (!range || range.min > range.max || settings.wetness < range.min || settings.wetness > range.max ||
        (settings.wetness - range.min) % range.step !== 0) deny('SETTING_UNSUPPORTED', 'precondition', 'Wetness is outside current verified entity range');
  }
}
export function createDomainCore(registryConfig: unknown, policyConfig: unknown) {
  const registry = loadRegistry(registryConfig), policy = loadPolicy(policyConfig);
  function prepareRead(raw: unknown, identity: unknown, evidence: DomainEvidence = {}, now = new Date()) {
    const request = parseReadRequest(raw), authorization = authorize(policy, identity, 'read');
    requireCapability(registry, `read_${request.operation}`);
    const room = request.operation === 'room_settings' ? resolveRoom(registry, request.room) : null;
    let inventory: { slug: string; label: string; segmentId: number; enabled: boolean }[] | null = null;
    if (request.operation === 'rooms' || room) {
      assertFreshMap(registry, evidence.map, now);
      if (request.operation === 'rooms') {
        const map = decode(Type.Object({ rooms: Type.Array(Type.Object({ id: Positive, name: Nonempty })) }), evidence.map, 'map_invalid');
        inventory = map.rooms.map(live => {
          const approved = registry.rooms.find(item => item.segmentId === live.id);
          if (!approved) deny('ROOM_MAP_MISMATCH', 'precondition', 'Live room lacks a reviewed registry entry');
          return { slug: approved.slug, label: live.name, segmentId: live.id, enabled: approved.enabled };
        });
      }
    }
    return freeze({ operation: request.operation, room: room?.slug ?? null, roomInventory: inventory,
      capabilityInventory: request.operation === 'capabilities' ? structuredClone(registry.capabilities) : null,
      mapFingerprint: room || request.operation === 'rooms' ? registry.mapFingerprint : null,
      registryVersion: registry.version, policyVersion: authorization.policyVersion, requesterSubject: authorization.subject });
  }
  function prepareExecute(raw: unknown, identity: unknown, evidence: DomainEvidence = {}, now = new Date()): ExecutePlan {
    const request = parseExecuteRequest(raw), authorization = authorize(policy, identity, 'control');
    const scope = registry.underTest;
    let rooms: Room[] = [], underTestId: string | null = null, roomTaskSignal = false, mapGeneration: string | null = null;
    const liveScope = scope !== null && now.getTime() < Date.parse(scope.expiresAt);
    if (request.operation === 'clean') {
      if (request.target.kind === 'rooms') rooms = resolveRooms(registry, request.target.rooms);
      mapGeneration = assertFreshMap(registry, evidence.map, now);
      if (request.target.kind === 'home') {
        if (!liveScope || scope?.capability !== 'clean_home' || scope.subject !== authorization.subject ||
            request.settings !== undefined || registry.capabilities.find(cap => cap.name === 'clean_home')?.support !== 'reported') {
          deny('CAPABILITY_UNSUPPORTED', 'precondition', 'Full-home cleaning is outside the active canary scope');
        }
        underTestId = scope.id;
      } else {
        const multi = rooms.length > 1, capName = multi ? 'clean_multi_room' : 'clean_single_room';
        const cap = registry.capabilities.find(item => item.name === capName), first = rooms[0];
        const verified = multi ? cap?.verifiedRoomSets?.some(set => sameRooms(set.rooms, rooms)) :
          first !== undefined && cap?.verifiedRooms?.some(item => item.room === first.slug);
        if (!verified) {
          const scoped = liveScope && scope?.capability === capName && cap?.support === 'reported' &&
            'subject' in scope && scope.subject === authorization.subject && request.settings === undefined &&
            ('rooms' in scope ? sameRooms(scope.rooms, rooms) : 'room' in scope && rooms.length === 1 && first?.slug === scope.room);
          if (!scoped || !scope) deny('CAPABILITY_UNSUPPORTED', 'precondition', 'Cleaning target is not verified or in the active canary scope');
          underTestId = scope.id;
        }
        roomTaskSignal = true;
      }
      if (request.settings !== undefined) {
        const first = rooms[0];
        const settingMatch = (room: string, suction: string) => request.target.kind === 'rooms' && rooms.length === 1 &&
          roomTaskSignal && first?.slug === room && Object.keys(request.settings ?? {}).length === 1 && request.settings?.suction === suction;
        const verified = registry.capabilities.find(cap => cap.name === 'clean_settings')?.verifiedSettings?.some(item => settingMatch(item.room, item.settings.suction));
        const scoped = liveScope && scope?.capability === 'clean_settings' &&
          registry.capabilities.find(cap => cap.name === 'clean_settings')?.support === 'reported' && settingMatch(scope.room, scope.settings.suction);
        if (scoped && scope) underTestId = scope.id;
        else if (!verified) requireCapability(registry, 'clean_settings', true);
        validateOptions(request.settings, evidence.options, now);
      }
    } else if (request.operation === 'pause' || request.operation === 'dock') {
      mapGeneration = assertFreshMap(registry, evidence.map, now);
      let status;
      try { status = decode(ActiveSchema, evidence.status, 'active_invalid'); }
      catch { return deny('NO_ACTIVE_TASK', 'precondition', 'One reviewed active task is required'); }
      rooms = status.activeSegments.map(segment => {
        const room = registry.rooms.find(item => item.enabled && item.segmentId === segment);
        if (!room) deny('CAPABILITY_UNSUPPORTED', 'precondition', 'Active room is not reviewed'); return room;
      });
      const cap = registry.capabilities.find(item => item.name === request.operation), first = rooms[0];
      const verified = rooms.length === 1 ? cap?.verifiedRooms?.some(item => item.room === first?.slug) : cap?.verifiedRoomSets?.some(set => sameRooms(set.rooms, rooms));
      const canary = liveScope && scope?.capability === request.operation && 'subject' in scope && scope.subject === authorization.subject &&
        ('rooms' in scope ? sameRooms(scope.rooms, rooms) : 'room' in scope && sameRooms([scope.room], rooms));
      if (!canary) requireCapability(registry, request.operation, true);
      if (!verified && !canary) deny('CAPABILITY_UNSUPPORTED', 'precondition', 'Active task is outside reviewed control scope');
      underTestId = canary && scope ? scope.id : null; roomTaskSignal = true;
    } else requireCapability(registry, request.operation, true);
    return freeze({ operation: request.operation, targetKind: request.operation === 'clean' ? request.target.kind : null,
      rooms: rooms.map(({ slug, segmentId }) => ({ slug, segmentId })), workflowId: null,
      settings: request.operation === 'clean' && request.settings !== undefined ? structuredClone(request.settings) : null,
      mapFingerprint: ['clean', 'pause', 'dock'].includes(request.operation) ? registry.mapFingerprint : null,
      mapGeneration, registryVersion: registry.version, policyVersion: authorization.policyVersion, requesterSubject: authorization.subject,
      underTestId, ...(request.operation === 'clean' && request.target.kind === 'home' && scope?.capability === 'clean_home' ?
        { homeGeometrySha256: scope.reviewedGeometrySha256 } : {}), roomTaskSignal });
  }
  return Object.freeze({ prepareRead, prepareExecute });
}

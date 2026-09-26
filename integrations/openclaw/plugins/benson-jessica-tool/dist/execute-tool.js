import canonicalRegistry from '../../../../../agents/jessica-vacuum/config/registry.v1.json' with { type: 'json' };
import canonicalPolicy from '../../../../../agents/jessica-vacuum/config/policy.v1.json' with { type: 'json' };
import { createHaCanaryDriver } from '../../../../../agents/jessica-vacuum/lib/ha-control.mjs';
import { DomainError } from '../../../../../agents/jessica-vacuum/lib/errors.mjs';
import { authorize, loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.mjs';
import { loadRegistry } from '../../../../../agents/jessica-vacuum/lib/registry.mjs';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.mjs';
import { EXECUTE_OPERATIONS } from '../../../../../agents/jessica-vacuum/lib/schemas.mjs';
import { assertRosterPolicyAgreement, loadTrustedRoutes, resolveTrustedIdentity } from './identity.js';
import { createJessicaExecutor } from './executor.js';


function failure(operation, error, now) {
  const known = error instanceof DomainError;
  return validateResult({
    schemaVersion: '1', status: 'failure', domain: 'jessica-vacuum', operation, verified: false,
    data: null, warnings: [], pendingContext: null,
    error: { code: known ? error.code : 'EXECUTION_UNAVAILABLE',
      stage: known ? error.stage : 'precondition', retryable: false, retryMode: 'none',
      sideEffects: 'none', message: known ? error.message : 'Jessica canary execution is unavailable' },
  }, null, now);
}

export function createJessicaExecuteToolFactory({
  jsonResult, createStore,
  registryConfig = structuredClone(canonicalRegistry),
  policyConfig = structuredClone(canonicalPolicy),
  roster = loadTrustedRoutes(),
  driverFactory = createHaCanaryDriver,
  clock = () => new Date(),
} = {}) {
  if (typeof jsonResult !== 'function' || typeof createStore !== 'function') {
    throw new Error('JSON result and native state store are required');
  }
  const registry = loadRegistry(registryConfig);
  const policy = loadPolicy(policyConfig);
  assertRosterPolicyAgreement(roster, policy);
  const verifiedRooms = registry.capabilities.find((item) => item.name === 'clean_single_room')?.verifiedRooms ?? [];
  const canaryRoom = registry.underTest?.capability === 'clean_single_room' ? registry.underTest.room : null;
  const cleanRoomSlugs = [...new Set([...verifiedRooms.map((item) => item.room),
    ...(canaryRoom === null ? [] : [canaryRoom])])];
  if (!cleanRoomSlugs.length) throw new Error('At least one reviewed room scope is required');
  const cleanRooms = cleanRoomSlugs.map((slug) => registry.rooms.find((item) => item.slug === slug));
  if (cleanRooms.some((room) => !room?.enabled)) throw new Error('Reviewed room scope is unavailable');
  const multiCanaryRooms = registry.underTest?.capability === 'clean_multi_room' ? registry.underTest.rooms : null;
  const homeCanary = registry.underTest?.capability === 'clean_home';
  const verifiedMultiSets = registry.capabilities.find((item) => item.name === 'clean_multi_room')?.verifiedRoomSets ?? [];
  const allowedMultiSets = [...verifiedMultiSets.map((item) => item.rooms),
    ...(multiCanaryRooms === null ? [] : [multiCanaryRooms])];
  const settingScopes = [...(registry.capabilities.find((item) => item.name === 'clean_settings')?.verifiedSettings ?? [])];
  if (registry.underTest?.capability === 'clean_settings') {
    settingScopes.push({ room: registry.underTest.room, settings: registry.underTest.settings });
  }
  const scopedControlOperation = ['pause', 'dock'].includes(registry.underTest?.capability) ?
    registry.underTest.capability : null;
  const verifiedControlOperations = ['pause', 'dock'].filter((operation) =>
    registry.capabilities.find((item) => item.name === operation)?.support === 'verified');
  const controlOperations = [...new Set([...verifiedControlOperations,
    ...(scopedControlOperation === null ? [] : [scopedControlOperation])])];
  const suctionValues = [...new Set(settingScopes.map((scope) => scope.settings.suction))];
  const cleanParameters = {
    type: 'object', properties: {
      operation: { const: 'clean' },
      target: { type: 'object', properties: {
        kind: { const: 'rooms' },
        rooms: { type: 'array', items: { enum: cleanRoomSlugs }, minItems: 1, maxItems: Math.max(1, ...allowedMultiSets.map((set) => set.length)) },
      }, required: ['kind', 'rooms'], additionalProperties: false },
      ...(suctionValues.length === 0 ? {} : { settings: { type: 'object', properties: {
        suction: suctionValues.length === 1 ? { const: suctionValues[0] } : { enum: suctionValues },
      }, required: ['suction'], additionalProperties: false } }),
    }, required: ['operation', 'target'],
    additionalProperties: false,
  };
  const homeParameters = {
    type: 'object', properties: {
      operation: { const: 'clean' },
      target: { type: 'object', properties: { kind: { const: 'home' } },
        required: ['kind'], additionalProperties: false },
    }, required: ['operation', 'target'], additionalProperties: false,
  };
  const parameters = Object.freeze({
    oneOf: [cleanParameters, ...(homeCanary ? [homeParameters] : []), ...controlOperations.map((operation) => ({
      type: 'object', properties: { operation: { const: operation } },
      required: ['operation'], additionalProperties: false,
    }))],
  });

  return (toolContext) => {
    if (toolContext.agentId !== 'jessica-vacuum') return null;
    return {
      name: 'jessica_execute', label: 'Jessica room cleaning',
      description: `Cleaning start for reviewed rooms: ${cleanRooms.map((room) => room.label).join(', ')}.` +
        (settingScopes.length === 0 ? ' No settings.' : ' Only an explicitly listed reviewed setting variant may be used.') +
        (canaryRoom === null ? '' : ` The ${registry.rooms.find((room) => room.slug === canaryRoom).label} variant is one Oren-only canary.`) +
        (multiCanaryRooms === null ? '' : ` One Oren-only multi-room canary is limited to ${multiCanaryRooms.map((slug) => registry.rooms.find((room) => room.slug === slug).label).join(' and ')} without settings or order promise.`) +
        (homeCanary ? ' One Oren-only, one-dispatch whole-home canary is available without settings; device and reviewed exclusions are checked before and after start.' : '') +
        (verifiedMultiSets.length === 0 ? '' : ` Verified unordered multi-room cleaning is limited to ${verifiedMultiSets.map((set) => set.rooms.join(' + ')).join('; ')} without settings or order promise.`) +
        (verifiedControlOperations.length === 0 ? '' :
          ` Verified current-task ${verifiedControlOperations.join(' and ')} control is available only for its reviewed active-room scope.`) +
        (scopedControlOperation === null ? '' :
          ` One reviewed ${scopedControlOperation} canary is available for Oren on its reviewed active-room scope.`),
      parameters, executionMode: 'sequential',
      async execute(_toolCallId, rawRequest) {
        const operation = EXECUTE_OPERATIONS.includes(rawRequest?.operation) ? rawRequest.operation : null;
        let executor;
        let identity;
        try {
          if (typeof toolContext.sessionKey !== 'string' ||
              !toolContext.sessionKey.startsWith('agent:jessica-vacuum:subagent:') ||
              toolContext.sessionKey.length > 160) {
            throw new DomainError('EPOCH_UNTRUSTED', 'identity', 'Fresh native child session is unavailable');
          }
          identity = resolveTrustedIdentity(toolContext, roster);
          authorize(policy, identity, 'control');
          let expectedSegments = [];
          let canarySuction = null;
          if (rawRequest?.operation === 'clean' && rawRequest.target?.kind === 'rooms' &&
              Array.isArray(rawRequest.target.rooms)) {
            if (rawRequest.target.rooms.length === 1) {
              const requested = cleanRooms.find((item) => item.slug === rawRequest.target.rooms[0]);
              if (requested) expectedSegments = [requested.segmentId];
              const setting = settingScopes.find((scope) => scope.room === requested?.slug &&
                rawRequest.settings && Object.keys(rawRequest.settings).length === 1 &&
                rawRequest.settings.suction === scope.settings.suction);
              canarySuction = setting?.settings.suction ?? null;
            } else if (allowedMultiSets.some((set) => rawRequest.target.rooms.length === set.length &&
                rawRequest.target.rooms.every((slug) => set.includes(slug)))) {
              expectedSegments = rawRequest.target.rooms.map((slug) =>
                cleanRooms.find((item) => item.slug === slug).segmentId);
            }
          } else if (controlOperations.includes(rawRequest?.operation)) {
            const capability = registry.capabilities.find((item) => item.name === rawRequest.operation);
            const controlRooms = [...new Set([...(capability?.verifiedRooms?.map((item) => item.room) ?? []),
              ...(capability?.verifiedRoomSets?.flatMap((item) => item.rooms) ?? []),
              ...(scopedControlOperation === rawRequest.operation ?
                (registry.underTest.rooms ?? [registry.underTest.room]) : [])])];
            expectedSegments = controlRooms.map((slug) => registry.rooms.find((item) => item.slug === slug).segmentId);
          }
          executor = createJessicaExecutor({ registryConfig, policyConfig, store: createStore(),
            driver: driverFactory({ expectedSegments,
              homeCanary: homeCanary && rawRequest?.operation === 'clean' && rawRequest.target?.kind === 'home',
              canarySuction,
              controlOperation: controlOperations.includes(rawRequest?.operation) ? rawRequest.operation : null,
              controlCanarySegments: scopedControlOperation === rawRequest?.operation && registry.underTest.rooms ?
                registry.underTest.rooms.map((slug) => registry.rooms.find((item) => item.slug === slug).segmentId) : null,
              controlVerifiedSets: rawRequest?.operation === 'pause' ?
                (registry.capabilities.find((item) => item.name === 'pause')?.verifiedRoomSets ?? []).map((set) =>
                  set.rooms.map((slug) => registry.rooms.find((item) => item.slug === slug).segmentId)) : [] }), clock });
        } catch (error) {
          return jsonResult(failure(operation, error, clock()));
        }
        return jsonResult(await executor.execute(rawRequest, {
          identity, requestEpoch: toolContext.sessionKey,
        }));
      },
    };
  };
}

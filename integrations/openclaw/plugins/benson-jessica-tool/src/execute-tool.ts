import type { OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';
import { createJessicaExecutor, type ExecutionContext } from '../../../../../agents/jessica-vacuum/lib/executor.js';
import { loadRegistry } from '../../../../../agents/jessica-vacuum/lib/registry.js';
import { loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { assertRosterPolicyAgreement, type FamilyRoutes } from '../../../../../agents/jessica-vacuum/lib/identity.js';
import type { Result } from '../../../../../agents/jessica-vacuum/lib/results.js';
import { assertInvocationCurrent } from '../../../benson-routing/core/invocation.js';
import { synchronous } from '../../../benson-routing/core/value.js';
import { parseExecuteRequest } from '../../../../../agents/jessica-vacuum/lib/schemas.js';
import { createHaDevice } from '../../../../../agents/jessica-vacuum/lib/adapters/ha-device.js';
import type { HaTransport } from '../../../../../agents/jessica-vacuum/lib/adapters/ha-transport.js';

type Tool = Exclude<NonNullable<ReturnType<OpenClawPluginToolFactory<2>['create']>>, unknown[]>;
type ToolResult = Awaited<ReturnType<Tool['execute']>>;

/** Migrated existing domain tool. The host supplies original mutation custody,
 * never a read admission or an epoch inferred from the child session/model.
 * The existing executor owns authorization, state, dispatch and verification.
 */
type ExecutorOptions = Parameters<typeof createJessicaExecutor>[0];
export function createJessicaExecuteToolFactory(options: Omit<ExecutorOptions, 'driver'> & (
  { driver: ExecutorOptions['driver']; transport?: never } | { driver?: never; transport: HaTransport }
) & {
  roster: FamilyRoutes;
  source: ExecutionContext;
  jsonResult(value: Result, assertCompletion: (args: unknown, value: unknown) => void, callId: string): ToolResult;
}): OpenClawPluginToolFactory<2>['create'] {
  const registry = loadRegistry(options.registryConfig), policy = loadPolicy(options.policyConfig);
  if ((options.driver === undefined) === (options.transport === undefined)) throw new Error('Jessica requires one explicit device adapter');
  const fixedExecutor = options.driver ? createJessicaExecutor({ ...options, driver: options.driver }) : undefined;
  assertRosterPolicyAgreement(options.roster, policy);
  const scope = registry.underTest;
  const rooms = [...new Set([...(registry.capabilities.find(item => item.name === 'clean_single_room')?.verifiedRooms ?? []).map(item => item.room),
    ...(scope?.capability === 'clean_single_room' ? [scope.room] : [])])];
  if (!rooms.length || rooms.some(slug => !registry.rooms.some(room => room.slug === slug && room.enabled))) {
    throw new Error('Jessica reviewed room scope is unavailable');
  }
  const sets = [...(registry.capabilities.find(item => item.name === 'clean_multi_room')?.verifiedRoomSets ?? []).map(item => item.rooms),
    ...(scope?.capability === 'clean_multi_room' ? [scope.rooms] : [])];
  const settings = [...(registry.capabilities.find(item => item.name === 'clean_settings')?.verifiedSettings ?? []),
    ...(scope?.capability === 'clean_settings' ? [scope] : [])];
  const suction = [...new Set(settings.map(item => item.settings.suction))];
  const controls = ['pause', 'dock'].filter(operation => registry.capabilities.some(item => item.name === operation && item.support === 'verified') || scope?.capability === operation);
  const parameters = { oneOf: [{ type: 'object', properties: {
    operation: { const: 'clean' }, target: { type: 'object', properties: {
      kind: { const: 'rooms' }, rooms: { type: 'array', items: { enum: rooms }, minItems: 1, maxItems: Math.max(1, ...sets.map(set => set.length)) },
    }, required: ['kind', 'rooms'], additionalProperties: false },
    ...(suction.length ? { settings: { type: 'object', properties: { suction: { enum: suction } }, required: ['suction'], additionalProperties: false } } : {}),
  }, required: ['operation', 'target'], additionalProperties: false },
  ...(scope?.capability === 'clean_home' ? [{ type: 'object', properties: { operation: { const: 'clean' },
    target: { type: 'object', properties: { kind: { const: 'home' } }, required: ['kind'], additionalProperties: false } }, required: ['operation', 'target'], additionalProperties: false }] : []),
  ...controls.map(operation => ({ type: 'object', properties: { operation: { const: operation } }, required: ['operation'], additionalProperties: false }))] };
  // This narrows the transport's dispatch envelope; the existing executor still
  // owns live authorization, reviewed capability/expiry, state and verification.
  function driverFor(raw: unknown) {
    if (!options.transport) throw new Error('Jessica transport is unavailable');
    const request = parseExecuteRequest(raw);
    const segments = (slugs: readonly string[]) => slugs.map(slug => {
      const room = registry.rooms.find(item => item.slug === slug && item.enabled);
      if (!room) throw new Error('Jessica dispatch room is unavailable');
      return room.segmentId;
    });
    if (request.operation === 'clean') {
      if (request.target.kind === 'home') {
        if (scope?.capability !== 'clean_home' || request.settings !== undefined) throw new Error('Jessica home scope is unavailable');
        return createHaDevice(options.transport, { segments: [], home: true }, options.clock);
      }
      const requested = request.target.rooms;
      if (!requested.length || new Set(requested).size !== requested.length || requested.some(slug => !rooms.includes(slug)) ||
        requested.length > 1 && !sets.some(set => set.length === requested.length && requested.every(slug => set.includes(slug)))) {
        throw new Error('Jessica dispatch room scope is unavailable');
      }
      const suction = request.settings?.suction;
      if (request.settings !== undefined && (requested.length !== 1 || Object.keys(request.settings).length !== 1 ||
        !settings.some(item => item.room === requested[0] && item.settings.suction === suction))) throw new Error('Jessica setting scope is unavailable');
      return createHaDevice(options.transport, { segments: segments(requested), ...(suction !== undefined ? { suction } : {}) }, options.clock);
    }
    if ((request.operation !== 'pause' && request.operation !== 'dock') || !controls.includes(request.operation)) throw new Error('Jessica control scope is unavailable');
    const cap = registry.capabilities.find(item => item.name === request.operation);
    const pauseSets = request.operation === 'pause' ? [...(cap?.verifiedRoomSets ?? []).map(item => item.rooms),
      ...(scope?.capability === 'pause' && 'rooms' in scope ? [scope.rooms] : [])] : [];
    const slugs = [...new Set([...(cap?.verifiedRooms ?? []).map(item => item.room), ...pauseSets.flat(),
      ...(scope?.capability === request.operation ? ['room' in scope ? scope.room : undefined].filter((item): item is string => !!item) : [])])];
    return createHaDevice(options.transport, { segments: segments(slugs), control: request.operation,
      ...(pauseSets.length ? { pauseSets: pauseSets.map(segments) } : {}) }, options.clock);
  }
  // Capture immutable input identity once, independently of model arguments.
  const identity: unknown = structuredClone(options.source.identity), requestEpoch = options.source.requestEpoch;
  const sourceAuthority = options.source.authority;
  return context => {
    if (context.agentId !== 'jessica-vacuum' || typeof context.assertInvocationCurrent !== 'function' ||
      !context.sessionKey?.startsWith('agent:jessica-vacuum:subagent:')) return null;
    return { name: 'jessica_execute', label: 'Jessica room cleaning',
      description: 'Execute reviewed Jessica cleaning or active-task control. Domain policy and effect verification remain mandatory.',
      parameters, executionMode: 'sequential',
      async execute(callId, raw, signal) {
        const authority = { signal: AbortSignal.any([sourceAuthority.signal, ...(signal ? [signal] : [])]),
          assertCurrent() {
            synchronous(context.assertInvocationCurrent(), 'jessica_execute_authority_must_be_synchronous');
            assertInvocationCurrent(sourceAuthority);
          } };
        assertInvocationCurrent(authority);
        const executor = fixedExecutor ?? createJessicaExecutor({ ...options, driver: driverFor(raw) });
        const { result, assertCompletion } = await executor.executeWithCompletion(raw, { identity, requestEpoch, authority });
        assertInvocationCurrent(authority);
        const serialized = synchronous(options.jsonResult(result, (args, value) => { assertInvocationCurrent(sourceAuthority); assertCompletion(args, value); }, callId), 'jessica_execute_serialization_must_be_synchronous');
        assertInvocationCurrent(authority);
        return serialized;
      } };
  };
}

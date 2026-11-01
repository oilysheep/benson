import type { OpenClawPluginToolFactory } from 'openclaw/plugin-sdk/plugin-entry';
import { createJessicaExecutor, type ExecutionContext } from '../../../../../agents/jessica-vacuum/lib/executor.js';
import { loadRegistry } from '../../../../../agents/jessica-vacuum/lib/registry.js';
import { loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.js';
import { assertRosterPolicyAgreement, type FamilyRoutes } from '../../../../../agents/jessica-vacuum/lib/identity.js';
import type { Result } from '../../../../../agents/jessica-vacuum/lib/results.js';
import { assertInvocationCurrent } from '../../../benson-routing/core/invocation.js';
import { synchronous } from '../../../benson-routing/core/value.js';

type Tool = Exclude<NonNullable<ReturnType<OpenClawPluginToolFactory<2>['create']>>, unknown[]>;
type ToolResult = Awaited<ReturnType<Tool['execute']>>;

/** Migrated existing domain tool. The host supplies original mutation custody,
 * never a read admission or an epoch inferred from the child session/model.
 * The existing executor owns authorization, state, dispatch and verification.
 */
export function createJessicaExecuteToolFactory(options: Parameters<typeof createJessicaExecutor>[0] & {
  roster: FamilyRoutes;
  source: ExecutionContext;
  jsonResult(value: Result): ToolResult;
}): OpenClawPluginToolFactory<2>['create'] {
  const registry = loadRegistry(options.registryConfig), policy = loadPolicy(options.policyConfig);
  const executor = createJessicaExecutor(options);
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
  // Capture immutable input identity once, independently of model arguments.
  const identity: unknown = structuredClone(options.source.identity), requestEpoch = options.source.requestEpoch;
  const sourceAuthority = options.source.authority;
  return context => {
    if (context.agentId !== 'jessica-vacuum' || typeof context.assertInvocationCurrent !== 'function' ||
      !context.sessionKey?.startsWith('agent:jessica-vacuum:subagent:')) return null;
    return { name: 'jessica_execute', label: 'Jessica room cleaning',
      description: 'Execute reviewed Jessica cleaning or active-task control. Domain policy and effect verification remain mandatory.',
      parameters, executionMode: 'sequential',
      async execute(_callId, raw, signal) {
        const authority = { signal: AbortSignal.any([sourceAuthority.signal, ...(signal ? [signal] : [])]),
          assertCurrent() {
            synchronous(context.assertInvocationCurrent(), 'jessica_execute_authority_must_be_synchronous');
            assertInvocationCurrent(sourceAuthority);
          } };
        assertInvocationCurrent(authority);
        const result = await executor.execute(raw, { identity, requestEpoch, authority });
        assertInvocationCurrent(authority);
        const serialized = synchronous(options.jsonResult(result), 'jessica_execute_serialization_must_be_synchronous');
        assertInvocationCurrent(authority);
        return serialized;
      } };
  };
}

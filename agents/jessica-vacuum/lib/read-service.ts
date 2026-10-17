import { assertInvocationCurrent } from '../../../integrations/openclaw/benson-routing/core/invocation.js';
import { createDomainCore } from './domain-core.js';
import { DomainError } from './errors.js';
import { projectMap, projectStatus, projectHealth, projectSensorCollection, type HaEntity } from './ha-read.js';
import { validateResult, type ReadData } from './results.js';
import { parseReadRequest, READ_OPERATIONS } from './schemas.js';
import { plain } from '../../../integrations/openclaw/benson-routing/core/value.js';
import type { InvocationAuthority } from './ports.js';
import type { OperationState } from './operation-state.js';
import { authorize, loadPolicy } from './policy.js';
export interface JessicaReadSource {
  readState(authority: InvocationAuthority): Promise<{ state: HaEntity; observedAt: string }>;
  readSensors(authority: InvocationAuthority): Promise<ReadonlyMap<string, HaEntity>>;
}
export function createJessicaReader({ registryConfig, policyConfig, source, operationState, clock = () => new Date() }:
  { registryConfig: unknown; policyConfig: unknown; source: JessicaReadSource; operationState?: OperationState; clock?: () => Date }) {
  const core = createDomainCore(registryConfig, policyConfig);
  const policy = loadPolicy(policyConfig);
  return async (raw: unknown, identity: unknown, authority: InvocationAuthority) => {
    const current = () => { authority.signal.throwIfAborted(); assertInvocationCurrent(authority); };
    let operation = plain(raw) ? READ_OPERATIONS.find(op => op === raw.operation) ?? null : null;
    try {
      current(); const request = parseReadRequest(raw); operation = request.operation;
      // Authorize before any I/O, including the map read needed for room resolution.
      authorize(policy, identity, 'read');
      if (request.operation !== 'rooms' && request.operation !== 'room_settings') core.prepareRead(request, identity, {}, clock());
      let data: ReadData;
      switch (request.operation) {
        case 'status': {
          const { state, observedAt } = await source.readState(authority); current();
          const status = projectStatus(state, observedAt), sensors = await source.readSensors(authority); current();
          data = { ...status, sourceKind: 'ha_cached_entity', locationMeaning: state.state === 'docked' ? 'map_localization' : 'reported_current_segment', health: projectHealth(sensors, clock().toISOString()) }; break;
        }
        case 'rooms': {
          const { state, observedAt } = await source.readState(authority); current();
          const plan = core.prepareRead(request, identity, { map: projectMap(state, observedAt) }, clock());
          if (!plan.mapFingerprint || !plan.roomInventory) throw new Error('Jessica room inventory unavailable');
          data = { kind: 'rooms', observedAt, sourceUpdatedAt: state.last_updated ?? null, freshness: 'fresh', mapFingerprint: plan.mapFingerprint, rooms: plan.roomInventory }; break;
        }
        case 'capabilities': {
          const plan = core.prepareRead(request, identity, {}, clock());
          data = { kind: 'capabilities', observedAt: clock().toISOString(), sourceUpdatedAt: null, freshness: 'fresh', capabilities: plan.capabilityInventory ?? [], inventoryScope: 'accepted_registry_only', liveAvailability: 'not_checked' }; break;
        }
        case 'maintenance': case 'statistics': {
          const sensors = await source.readSensors(authority); current(); const observedAt = clock().toISOString();
          const collection = projectSensorCollection(sensors, request.operation, observedAt);
          data = request.operation === 'maintenance' ? { kind: 'maintenance', observedAt, sourceUpdatedAt: null, freshness: 'fresh', items: collection } :
            { kind: 'statistics', observedAt, sourceUpdatedAt: null, freshness: 'fresh', metrics: collection }; break;
        }
        case 'operation_status': {
          if (!operationState) throw new DomainError('READ_UNAVAILABLE', 'verification', 'Native operation store is unavailable');
          const found = await operationState.operation(request.operationId); current();
          if (!found) throw new DomainError('OPERATION_NOT_FOUND', 'precondition', 'No indexed Jessica operation matches this reference');
          const result = found.kind === 'terminal' ? found.value : null, active = found.kind === 'active' ? found.value : null;
          const action = result?.data && 'outcome' in result.data ? result.data : null;
          data = { kind: 'operation_status', observedAt: clock().toISOString(), sourceUpdatedAt: null, freshness: 'fresh', operationId: request.operationId,
            outcome: action?.outcome ?? (result?.error?.sideEffects === 'none' ? 'not_sent' : active?.phase === 'prepared' ? 'preparing' : 'unknown'),
            dispatch: action?.dispatch ?? (result?.error?.sideEffects === 'none' || active?.phase === 'prepared' ? 'not_attempted' : 'unknown'), observation: action?.observation ?? active?.lastObservation ?? null }; break;
        }
        case 'room_settings': throw new DomainError('CAPABILITY_UNSUPPORTED', 'precondition', 'Read operation is not enabled');
      }
      current(); return validateResult({ schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation, verified: true, data, warnings: [], error: null, pendingContext: null }, null, clock());
    } catch (error) {
      current(); const known = error instanceof DomainError;
      return validateResult({ schemaVersion: '1', status: 'failure', domain: 'jessica-vacuum', operation, verified: false, data: null, warnings: [], pendingContext: null,
        error: { code: known ? error.code : 'READ_UNAVAILABLE', stage: known ? error.stage : 'verification', retryable: !known,
          retryMode: known ? 'none' : 'read_only', sideEffects: 'none', message: known ? error.message : 'Jessica read is unavailable' } }, null, clock());
    }
  };
}

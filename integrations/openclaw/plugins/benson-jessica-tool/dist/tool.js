import canonicalRegistry from '../../../../../agents/jessica-vacuum/config/registry.v1.json' with { type: 'json' };
import canonicalPolicy from '../../../../../agents/jessica-vacuum/config/policy.v1.json' with { type: 'json' };
import { createDomainCore } from '../../../../../agents/jessica-vacuum/lib/domain-core.mjs';
import { DomainError } from '../../../../../agents/jessica-vacuum/lib/errors.mjs';
import { readVacuumState, readJessicaSensors, projectMap, projectStatus, projectHealth, projectSensorCollection } from '../../../../../agents/jessica-vacuum/lib/ha-read.mjs';
import { authorize, loadPolicy } from '../../../../../agents/jessica-vacuum/lib/policy.mjs';
import { validateResult } from '../../../../../agents/jessica-vacuum/lib/results.mjs';
import { parseReadRequest, READ_OPERATIONS } from '../../../../../agents/jessica-vacuum/lib/schemas.mjs';
import { assertRosterPolicyAgreement, loadTrustedRoutes, resolveTrustedIdentity } from './identity.js';
import { createOperationState } from './operation-state.js';

const envelope = (operation, status, verified, data, error = null) => ({
  schemaVersion: '1', status, domain: 'jessica-vacuum', operation, verified,
  data, warnings: [], error, pendingContext: null,
});

export function createJessicaReadToolFactory({
  jsonResult,
  createStore,
  registryConfig = structuredClone(canonicalRegistry),
  policyConfig = structuredClone(canonicalPolicy),
  roster = loadTrustedRoutes(),
  readState = readVacuumState,
  readSensors = readJessicaSensors,
  clock = () => new Date(),
} = {}) {
  if (typeof jsonResult !== 'function') throw new Error('jsonResult is required');
  const policy = loadPolicy(policyConfig);
  assertRosterPolicyAgreement(roster, policy);
  const core = createDomainCore(registryConfig, policyConfig);
  const allowedReads = ['status', 'rooms', 'capabilities', 'maintenance', 'statistics', 'operation_status']
    .filter((operation) => registryConfig.capabilities.some((cap) =>
      cap.name === `read_${operation}` && cap.support !== 'disabled'));
  const parameters = Object.freeze(allowedReads.includes('operation_status') ? { oneOf: [
    ...allowedReads.filter((operation) => operation !== 'operation_status').map((operation) => ({
      type: 'object', properties: { operation: { const: operation } },
      required: ['operation'], additionalProperties: false,
    })),
    ...(allowedReads.includes('operation_status') ? [{
      type: 'object', properties: { operation: { const: 'operation_status' },
        operationId: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['operation', 'operationId'], additionalProperties: false,
    }] : []),
  ] } : { type: 'object',
    properties: { operation: { type: 'string', enum: allowedReads } },
    required: ['operation'], additionalProperties: false });

  return (toolContext) => {
    if (toolContext.agentId !== 'jessica-vacuum') return null;
    return {
      name: 'jessica_read', label: 'Jessica read',
      description: 'Read Jessica status, rooms, accepted capabilities, maintenance, lifetime statistics, or an enabled known dispatch operation. No device action.',
      parameters,
      executionMode: 'sequential',
      async execute(_toolCallId, rawRequest) {
        let operation = READ_OPERATIONS.includes(rawRequest?.operation) ? rawRequest.operation : null;
        try {
          const request = parseReadRequest(rawRequest);
          operation = request.operation;
          const identity = resolveTrustedIdentity(toolContext, roster);
          authorize(policy, identity, 'read');
          let plan;
          let data;
          if (operation === 'status') {
            plan = core.prepareRead(request, identity, {}, clock());
            const { state, observedAt } = await readState();
            data = projectStatus(state, observedAt);
            data.health = projectHealth(await readSensors(), clock().toISOString());
          } else if (operation === 'rooms') {
            const { state, observedAt } = await readState();
            const map = projectMap(state, observedAt);
            plan = core.prepareRead(request, identity, { map }, clock());
            data = { kind: 'rooms', observedAt, sourceUpdatedAt: state.last_updated ?? null,
              freshness: 'fresh', mapFingerprint: plan.mapFingerprint, rooms: plan.roomInventory };
          } else if (operation === 'operation_status') {
            plan = core.prepareRead(request, identity, {}, clock());
            if (typeof createStore !== 'function') throw new DomainError('READ_UNAVAILABLE', 'verification', 'Native operation store is unavailable');
            const found = createOperationState(createStore()).operation(request.operationId);
            if (!found) throw new DomainError('OPERATION_NOT_FOUND', 'precondition', 'No indexed Jessica operation matches this reference');
            const result = found.kind === 'terminal' ? found.value : null;
            const active = found.kind === 'active' ? found.value : null;
            const observation = result?.data?.observation ?? active?.lastObservation ?? null;
            data = { kind: 'operation_status', observedAt: clock().toISOString(),
              sourceUpdatedAt: null, freshness: 'fresh', operationId: request.operationId,
              outcome: result?.data?.outcome ?? (result?.error?.sideEffects === 'none' ? 'not_sent' :
                active?.phase === 'prepared' ? 'preparing' : 'unknown'),
              dispatch: result?.data?.dispatch ?? (result?.error?.sideEffects === 'none' || active?.phase === 'prepared' ?
                'not_attempted' : 'unknown'),
              observation };
          } else if (operation === 'maintenance' || operation === 'statistics') {
            plan = core.prepareRead(request, identity, {}, clock());
            const states = await readSensors();
            const observedAt = clock().toISOString();
            data = { kind: operation, observedAt, sourceUpdatedAt: null, freshness: 'fresh',
              [operation === 'maintenance' ? 'items' : 'metrics']:
                projectSensorCollection(states, operation, observedAt) };
          } else {
            plan = core.prepareRead(request, identity, {}, clock());
            if (operation !== 'capabilities') throw new DomainError('CAPABILITY_UNSUPPORTED', 'precondition', 'Read operation is not enabled');
            data = { kind: 'capabilities', observedAt: clock().toISOString(), sourceUpdatedAt: null,
              freshness: 'fresh', capabilities: plan.capabilityInventory,
              inventoryScope: 'accepted_registry_only', liveAvailability: 'not_checked' };
          }
          return jsonResult(validateResult(envelope(operation, 'success', true, data), null, clock()));
        } catch (error) {
          const known = error instanceof DomainError;
          const code = known ? error.code : 'READ_UNAVAILABLE';
          const stage = known ? error.stage : 'verification';
          const message = known ? error.message : 'Jessica read is unavailable';
          return jsonResult(validateResult(envelope(operation, 'failure', false, null, {
            code, stage, retryable: !known, retryMode: known ? 'none' : 'read_only',
            sideEffects: 'none', message,
          }), null, clock()));
        }
      },
    };
  };
}

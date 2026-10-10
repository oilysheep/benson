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
import { createSourceAdmissionController, NATIVE_READ_ADMISSION_VERSION } from '../../../benson-routing/request-control.mjs';
import { NATIVE_READ_OUTCOME_VERSION, RESPONSE_CONTRACT_VERSION } from '../../../benson-routing/envelope.mjs';
import { controlResponse } from '../../../benson-routing/response-control.mjs';
import { formatUserDatetime } from '../../../../../shared/benson-datetime.mjs';

const envelope = (operation, status, verified, data, error = null) => ({
  schemaVersion: '1', status, domain: 'jessica-vacuum', operation, verified,
  data, warnings: [], error, pendingContext: null,
});

function createJessicaReadHandler({
  createStore,
  registryConfig = structuredClone(canonicalRegistry),
  policyConfig = structuredClone(canonicalPolicy),
  roster = loadTrustedRoutes(),
  readState = readVacuumState,
  readSensors = readJessicaSensors,
  clock = () => new Date(),
} = {}) {
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

  return {
    parameters, roster,
    async read(toolContext, rawRequest, assertCurrent = () => {}, trustedIdentity) {
      let operation = READ_OPERATIONS.includes(rawRequest?.operation) ? rawRequest.operation : null;
      try {
        assertCurrent();
        const request = parseReadRequest(rawRequest);
        operation = request.operation;
        const identity = trustedIdentity ?? resolveTrustedIdentity(toolContext, roster);
        authorize(policy, identity, 'read');
        let plan;
        let data;
        if (operation === 'status') {
          plan = core.prepareRead(request, identity, {}, clock());
          const { state, observedAt } = await readState(undefined, assertCurrent);
          data = projectStatus(state, observedAt);
          assertCurrent();
          data.health = projectHealth(await readSensors(undefined, assertCurrent), clock().toISOString());
        } else if (operation === 'rooms') {
          const { state, observedAt } = await readState(undefined, assertCurrent);
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
          const states = await readSensors(undefined, assertCurrent);
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
        assertCurrent();
        return validateResult(envelope(operation, 'success', true, data), null, clock());
      } catch (error) {
        assertCurrent();
        const known = error instanceof DomainError;
        const code = known ? error.code : 'READ_UNAVAILABLE';
        const stage = known ? error.stage : 'verification';
        const message = known ? error.message : 'Jessica read is unavailable';
        return validateResult(envelope(operation, 'failure', false, null, {
          code, stage, retryable: !known, retryMode: known ? 'none' : 'read_only',
          sideEffects: 'none', message,
        }), null, clock());
      }
    },
  };
}

export function createJessicaReadToolFactory(options = {}) {
  const { jsonResult } = options;
  if (typeof jsonResult !== 'function') throw new Error('jsonResult is required');
  const handler = createJessicaReadHandler(options);
  return (toolContext) => {
    if (toolContext.agentId !== 'jessica-vacuum') return null;
    return {
      name: 'jessica_read', label: 'Jessica read',
      description: 'Read Jessica status, rooms, accepted capabilities, maintenance, lifetime statistics, or an enabled known dispatch operation. No device action.',
      parameters: handler.parameters,
      executionMode: 'sequential',
      async execute(_toolCallId, rawRequest) {
        return jsonResult(await handler.read(toolContext, rawRequest));
      },
    };
  };
}

// The native host calls this factory with contextVersion: 2. Main supplies only
// intent; requester identity and live invocation authority are factory context.
export function createJessicaTaskToolFactory(options = {}) {
  const { jsonResult, clock = () => new Date() } = options;
  if (typeof jsonResult !== 'function') throw new Error('jsonResult is required');
  const handler = createJessicaReadHandler(options);
  return (toolContext) => {
    if (toolContext.agentId !== 'main' || typeof toolContext.assertInvocationCurrent !== 'function') return null;
    return {
      name: 'jessica_task', label: 'Jessica task',
      description: 'Delegate a Jessica status task to its deterministic domain entry. No device action or child Run.',
      parameters: { type: 'object', properties: { operation: { const: 'status' } },
        required: ['operation'], additionalProperties: false },
      executionMode: 'sequential',
      async execute(toolCallId, rawRequest, signal) {
        const assertCurrent = () => {
          signal?.throwIfAborted();
          return toolContext.assertInvocationCurrent();
        };
        signal?.throwIfAborted();
        const identity = resolveTrustedIdentity(toolContext, handler.roster);
        const request = parseReadRequest(rawRequest);
        // Domain-owned effect classification: no payload switch can turn a
        // mutation or an unsupported capability into an admitted read.
        if (request.operation !== 'status') {
          throw new DomainError('CAPABILITY_UNSUPPORTED', 'precondition', 'Main task entry supports status only');
        }
        const controller = createSourceAdmissionController({ assertCurrent, now: () => clock().getTime(),
          invocation: { callId: toolCallId, domain: 'jessica-vacuum', subject: identity.senderId },
          assertDomainOutcome(outcome) {
            const facts = validateResult(outcome.evidence.facts, null, clock());
            if (facts.operation !== request.operation ||
                (facts.status === 'success' ? outcome.disposition !== 'handled' : outcome.disposition !== 'failed') ||
                outcome.evidence.observedAt !== (facts.data?.observedAt ?? null)) {
              throw new TypeError('jessica_task_evidence_mismatch');
            }
          } });
        const admission = controller.admit({ schemaVersion: NATIVE_READ_ADMISSION_VERSION,
          kind: 'benson.source-input', domain: 'jessica-vacuum', scope: 'read', request: JSON.stringify(request) });
        const facts = await handler.read(toolContext, request,
          () => controller.assertCurrent(admission), identity);
        const response = controlResponse({
          schemaVersion: NATIVE_READ_OUTCOME_VERSION, kind: 'benson.no-run',
          admission: { authorityKind: admission.authority.kind, callId: admission.callId,
            domain: admission.domain, subject: admission.authority.subject },
          disposition: facts.status === 'success' ? 'handled' : 'failed',
          evidence: { ref: admission.callId, observedAt: facts.data?.observedAt ?? null,
            freshness: facts.data?.freshness ?? 'unknown', facts },
          effects: { status: 'none', refs: [] }, reconciliation: { required: false, reason: null },
          notification: null, error: facts.error === null ? null : {
            code: facts.error.code, message: facts.error.message, retryable: facts.error.retryable },
        }, { controller, admission, renderOutcome: outcome => renderStatusOutcome(outcome, clock()) });
        const result = jsonResult(response.outcome);
        result.content.push({ type: 'text', text: response.rendered.message });
        controller.assertCurrent(admission);
        return result;
      },
    };
  };
}

// Domain-owned deterministic wording; cached observations are never described
// as physical completion. Untrusted backend error prose is not user wording.
function renderStatusOutcome(outcome, now) {
  const facts = outcome.evidence.facts;
  const message = outcome.disposition === 'handled'
    ? `מצב Jessica: ${facts.data.state}; סוללה: ${facts.data.batteryLevel === null ? 'לא ידוע' : `${facts.data.batteryLevel}%`}. לפי נתוני Home Assistant שנקראו ${formatUserDatetime(outcome.evidence.observedAt, 'Asia/Jerusalem', { now })}.`
    : 'לא ניתן לאמת כעת את מצב Jessica. לא בוצעה פעולה במכשיר.';
  return { schemaVersion: RESPONSE_CONTRACT_VERSION, message };
}

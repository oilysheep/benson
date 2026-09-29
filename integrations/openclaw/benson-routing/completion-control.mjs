import { validateTaskResultEnvelope } from './envelope.mjs';

const VERSION = 1;
const DOMAINS = new Set(['jessica-vacuum', 'reminder-service']);

function fail(code) { throw new Error(code); }
function id(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
function same(a, b) { return id(a) && a === b; }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// Called only with host-owned source-turn, parent-run, session and commitment
// facts. The child result never supplies a route or a recipient.
export function bindNativeCompletion({ commitment, sourceTurnId, parentSessionKey,
  parentSessionId, parentRunId, childRunId, childSessionKey, executionOwner,
  completionTarget }) {
  if (!plain(commitment) || !same(commitment.requestId, sourceTurnId) ||
      !same(commitment.sessionId, parentSessionId) || commitment.phase !== 'committed' ||
      !id(parentSessionKey) ||
      (completionTarget === 'CALLER' ? !id(parentRunId) : parentRunId !== null) ||
      !id(childRunId) ||
      !id(childSessionKey) || !DOMAINS.has(executionOwner) ||
      !childSessionKey.startsWith(`agent:${executionOwner}:subagent:`) ||
      !['CALLER', 'RESPONSE_CONTROLLER'].includes(completionTarget) ||
      (completionTarget === 'CALLER' && commitment.owner !== 'main') ||
      (completionTarget === 'RESPONSE_CONTROLLER' && commitment.owner !== executionOwner)) {
    fail('completion_binding_unavailable');
  }
  return Object.freeze({ schemaVersion: VERSION, requestId: sourceTurnId,
    parentSessionKey, parentSessionId, parentRunId, childRunId, childSessionKey,
    executionOwner, completionTarget, callerRunId: completionTarget === 'CALLER' ? parentRunId : null });
}

export function validateNativeCompletion({ binding, commitment, parentSession,
  child, task, result }) {
  if (!plain(binding) || binding.schemaVersion !== VERSION ||
      !id(binding.requestId) || !id(binding.parentSessionKey) ||
      !id(binding.parentSessionId) ||
      (binding.completionTarget === 'CALLER' ? !id(binding.parentRunId) :
        binding.parentRunId !== null) ||
      !id(binding.childRunId) || !id(binding.childSessionKey) ||
      !DOMAINS.has(binding.executionOwner) ||
      !['CALLER', 'RESPONSE_CONTROLLER'].includes(binding.completionTarget) ||
      !plain(parentSession) || !same(parentSession.sessionKey, binding.parentSessionKey) ||
      !same(parentSession.sessionId, binding.parentSessionId) ||
      !plain(child) || !same(child.runId, binding.childRunId) ||
      !same(child.childSessionKey, binding.childSessionKey) ||
      !same(child.requesterSessionKey, binding.parentSessionKey) ||
      (binding.completionTarget === 'CALLER' ?
        !same(child.requesterTurnRunId, binding.parentRunId) :
        child.requesterTurnRunId != null) ||
      !same(child.agentId, binding.executionOwner) ||
      child.execution?.status !== 'terminal' || child.execution?.outcome?.status !== 'ok' ||
      !plain(task) || !same(task.runId, binding.childRunId) ||
      !same(task.childSessionKey, binding.childSessionKey) ||
      !same(task.agentId, binding.executionOwner) || task.runtime !== 'subagent' ||
      !['running', 'succeeded'].includes(task.status) || !id(task.taskId) ||
      !plain(commitment) || !same(commitment.requestId, binding.requestId) ||
      !same(commitment.sessionId, binding.parentSessionId) ||
      commitment.phase !== 'committed' ||
      commitment.owner !== (binding.completionTarget === 'CALLER' ? 'main' : binding.executionOwner)) {
    fail('completion_owner_mismatch');
  }
  if (binding.completionTarget === 'CALLER' && !same(binding.callerRunId, binding.parentRunId) ||
      binding.completionTarget === 'RESPONSE_CONTROLLER' && binding.callerRunId !== null) {
    fail('completion_caller_mismatch');
  }
  const normalized = validateTaskResultEnvelope(result);
  if (!same(normalized.taskId, task.taskId) ||
      normalized.domain !== (binding.executionOwner === 'reminder-service' ? 'reminder' : binding.executionOwner)) {
    fail('completion_result_mismatch');
  }
  return Object.freeze({ schemaVersion: VERSION, requestId: binding.requestId,
    childRunId: binding.childRunId, taskId: task.taskId,
    destination: binding.completionTarget, callerRunId: binding.callerRunId,
    result: normalized });
}

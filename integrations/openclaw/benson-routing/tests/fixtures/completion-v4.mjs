import { CURRENT_COMPLETION_SCHEMA_VERSION, createCompletionAuthority,
  acceptAgentCompletion, reconstructCompletion } from '../../envelope.mjs';

export const p02Facts = (changes = {}) => ({ status: 'success', domain: 'jessica-vacuum',
  domainSchemaVersion: '1', operation: 'clean', verified: true,
  verificationScope: ['command_started'], data: { operationId: 'operation-1', started: true },
  warnings: [{ code: 'LIMITED_SCOPE' }], error: null,
  effects: [{ kind: 'command_started', operationId: 'operation-1' }],
  uncertainty: [{ kind: 'physical_completion_not_established' }], pendingContext: null, ...changes });

export const p02Binding = (changes = {}) => ({ conversationId: 'conversation-1', conversationGeneration: 1,
  admissionId: 'admission-1', admissionSequence: 1, workflowId: 'workflow-1',
  membershipRevision: 1, acceptedIntentRevision: 1, runId: 'domain-run-1', runGeneration: 1,
  agentId: 'jessica-vacuum', sessionKey: 'agent:jessica-vacuum:child-1', sessionId: 'child-session-1',
  sessionGeneration: 1, taskId: 'task-1', role: 'domain-task',
  caller: { workflowId: 'workflow-1', runId: 'original-owner-run', runGeneration: 1,
    agentId: 'main', sessionKey: 'agent:main:owner', sessionId: 'owner-session', sessionGeneration: 1 },
  completionTarget: 'CALLER', finality: false, authorizationId: 'authorization-1',
  deliveryPolicy: { eligible: false, reason: null }, ...changes });

export function p02Evidence(changes = {}) {
  const binding = changes.binding ?? p02Binding();
  return { schemaVersion: CURRENT_COMPLETION_SCHEMA_VERSION,
    kind: binding.role === 'domain-task' ? 'domain-task' : 'final-workflow', binding,
    knownFacts: p02Facts(), results: [], coverage: 'complete', gaps: [], origin: 'agent',
    workflow: { workflowId: binding.workflowId, conversationId: binding.conversationId,
      conversationGeneration: binding.conversationGeneration, membershipRevision: binding.membershipRevision,
      acceptedIntentRevision: binding.acceptedIntentRevision, membershipState: binding.finality ? 'closed' : 'open',
      admissions: [{ admissionId: binding.admissionId, sequence: binding.admissionSequence }] },
    semantics: binding.role === 'workflow-final' ? { ownerRunId: binding.runId,
      ownerRunGeneration: binding.runGeneration, acceptedIntentRevision: binding.acceptedIntentRevision,
      coverage: 'complete', value: (changes.knownFacts ?? p02Facts()).data } : null, ...changes };
}

export function p02Accepted(native, userResponse = { state: 'usable', text: 'Cleaning started.', language: 'en' }) {
  const authority = createCompletionAuthority(native);
  const record = native.origin === 'runtime' ? reconstructCompletion(authority) : acceptAgentCompletion({
    schemaVersion: CURRENT_COMPLETION_SCHEMA_VERSION, kind: native.kind, facts: native.knownFacts, userResponse,
  }, authority);
  return { record, authority };
}

export function p02Child(taskId, options = {}) {
  const binding = p02Binding({ taskId, runId: `run-${taskId}`, sessionKey: `agent:domain:${taskId}`,
    sessionId: `session-${taskId}`, ...options.binding });
  return p02Accepted(p02Evidence({ binding, knownFacts: p02Facts(options.facts),
    ...options.evidence }), options.userResponse);
}

export function p02Workflow(results = [], options = {}) {
  const binding = p02Binding({ taskId: null, role: 'workflow-final', runId: 'final-owner-run',
    agentId: 'main', sessionKey: 'agent:main:owner', sessionId: 'owner-session',
    caller: null, completionTarget: 'RESPONSE_CONTROLLER', finality: true,
    deliveryPolicy: { eligible: true, reason: null }, ...options.binding });
  const knownFacts = p02Facts({ domain: null, domainSchemaVersion: null, operation: null,
    verified: results.length ? true : 'not_applicable',
    verificationScope: results.length ? ['retained_child_results'] : [],
    data: { answer: results.length ? 'Requested work started.' : 'Hello.' },
    warnings: [], effects: [], uncertainty: [], ...options.facts });
  return p02Accepted(p02Evidence({ binding, knownFacts, results, ...options.evidence }),
    options.userResponse ?? { state: 'usable', text: results.length ? 'Requested work started.' : 'Hello.', language: 'en' });
}

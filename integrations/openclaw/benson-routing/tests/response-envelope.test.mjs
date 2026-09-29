import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { bindNativeCompletion, validateNativeCompletion } from '../completion-control.mjs';
import { createDirectResponseEnvelope, createDirectFailureResponseEnvelope, createMainResponseEnvelope,
  normalizeLegacyTaskResult, validateResponseEnvelope, MAX_RESPONSE_RESULTS } from '../envelope.mjs';

const corpus = JSON.parse(await readFile(new URL('./fixtures/presentation-cases.json', import.meta.url)));
const accepted = new Map(corpus.cases.filter((item) => item.validation.expected === 'accept')
  .map((item) => [item.id, item.result]));
const responsePolicy = { allowedModes: ['deterministic', 'safe_failure'], preferredMode: 'deterministic' };
const requestId = 'native-request-s08';
const callerRunId = 'native-main-caller-s08';
const parentSession = { sessionKey: 'agent:main:oren', sessionId: 'parent-session' };
const plain = (value) => JSON.parse(JSON.stringify(value));
function result(id, taskId, messageCandidate = null) {
  const raw = accepted.get(id);
  assert.ok(raw, id);
  return normalizeLegacyTaskResult(raw, { taskId,
    pendingBinding: raw.pendingContext ? { requesterId: 'oren', conversationId: parentSession.sessionKey } : null,
    pendingExpiresAt: raw.pendingContext?.expiresAt ??
      (raw.pendingContext ? '2026-09-25T22:00:00+03:00' : null) }, messageCandidate);
}
function completion(domainResult, childRunId, destination = 'CALLER',
  parentRunId = destination === 'CALLER' ? callerRunId : null) {
  const executionOwner = domainResult.domain === 'reminder' ? 'reminder-service' : 'jessica-vacuum';
  const commitment = { requestId, sessionId: parentSession.sessionId,
    owner: destination === 'CALLER' ? 'main' : executionOwner, phase: 'committed' };
  const binding = bindNativeCompletion({ commitment, sourceTurnId: requestId,
    parentSessionKey: parentSession.sessionKey, parentSessionId: parentSession.sessionId,
    parentRunId, childRunId, childSessionKey: `agent:${executionOwner}:subagent:${childRunId}`,
    executionOwner, completionTarget: destination });
  return { binding, admission: { schemaVersion: 1, requestId, childRunId,
    taskId: domainResult.taskId, destination, callerRunId: binding.callerRunId,
    result: domainResult } };
}
function main(completions, lifecycle = { domainExecution: completions.length ? 'attempted' : 'none',
  failure: null }) {
  return { requestId, source: { type: 'main', agentId: 'main', runId: 'native-finalization-run' },
    parentSession, completions, lifecycle, responsePolicy };
}
function direct(domainResult, childRunId) {
  const completed = completion(domainResult, childRunId, 'RESPONSE_CONTROLLER');
  return { completed, trusted: { requestId, parentSession,
    source: { type: 'direct', agentId: completed.binding.executionOwner, runId: childRunId },
    responsePolicy } };
}

test('Main-only success needs positive no-domain proof; terminal failure needs native fact', () => {
  const candidate = { text: 'Hello.', language: 'en' };
  const conversation = createMainResponseEnvelope({ messageCandidate: candidate }, main([]));
  assert.equal(conversation.status, 'success');
  assert.deepEqual(conversation.results, []);
  assert.deepEqual(plain(conversation.lifecycle), { domainExecution: 'none', failure: null });
  assert.equal(conversation.provenance.executionVerified, 'not_applicable');
  const failure = createMainResponseEnvelope({ messageCandidate: null }, main([], {
    domainExecution: 'uncertain', failure: { code: 'RESULT_UNAVAILABLE' },
  }));
  assert.equal(failure.status, 'failure');
  assert.equal(failure.provenance.executionVerified, false);
  assert.deepEqual(failure.results, []);
  assert.throws(() => createMainResponseEnvelope({ messageCandidate: null }, main([], {
    domainExecution: 'attempted', failure: null,
  })), /no_domain_result_invalid/);
  assert.throws(() => validateResponseEnvelope({ ...conversation, schemaVersion: 1 }), /response_invalid/);
});

test('Direct terminal failure remains a native failure without a fabricated result', () => {
  const envelope = createDirectFailureResponseEnvelope({ requestId, parentSession,
    source: { type: 'direct', agentId: 'jessica-vacuum', runId: 'failed-child' },
    responsePolicy, lifecycle: { domainExecution: 'uncertain', failure: { code: 'CHILD_RESULT_INVALID' } },
  });
  assert.equal(envelope.status, 'failure');
  assert.deepEqual(envelope.results, []);
  assert.equal(envelope.provenance.executionVerified, false);
});

test('direct completion normalizes one authoritative result without Main', () => {
  const domainResult = result('reminder-create-notification-intent-en', 'native-task-direct',
    { text: 'I created the reminder.', language: 'en' });
  const { completed, trusted } = direct(domainResult, 'native-reminder-child');
  const envelope = createDirectResponseEnvelope(completed, trusted);
  assert.deepEqual(plain(envelope.source), trusted.source);
  assert.equal(envelope.requestId, requestId);
  assert.equal(envelope.status, domainResult.status);
  assert.deepEqual(plain(envelope.results), [plain(domainResult)]);
  assert.deepEqual(plain(envelope.messageCandidate), plain(domainResult.messageCandidate));
  assert.deepEqual(plain(envelope.responsePolicy), responsePolicy);
  assert.deepEqual(plain(envelope.provenance), {
    executionVerified: true, completionCorrelated: true });
  assert.equal(envelope.results[0].data.transport.deliveries[0].status, 'pending');
  const withoutCandidate = result('jessica-status-read-en', 'native-task-no-candidate');
  const fallback = direct(withoutCandidate, 'native-jessica-child');
  assert.equal(createDirectResponseEnvelope(fallback.completed, fallback.trusted).messageCandidate, null);
});

test('accepted S07 Completion Control output feeds both S08 destinations unchanged', () => {
  const domainResult = result('jessica-status-read-en', 'native-task');
  for (const destination of ['CALLER', 'RESPONSE_CONTROLLER']) {
    const { binding } = completion(domainResult, `native-child-${destination}`, destination);
    const commitment = { requestId, sessionId: parentSession.sessionId,
      owner: destination === 'CALLER' ? 'main' : 'jessica-vacuum', phase: 'committed' };
    const admitted = validateNativeCompletion({ binding, commitment,
      parentSession, child: { runId: binding.childRunId, childSessionKey: binding.childSessionKey,
        requesterSessionKey: binding.parentSessionKey, requesterTurnRunId: binding.parentRunId,
        agentId: 'jessica-vacuum', execution: { status: 'terminal', outcome: { status: 'ok' } } },
      task: { taskId: domainResult.taskId, runId: binding.childRunId,
        childSessionKey: binding.childSessionKey, agentId: 'jessica-vacuum',
        runtime: 'subagent', status: 'running' }, result: domainResult });
    const completed = { binding, admission: admitted };
    const envelope = destination === 'CALLER' ?
      createMainResponseEnvelope({ messageCandidate: null }, main([completed])) :
      createDirectResponseEnvelope(completed, { requestId, parentSession,
        source: { type: 'direct', agentId: 'jessica-vacuum', runId: binding.childRunId },
        responsePolicy });
    assert.deepEqual(plain(envelope.results), [plain(domainResult)]);
    assert.equal(envelope.provenance.completionCorrelated, true);
  }
});

test('direct clarification and failure preserve pending binding and error truth', () => {
  for (const [id, status] of [
    ['jessica-clarification-exact-context-he', 'clarification_required'],
    ['reminder-update-partial-failure-he', 'failure'],
  ]) {
    const domainResult = result(id, `task-${status}`);
    const { completed, trusted } = direct(domainResult, `child-${status}`);
    const envelope = createDirectResponseEnvelope(completed, trusted);
    assert.equal(envelope.status, status);
    assert.deepEqual(plain(envelope.results), [plain(domainResult)]);
    assert.deepEqual(plain(envelope.pendingContext), plain(domainResult.pendingContext));
    assert.deepEqual(plain(envelope.results[0].error), plain(domainResult.error));
    assert.equal(envelope.provenance.executionVerified, domainResult.verified);
    assert.equal(envelope.provenance.completionCorrelated, true);
  }
});

test('Main aggregates later caller runs in one owning session without losing facts', () => {
  const domainResults = [
    result('jessica-maintenance-warning-en', 'task-jessica-warning'),
    result('reminder-update-partial-failure-he', 'task-reminder-failure'),
    result('jessica-clarification-exact-context-he', 'task-jessica-pending'),
  ];
  const completions = domainResults.map((item, index) =>
    completion(item, `child-${index}`, 'CALLER', `earlier-main-run-${index}`));
  const candidate = { text: 'I checked the tasks.', language: 'en' };
  const envelope = createMainResponseEnvelope({ messageCandidate: candidate }, main(completions));
  assert.equal(envelope.status, 'partial');
  assert.deepEqual(plain(envelope.results), domainResults.map(plain));
  assert.deepEqual(plain(envelope.pendingContext), plain(domainResults[2].pendingContext));
  assert.deepEqual(plain(envelope.provenance), { executionVerified: false, completionCorrelated: true });
  assert.deepEqual(plain(envelope.messageCandidate), candidate);
  assert.ok(envelope.results[0].warnings.length > 0);
  assert.ok(envelope.results[1].error);
  assert.equal(envelope.results[0].domainSchemaVersion, '1');
  assert.equal(envelope.results[1].domainSchemaVersion, 'legacy-unversioned');
  assert.deepEqual(plain(validateResponseEnvelope(envelope)), plain(envelope));
  assert.throws(() => validateResponseEnvelope({ ...envelope, status: 'success' }),
    /response_results_invalid/);
});

test('later infrastructure failure keeps a verified result and marks the workflow partial', () => {
  const first = completion(result('jessica-status-read-en', 'task-before-failure'), 'child-before-failure');
  const envelope = createMainResponseEnvelope({ messageCandidate: null }, main([first], {
    domainExecution: 'uncertain', failure: { code: 'LATER_COMPLETION_UNAVAILABLE' },
  }));
  assert.equal(envelope.status, 'partial');
  assert.equal(envelope.results[0].taskId, 'task-before-failure');
  assert.equal(envelope.lifecycle.failure.code, 'LATER_COMPLETION_UNAVAILABLE');
  assert.throws(() => validateResponseEnvelope({ ...envelope, status: 'success' }),
    /response_results_invalid/);
});

test('one through sixteen independent completions share the same contract', () => {
  for (const count of [1, 3, MAX_RESPONSE_RESULTS]) {
    const completions = Array.from({ length: count }, (_, index) =>
      completion(result('jessica-status-read-en', `task-${index}`), `child-${index}`));
    const envelope = createMainResponseEnvelope({ messageCandidate: null }, main(completions));
    assert.equal(envelope.results.length, count);
    assert.equal(envelope.status, 'success');
    assert.equal(envelope.provenance.completionCorrelated, true);
    assert.deepEqual(envelope.results.map((item) => item.taskId),
      Array.from({ length: count }, (_, index) => `task-${index}`));
  }
  const overflow = Array.from({ length: MAX_RESPONSE_RESULTS + 1 }, (_, index) =>
    completion(result('jessica-status-read-en', `task-${index}`), `child-${index}`));
  assert.throws(() => createMainResponseEnvelope({ messageCandidate: null }, main(overflow)),
    /response_completions_count/);
});

test('Main candidate cannot author mode, source, correlation or an all-success aggregate', () => {
  const success = completion(result('jessica-status-read-en', 'task-a'), 'child-a');
  const failure = completion(result('reminder-update-partial-failure-he', 'task-b'), 'child-b');
  const trusted = main([success, failure]);
  assert.equal(createMainResponseEnvelope({ messageCandidate: null }, trusted).status, 'partial');
  for (const field of ['status', 'requestId', 'source', 'results', 'responsePolicy', 'provenance',
    'completionCorrelated', 'allowedModes']) {
    assert.throws(() => createMainResponseEnvelope({ messageCandidate: null, [field]: 'forged' },
      trusted), /response_candidate_shape/);
  }
  assert.throws(() => createMainResponseEnvelope({ messageCandidate: null },
    { ...trusted, lifecycle: { domainExecution: 'none', failure: null } }), /response_results_invalid/);
  assert.throws(() => createMainResponseEnvelope({ messageCandidate: null },
    { ...trusted, provenance: { completionCorrelated: true } }), /main_finalization_shape/);
});

test('foreign, contradictory, duplicate and ambiguous completions fail closed', () => {
  const first = completion(result('jessica-status-read-en', 'task-first'), 'child-first');
  const second = completion(result('reminder-find-zero-he', 'task-second'), 'child-second');
  const candidate = { messageCandidate: null };
  for (const changed of [
    { ...first, binding: { ...first.binding, requestId: 'foreign-request' } },
    { ...first, binding: { ...first.binding, parentSessionId: 'replaced-session' } },
    { ...first, binding: { ...first.binding, parentRunId: 'foreign-caller' } },
    { ...first, admission: { ...first.admission, requestId: 'foreign-request' } },
    { ...first, admission: { ...first.admission, destination: 'RESPONSE_CONTROLLER' } },
    { ...first, admission: { ...first.admission, callerRunId: 'foreign-caller' } },
    { ...first, admission: { ...first.admission, taskId: 'forged-task' } },
    { ...first, admission: { ...first.admission, schemaVersion: 2 } },
    { ...first, admission: { ...first.admission, responsePolicy } },
  ]) assert.throws(() => createMainResponseEnvelope(candidate, main([changed])));
  assert.throws(() => createMainResponseEnvelope(candidate,
    main([first, { ...second, binding: { ...second.binding, childRunId: first.binding.childRunId },
      admission: { ...second.admission, childRunId: first.binding.childRunId } }])),
  /duplicate_completion_run/);
  assert.throws(() => createMainResponseEnvelope(candidate,
    main([first, { ...second, admission: { ...second.admission, taskId: first.admission.taskId,
      result: { ...second.admission.result, taskId: first.admission.taskId } } }])),
  /duplicate_task_result/);
  const pendingA = completion(result('jessica-clarification-exact-context-he', 'pending-a'), 'pending-child-a');
  const pendingB = completion(result('reminder-clarification-exact-context-en', 'pending-b'), 'pending-child-b');
  assert.throws(() => createMainResponseEnvelope(candidate, main([pendingA, pendingB])),
    /response_pending_ambiguous/);
  const directCompletion = direct(first.admission.result, first.binding.childRunId);
  for (const changed of [
    { ...directCompletion.trusted, requestId: 'foreign-request' },
    { ...directCompletion.trusted, parentSession: { ...parentSession, sessionId: 'replaced-session' } },
    { ...directCompletion.trusted,
      source: { ...directCompletion.trusted.source, runId: 'foreign-run' } },
    { ...directCompletion.trusted,
      source: { ...directCompletion.trusted.source, agentId: 'reminder-service' } },
  ]) assert.throws(() => createDirectResponseEnvelope(directCompletion.completed, changed));
  assert.throws(() => createDirectResponseEnvelope(first, directCompletion.trusted),
    /completion_binding_mismatch/);
});

import { createCompletionAuthority, acceptAgentCompletion, reconstructCompletion,
  validateCompletion, COMPLETION_SCHEMA_VERSION } from '../envelope.mjs';

function protocolFacts(changes = {}) {
  return { status: 'success', domain: 'jessica-vacuum', domainSchemaVersion: '1', operation: 'clean',
    verified: true, verificationScope: ['command_started'], data: { started: true },
    warnings: [{ code: 'LIMITED_SCOPE' }], error: null,
    effects: [{ kind: 'cleaning_started' }], uncertainty: [{ kind: 'physical_completion_unknown' }],
    pendingContext: null, ...changes };
}
function protocolBinding(taskId = null, changes = {}) {
  return { requestId: 'r02-request', workflowId: 'r02-workflow', runId: taskId ?? 'main-final-run',
    agentId: taskId === null ? 'main' : 'jessica-vacuum', sessionKey: 'agent:main:oren', sessionId: 'r02-session',
    instanceId: 'instance-r02', lifecycleGeneration: 'lifecycle-r02', taskId, callerRunId: taskId === null ? null : 'main-original-run',
    completionTarget: taskId === null ? 'RESPONSE_CONTROLLER' : 'CALLER', finality: taskId === null,
    authorizationId: 'native-authorization', deliveryPolicy: { eligible: taskId === null, reason: null }, ...changes };
}
function protocolChild(taskId, changes = {}, origin = 'agent', coverage = 'complete') {
  const facts = protocolFacts(changes);
  const authority = createCompletionAuthority({ kind: 'domain-task', binding: protocolBinding(taskId),
    knownFacts: facts, results: [], coverage, gaps: [], origin });
  const record = origin === 'runtime' ? reconstructCompletion(authority) : acceptAgentCompletion({
    schemaVersion: COMPLETION_SCHEMA_VERSION, kind: 'domain-task', facts,
    userResponse: { state: 'usable', text: 'Cleaning started; physical completion is not established.', language: 'en' },
  }, authority);
  return { record, authority };
}
function protocolWorkflow(results, changes = {}, origin = 'agent', coverage = 'complete') {
  const facts = protocolFacts({ domain: null, domainSchemaVersion: null, operation: null,
    verified: results.length ? true : 'not_applicable', verificationScope: results.length ? ['retained_child_results'] : [],
    data: {}, effects: [], warnings: [], uncertainty: [], ...changes });
  const authority = createCompletionAuthority({ kind: 'final-workflow', binding: protocolBinding(),
    knownFacts: facts, results, coverage, gaps: [], origin });
  const record = origin === 'runtime' ? reconstructCompletion(authority) : acceptAgentCompletion({
    schemaVersion: COMPLETION_SCHEMA_VERSION, kind: 'final-workflow', facts,
    userResponse: { state: 'usable', text: results.length ? 'Requested work has started.' : 'Hello.', language: 'en' },
  }, authority);
  return { record, authority };
}

test('R02 final-workflow collections preserve every child and accept 0/1/many/max', () => {
  for (const count of [0, 1, 3, MAX_RESPONSE_RESULTS]) {
    const children = Array.from({ length: count }, (_, index) => protocolChild(`task-${index}`));
    const { record, authority } = protocolWorkflow(children);
    assert.equal(record.schemaVersion, 3);
    assert.equal(record.kind, 'final-workflow');
    assert.equal(record.completion.outcome, 'NORMAL');
    assert.equal(record.results.length, count);
    assert.equal(record.facts.verified, count ? true : 'not_applicable');
    children.forEach((child, index) => assert.deepEqual(plain(record.results[index]), plain(child.record)));
    assert.deepEqual(plain(validateCompletion(plain(record), authority)), plain(record));
    const { record: recovered } = protocolWorkflow(children, {}, 'runtime');
    assert.equal(recovered.completion.outcome, 'RECOVERED');
    assert.equal(recovered.facts.status, 'success');
    assert.deepEqual(plain(recovered.results), plain(record.results));
  }
  const overflow = Array.from({ length: MAX_RESPONSE_RESULTS + 1 }, (_, index) => protocolChild(`task-${index}`));
  assert.throws(() => protocolWorkflow(overflow), /native_evidence_invalid/);
  const child = protocolChild('duplicate');
  assert.throws(() => protocolWorkflow([child, child]), /duplicate_task/);
  assert.throws(() => protocolWorkflow([], { verified: true, verificationScope: ['unproven_empty_execution'] }), /empty_execution_proof/);
});

test('R02 mixed outcomes preserve business failure, partial effects and child finalization', () => {
  const success = protocolChild('verified-start', {}, 'runtime');
  const failure = protocolChild('business-failure', { status: 'failure', verified: false,
    verificationScope: [], error: { code: 'ROOM_UNAVAILABLE' }, data: { failedRoom: 'bedroom' }, effects: [] }, 'runtime');
  const partial = protocolChild('partial-effects', { status: 'partial', verified: false,
    verificationScope: [], error: { code: 'ROOM_UNAVAILABLE' }, data: { startedRoom: 'kitchen', failedRoom: 'bedroom' } });
  const children = [success, failure, partial];
  const { record } = protocolWorkflow(children, { status: 'partial', verified: false,
    verificationScope: [], error: { code: 'WORKFLOW_PARTIAL' } }, 'runtime');
  assert.equal(record.completion.outcome, 'RECOVERED');
  assert.equal(record.facts.status, 'partial');
  assert.deepEqual(record.results.map((child) => child.facts.status), ['success', 'failure', 'partial']);
  assert.deepEqual(record.results.map((child) => child.completion.outcome), ['RECOVERED', 'RECOVERED', 'NORMAL']);
  children.forEach((child, index) => assert.deepEqual(plain(record.results[index]), plain(child.record)));
  assert.throws(() => protocolWorkflow(children), /success_hides_result/);
  const onlyFailure = protocolWorkflow([failure], { status: 'failure', verified: false,
    verificationScope: [], error: { code: 'WORKFLOW_FAILED' } }, 'runtime').record;
  assert.equal(onlyFailure.completion.outcome, 'RECOVERED');
  assert.equal(onlyFailure.facts.status, 'failure');
});

test('R02 incomplete child evidence cannot manufacture recovered workflow success', () => {
  const knownSuccess = protocolChild('known-success', {}, 'runtime', 'incomplete');
  const { record, authority } = protocolWorkflow([knownSuccess], {}, 'runtime');
  assert.equal(record.completion.outcome, 'FAILED');
  assert.equal(record.facts.status, 'success');
  assert.equal(record.results[0].facts.status, 'success');
  assert.deepEqual(plain(record.results[0].facts.effects), [{ kind: 'cleaning_started' }]);
  assert.ok(record.completion.gaps.some((gap) => gap.code === 'CHILD_COMPLETION_INCOMPLETE'));
  assert.throws(() => protocolWorkflow([knownSuccess]), /evidence_insufficient/);
  const forged = plain(record); forged.completion = { outcome: 'RECOVERED', gaps: [] };
  assert.throws(() => validateCompletion(forged, authority), /evidence_insufficient/);
});

test('R02 native workflow binding, retained child authority and pending provenance are checked', () => {
  const pendingContext = { schemaVersion: 1, value: { question: 'Which room?', evidenceId: 'native-question-evidence' },
    binding: { requesterId: 'oren', conversationId: 'agent:main:oren' }, expiresAt: '2026-09-29T12:00:00Z' };
  const child = protocolChild('clarify', { status: 'clarification_required', verified: false,
    verificationScope: [], pendingContext, effects: [] });
  const { record, authority } = protocolWorkflow([child], { status: 'clarification_required', verified: false,
    verificationScope: [], pendingContext });
  assert.deepEqual(plain(record.facts.pendingContext), pendingContext);
  assert.deepEqual(plain(record.results[0].facts.pendingContext), pendingContext);
  const forged = plain(record); forged.results[0].facts.pendingContext.binding.requesterId = 'foreign';
  assert.throws(() => validateCompletion(forged, authority), /evidence_mismatch/);
  const replayed = plain(record); replayed.binding.instanceId = 'replacement-native-instance';
  assert.throws(() => validateCompletion(replayed, authority), /native_binding_mismatch/);
  assert.throws(() => protocolWorkflow([{ record: child.record, authority: {} }], {
    status: 'clarification_required', verified: false, verificationScope: [], pendingContext }), /native_completion_authority_required/);
  const native = { kind: 'final-workflow', binding: protocolBinding(null, { requestId: 'another-request' }),
    knownFacts: protocolFacts({ domain: null, domainSchemaVersion: null, operation: null }),
    results: [protocolChild('foreign-child')], coverage: 'complete', gaps: [], origin: 'runtime' };
  assert.throws(() => createCompletionAuthority(native), /result_correlation/);
});

test('R02 runtime reconstruction is repeatable, bounded and preserves cancellation delivery policy', () => {
  const binding = protocolBinding(null, { deliveryPolicy: { eligible: false, reason: 'CANCELLED' } });
  const authority = createCompletionAuthority({ kind: 'final-workflow', binding,
    knownFacts: protocolFacts({ domain: null, domainSchemaVersion: null, operation: null,
      status: 'unknown', verified: 'unknown', verificationScope: [], effects: [],
      uncertainty: [{ kind: 'outstanding_tool_result' }] }), results: [],
    coverage: 'complete', gaps: [], origin: 'runtime' });
  const before = JSON.stringify(binding);
  const first = reconstructCompletion(authority), again = reconstructCompletion(authority);
  assert.deepEqual(plain(first), plain(again));
  assert.equal(first.completion.outcome, 'RECOVERED');
  assert.equal(first.facts.status, 'unknown'); // Proven unknown work is not a missing semantic fact.
  assert.equal(first.binding.deliveryPolicy.eligible, false);
  assert.equal(first.binding.deliveryPolicy.reason, 'CANCELLED');
  assert.equal(JSON.stringify(binding), before);
  const legacy = createMainResponseEnvelope({ messageCandidate: null }, {
    requestId, source: { type: 'main', agentId: 'main', runId: 'old-final-run' },
    parentSession, completions: [],
    lifecycle: { domainExecution: 'none', failure: null }, responsePolicy });
  assert.equal(legacy.schemaVersion, 2);
  assert.throws(() => validateCompletion({ ...legacy, schemaVersion: 1 }, authority), /completion_shape/);
  assert.throws(() => validateCompletion(legacy, authority), /completion_shape/);
});


test('R02 family can represent a direct final owner without replacing the result binding', () => {
  const facts = protocolFacts();
  const directBinding = protocolBinding('direct-task', { runId: 'direct-run', callerRunId: null,
    completionTarget: 'RESPONSE_CONTROLLER', finality: true, deliveryPolicy: { eligible: true, reason: null } });
  const childAuthority = createCompletionAuthority({ kind: 'domain-task', binding: directBinding,
    knownFacts: facts, results: [], coverage: 'complete', gaps: [], origin: 'agent' });
  const childRecord = acceptAgentCompletion({ schemaVersion: 3, kind: 'domain-task', facts,
    userResponse: { state: 'usable', text: 'Cleaning started.', language: 'en' } }, childAuthority);
  const workflowFacts = protocolFacts({ domain: null, domainSchemaVersion: null, operation: null });
  const native = { kind: 'final-workflow', binding: { ...directBinding, taskId: null },
    knownFacts: workflowFacts, results: [{ record: childRecord, authority: childAuthority }],
    coverage: 'complete', gaps: [], origin: 'agent' };
  const authority = createCompletionAuthority(native);
  const final = acceptAgentCompletion({ schemaVersion: 3, kind: 'final-workflow', facts: workflowFacts,
    userResponse: childRecord.userResponse }, authority);
  assert.deepEqual(plain(final.results[0]), plain(childRecord));
  assert.deepEqual(plain(final.userResponse), plain(childRecord.userResponse));
  assert.throws(() => createCompletionAuthority({ ...native, binding: { ...native.binding, runId: 'unrelated' } }),
    /direct_result_binding/);
});

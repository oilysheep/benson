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

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

import { p02Facts, p02Binding, p02Evidence, p02Child, p02Workflow, p02Accepted } from './fixtures/completion-v4.mjs';

test('P02 joined admissions and separate execution sessions share one trusted workflow', () => {
  const first = p02Child('first-task');
  const second = p02Child('second-task', { binding: { admissionId: 'admission-2', admissionSequence: 2,
    membershipRevision: 2, acceptedIntentRevision: 2, runGeneration: 2, sessionGeneration: 2 } });
  const workflow = { workflowId: 'workflow-1', conversationId: 'conversation-1', conversationGeneration: 1,
    membershipRevision: 3, acceptedIntentRevision: 2, membershipState: 'closed', admissions: [
      { admissionId: 'admission-1', sequence: 1 }, { admissionId: 'admission-2', sequence: 2 },
    ] };
  const { record, authority } = p02Workflow([first, second], { binding: {
    membershipRevision: 3, acceptedIntentRevision: 2 }, evidence: { workflow } });
  assert.equal(record.schemaVersion, 4);
  assert.equal(record.results[1].binding.admissionId, 'admission-2');
  assert.notEqual(record.results[0].binding.sessionId, record.results[1].binding.sessionId);
  assert.notEqual(record.binding.runId, record.results[0].binding.caller.runId);
  assert.deepEqual(plain(record.results), [plain(first.record), plain(second.record)]);
  assert.deepEqual(plain(validateCompletion(plain(record), authority)), plain(record));
  assert.equal(Object.hasOwn(record.binding, 'admissions'), false);
  assert.throws(() => p02Workflow([first, second], { binding: {
    admissionId: 'admission-2', admissionSequence: 2, membershipRevision: 3, acceptedIntentRevision: 2 },
    evidence: { workflow } }), /final_admission_not_anchor/);
});

test('P02 final workflows accept bounded 0/1/many/max collections and preserve outcomes', () => {
  for (const count of [0, 1, 3, MAX_RESPONSE_RESULTS]) {
    const children = Array.from({ length: count }, (_, index) => p02Child(`task-${index}`));
    for (const origin of ['agent', 'runtime']) {
      const { record, authority } = p02Workflow(children, { evidence: { origin } });
      assert.equal(record.results.length, count);
      assert.equal(record.completion.outcome, origin === 'agent' ? 'NORMAL' : 'RECOVERED');
      assert.deepEqual(plain(record.results), children.map((child) => plain(child.record)));
      assert.deepEqual(plain(validateCompletion(plain(record), authority)), plain(record));
    }
  }
  assert.throws(() => p02Workflow(Array.from({ length: MAX_RESPONSE_RESULTS + 1 }, (_, i) => p02Child(`overflow-${i}`))), /native_evidence_invalid/);
  const child = p02Child('duplicate');
  assert.throws(() => p02Workflow([child, child]), /duplicate_task/);
  assert.throws(() => p02Workflow([], { facts: { verified: true, verificationScope: ['unproven'] } }), /empty_execution_proof/);
  const future = p02Workflow([], { binding: { agentId: 'future-workflow-owner' } }).record;
  assert.equal(future.kind, 'final-workflow');
});

test('P02 final acceptance rejects foreign, future, and unjoined child bindings', () => {
  for (const binding of [{ workflowId: 'foreign' }, { conversationId: 'foreign' },
    { conversationGeneration: 2 }, { membershipRevision: 2 }, { acceptedIntentRevision: 2 },
    { admissionId: 'unjoined', admissionSequence: 2 },
    { caller: { ...p02Binding().caller, agentId: 'foreign-owner' } }]) {
    const child = p02Child('foreign-task', { binding: { ...binding,
      ...(binding.workflowId ? { caller: { ...p02Binding().caller, workflowId: binding.workflowId } } : {}) } });
    assert.throws(() => p02Workflow([child]));
  }
  const oldChild = protocolChild('old-version-child');
  assert.throws(() => p02Workflow([oldChild]));
  const native = p02Evidence({ binding: p02Binding({ role: 'workflow-final', taskId: null,
    caller: null, completionTarget: 'RESPONSE_CONTROLLER', finality: true }),
    knownFacts: p02Facts({ domain: null, domainSchemaVersion: null, operation: null }) });
  assert.throws(() => createCompletionAuthority({ ...native, workflow: {
    ...native.workflow, membershipState: 'open' } }), /membership_not_closed/);
});

test('P02 child facts cannot reconstruct missing owner semantics or accepted intent', () => {
  const child = p02Child('known-success');
  for (const semantics of [null, { ownerRunId: 'final-owner-run', ownerRunGeneration: 1,
    acceptedIntentRevision: 1, coverage: 'incomplete', value: null }]) {
    const { record } = p02Workflow([child], { evidence: { origin: 'runtime', semantics } });
    assert.equal(record.completion.outcome, 'FAILED');
    assert.equal(record.facts.status, 'success');
    assert.deepEqual(plain(record.results[0]), plain(child.record));
    assert.ok(record.completion.gaps.some((gap) => gap.code === 'WORKFLOW_SEMANTICS_NOT_ESTABLISHED'));
    assert.throws(() => p02Workflow([child], { evidence: { semantics } }), /evidence_insufficient/);
  }
  for (const change of [{ ownerRunId: 'stale' }, { ownerRunGeneration: 2 }, { acceptedIntentRevision: 2 }]) {
    assert.throws(() => p02Workflow([child], { evidence: { origin: 'runtime', semantics: {
      ownerRunId: 'final-owner-run', ownerRunGeneration: 1, acceptedIntentRevision: 1,
      coverage: 'complete', value: { answer: 'Requested work started.' }, ...change } } }), /semantic_binding_mismatch/);
  }
  const complete = p02Workflow([child], { evidence: { origin: 'runtime' } }).record;
  assert.equal(complete.completion.outcome, 'RECOVERED');
  assert.equal(complete.facts.status, 'success');
});

test('P02 semantic coverage cannot replace the retained owner meaning itself', () => {
  const child = p02Child('known-child');
  for (const value of [null, {}]) {
    const { record } = p02Workflow([child], { facts: { data: value }, evidence: { origin: 'runtime',
      semantics: { ownerRunId: 'final-owner-run', ownerRunGeneration: 1, acceptedIntentRevision: 1,
        coverage: 'complete', value } } });
    assert.equal(record.completion.outcome, 'FAILED');
    assert.deepEqual(plain(record.results[0]), plain(child.record));
    assert.ok(record.completion.gaps.some((gap) => gap.code === 'WORKFLOW_SEMANTICS_NOT_ESTABLISHED'));
  }
  assert.throws(() => p02Workflow([child], { evidence: { origin: 'runtime', semantics: {
    ownerRunId: 'final-owner-run', ownerRunGeneration: 1, acceptedIntentRevision: 1,
    coverage: 'complete', value: { answer: 'Invented owner meaning.' } } } }), /semantic_evidence_mismatch/);
});

test('P02 workflow reconstruction preserves business failure, partial effects, and missing facts', () => {
  const success = p02Child('success', { evidence: { origin: 'runtime' } });
  const failure = p02Child('failure', { facts: { status: 'failure', verified: false,
    error: { code: 'BUSINESS_FAILURE' }, effects: [] }, evidence: { origin: 'runtime' } });
  const partial = p02Child('partial', { facts: { status: 'partial', verified: false,
    error: { code: 'PARTIAL_EXECUTION' } } });
  const children = [success, failure, partial];
  const { record } = p02Workflow(children, { facts: { status: 'partial', verified: false,
    error: { code: 'PARTIAL_EXECUTION' } }, evidence: { origin: 'runtime' } });
  assert.equal(record.completion.outcome, 'RECOVERED');
  assert.deepEqual(record.results.map((child) => child.facts.status), ['success', 'failure', 'partial']);
  assert.deepEqual(record.results.map((child) => child.completion.outcome), ['RECOVERED', 'RECOVERED', 'NORMAL']);
  const failed = p02Workflow(children, { facts: { status: 'partial', verified: false,
    error: { code: 'PARTIAL_EXECUTION' } }, evidence: { origin: 'runtime', semantics: null } }).record;
  assert.equal(failed.completion.outcome, 'FAILED');
  assert.equal(failed.facts.status, 'partial');
  assert.deepEqual(plain(failed.results), plain(record.results));
  assert.throws(() => p02Workflow(children), /success_hides_result/);
  const childMissing = p02Child('missing', { evidence: { origin: 'runtime', coverage: 'incomplete' } });
  const missing = p02Workflow([childMissing], { evidence: { origin: 'runtime' } }).record;
  assert.equal(missing.completion.outcome, 'FAILED');
  assert.equal(missing.results[0].facts.status, 'success');
  assert.ok(missing.results[0].facts.effects.length);
});

test('P02 accepted child depth survives the final envelope for every outcome and destination', () => {
  for (const [origin, coverage] of [['agent', 'complete'], ['runtime', 'complete'], ['runtime', 'incomplete']]) {
    for (const direct of [false, true]) {
      const binding = direct ? { caller: null, completionTarget: 'RESPONSE_CONTROLLER', finality: true,
        deliveryPolicy: { eligible: true, reason: null } } : {};
      const childAt = (depth) => {
        let data = { effect: 'known' };
        for (let index = 0; index < depth; index++) data = { nested: data };
        return p02Child('deep-child', { binding, facts: { data }, evidence: { origin, coverage } });
      };
      for (const depth of [12, 13]) {
        const child = childAt(depth);
        const final = direct ? p02Accepted(p02Evidence({
          binding: { ...plain(child.record.binding), role: 'direct-final', taskId: null },
          knownFacts: { ...plain(child.record.facts), domain: null, domainSchemaVersion: null, operation: null },
          results: [child], origin, semantics: null,
        }), plain(child.record.userResponse)) : p02Workflow([child], { evidence: { origin } });
        assert.equal(final.record.completion.outcome, child.record.completion.outcome);
        assert.deepEqual(plain(final.record.results[0]), plain(child.record));
        assert.deepEqual(plain(validateCompletion(plain(final.record), final.authority)), plain(final.record));
      }
      assert.throws(() => childAt(14), /json_too_deep/);
    }
  }
});

test('P02 v4 bounds each component and preserves large direct projections', () => {
  const limit = 256 * 1024;
  for (const [origin, coverage] of [['agent', 'complete'], ['runtime', 'complete'], ['runtime', 'incomplete']]) {
    const options = { binding: { caller: null, completionTarget: 'RESPONSE_CONTROLLER', finality: true,
      deliveryPolicy: { eligible: true, reason: null } }, evidence: { origin, coverage },
      userResponse: { state: 'usable', text: '\\'.repeat(4096), language: 'en' } };
    const large = { segments: Array(9).fill('x'.repeat(16384)) };
    // Large valid children retain their own budget in either final path.
    assert.ok(p02Child('sized-task', { ...options, binding: {}, facts: { data: large } }));
    const largeChild = p02Child('sized-task', { ...options, facts: { data: large } });
    const largeFinal = p02Accepted(p02Evidence({
      binding: { ...plain(largeChild.record.binding), role: 'direct-final', taskId: null },
      knownFacts: { ...plain(largeChild.record.facts), domain: null, domainSchemaVersion: null, operation: null },
      results: [largeChild], origin, semantics: null,
    }), plain(largeChild.record.userResponse));
    assert.ok(Buffer.byteLength(JSON.stringify(largeFinal.record)) > limit);
    assert.deepEqual(plain(largeFinal.record.results[0]), plain(largeChild.record));
    assert.deepEqual(plain(validateCompletion(plain(largeFinal.record), largeFinal.authority)), plain(largeFinal.record));

    const childAt = (length) => p02Child('sized-task', { ...options, facts: {
      data: { segments: [...Array(15).fill('x'.repeat(16384)), 'x'.repeat(length)] },
    } });
    let low = 0, high = 16384;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      try { childAt(middle); low = middle; }
      catch (error) { assert.match(error.message, /json_bytes_exceeded/); high = middle - 1; }
    }
    const child = childAt(low);
    assert.throws(() => childAt(low + 1), /json_bytes_exceeded/);
    const binding = { ...plain(child.record.binding), role: 'direct-final', taskId: null };
    const knownFacts = { ...plain(child.record.facts), domain: null, domainSchemaVersion: null, operation: null };
    const { record, authority } = p02Accepted(p02Evidence({ binding, knownFacts, results: [child],
      origin, semantics: null }), plain(child.record.userResponse));
    assert.equal(record.completion.outcome, child.record.completion.outcome);
    assert.deepEqual(plain(record.results[0]), plain(child.record));
    assert.deepEqual(plain(record.facts), knownFacts);
    assert.deepEqual(plain(record.userResponse), plain(child.record.userResponse));
    const componentBytes = Math.max(Buffer.byteLength(JSON.stringify(child.record)),
      Buffer.byteLength(JSON.stringify({ ...record, results: [] })));
    assert.ok(componentBytes <= limit && limit - componentBytes < 1, `${origin}/${coverage}: ${componentBytes}`);
    assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 2 * limit);
    assert.deepEqual(plain(validateCompletion(plain(record), authority)), plain(record));
  }
});

test('P02 composed byte bounds preserve every accepted large caller result', () => {
  const data = { segments: Array(9).fill('x'.repeat(16384)) };
  for (const [origin, coverage] of [['agent', 'complete'], ['runtime', 'complete'], ['runtime', 'incomplete']]) {
    for (const count of [1, 3, MAX_RESPONSE_RESULTS]) {
      const children = Array.from({ length: count }, (_, index) => p02Child(`large-${index}`, {
        facts: { data }, evidence: { origin, coverage },
      }));
      const { record, authority } = p02Workflow(children, { evidence: { origin } });
      assert.equal(record.completion.outcome, children[0].record.completion.outcome);
      assert.deepEqual(plain(record.results), children.map(child => plain(child.record)));
      assert.ok(Buffer.byteLength(JSON.stringify(record)) <= (count + 1) * 256 * 1024 + count - 1);
      assert.deepEqual(plain(validateCompletion(plain(record), authority)), plain(record));
    }
  }
  const small = p02Child('small');
  assert.throws(() => p02Workflow([small], { facts: {
    data: { segments: Array(16).fill('x'.repeat(16300)) },
  }, userResponse: { state: 'usable', text: '\\'.repeat(4096), language: 'en' } }), /json_bytes_exceeded/);
});

test('P02 failed child diagnostics remain bounded for maximum task identities', () => {
  for (const length of [512, 505, 504]) {
    const child = p02Child('x'.repeat(length), { binding: { runId: 'domain-run',
      sessionKey: 'agent:domain:direct', sessionId: 'direct-session', caller: null,
      completionTarget: 'RESPONSE_CONTROLLER', finality: true,
      deliveryPolicy: { eligible: true, reason: null } }, evidence: { origin: 'runtime', coverage: 'incomplete' } });
    const binding = { ...plain(child.record.binding), role: 'direct-final', taskId: null };
    const knownFacts = { ...plain(child.record.facts), domain: null, domainSchemaVersion: null, operation: null };
    const { record } = p02Accepted(p02Evidence({ binding, knownFacts, results: [child], origin: 'runtime', semantics: null }));
    assert.equal(record.completion.outcome, 'FAILED');
    assert.equal(record.facts.status, 'success');
    assert.deepEqual(plain(record.results[0]), plain(child.record));
    assert.deepEqual(record.completion.gaps.map(gap => gap.path), ['results.0']);
  }
  for (const count of [1, 3, MAX_RESPONSE_RESULTS]) {
    const children = Array.from({ length: count }, (_, index) => p02Child(
      String(index).padStart(3, '0') + 'x'.repeat(509), { binding: { runId: `run-${index}`,
        sessionKey: `agent:domain:${index}`, sessionId: `session-${index}` },
      evidence: { origin: 'runtime', coverage: 'incomplete' } }));
    const { record } = p02Workflow(children, { evidence: { origin: 'runtime' } });
    assert.equal(record.completion.outcome, 'FAILED');
    assert.deepEqual(record.completion.gaps.map(gap => gap.path), children.map((_, index) => `results.${index}`));
    assert.deepEqual(plain(record.results), children.map(child => plain(child.record)));
  }
});

test('P02 direct final projection preserves source facts, outcome, wording, and cancellation', () => {
  for (const [origin, coverage] of [['agent', 'complete'], ['runtime', 'complete'], ['runtime', 'incomplete']]) {
    const child = p02Child('direct-task', { binding: { caller: null,
      completionTarget: 'RESPONSE_CONTROLLER', finality: true,
      deliveryPolicy: { eligible: false, reason: 'CANCELLED' } }, evidence: { origin, coverage } });
    const binding = { ...plain(child.record.binding), role: 'direct-final', taskId: null };
    const knownFacts = { ...plain(child.record.facts), domain: null, domainSchemaVersion: null, operation: null };
    const native = p02Evidence({ binding, knownFacts, results: [child], origin, semantics: null });
    const { record, authority } = p02Accepted(native, plain(child.record.userResponse));
    assert.equal(record.completion.outcome, child.record.completion.outcome);
    assert.deepEqual(plain(record.results[0]), plain(child.record));
    assert.deepEqual(plain(record.userResponse), plain(child.record.userResponse));
    assert.equal(record.binding.deliveryPolicy.eligible, false);
    assert.deepEqual(plain(validateCompletion(plain(record), authority)), plain(record));
    assert.throws(() => createCompletionAuthority({ ...native, knownFacts: { ...knownFacts, data: { invented: true } } }), /direct_facts/);
    const forged = plain(record); forged.userResponse = { state: 'usable', text: 'Rewritten.', language: 'en' };
    assert.throws(() => validateCompletion(forged, authority), /direct_response/);
  }
});

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
    generation: 1, taskId, callerRunId: taskId === null ? null : 'main-original-run',
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
  const replayed = plain(record); replayed.binding.generation++;
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

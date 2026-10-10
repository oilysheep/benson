import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPLETION_SCHEMA_VERSION, CURRENT_COMPLETION_SCHEMA_VERSION,
  SUCCESSOR_COMPLETION_SCHEMA_VERSION, createCompletionAuthority, acceptAgentCompletion,
  reconstructCompletion, validateCompletion, completionProposalSchema } from '../envelope.mjs';

// Synthetic trusted-owner inputs exercise the inactive contract, not host custody.
const copy = value => JSON.parse(JSON.stringify(value));
const response = { state: 'usable', text: 'Cleaning started.', language: 'en' };
const facts = (changes = {}) => ({ status: 'success', domain: 'jessica-vacuum',
  domainSchemaVersion: '1', operation: 'clean', verified: true,
  verificationScope: ['command_started'], data: { operationId: 'original-operation', started: true },
  warnings: [], error: null, effects: [{ kind: 'command_started', operationId: 'original-operation' }],
  uncertainty: [{ kind: 'physical_completion_not_established' }], pendingContext: null, ...changes });
const caller = (changes = {}) => ({ runId: 'main-run', runGeneration: 1, agentId: 'main',
  sessionKey: 'agent:main:owner', sessionId: 'main-session', sessionGeneration: 1, ...changes });
const binding = (changes = {}) => ({ inputId: 'original-input', admissionId: 'admission-2',
  conversationId: 'conversation-1', conversationGeneration: 1,
  runId: 'domain-run', runGeneration: 1, agentId: 'jessica-vacuum',
  sessionKey: 'agent:jessica-vacuum:child', sessionId: 'domain-session', sessionGeneration: 1,
  domain: 'jessica-vacuum', taskId: 'task-1', caller: caller(), completionTarget: 'CALLER',
  authorizationId: 'original-grant', parentContinuation: { eligible: true, reason: null },
  deliveryPolicy: { eligible: false, reason: null }, ...changes });
const evidence = (changes = {}) => ({ schemaVersion: SUCCESSOR_COMPLETION_SCHEMA_VERSION,
  kind: 'domain-task', binding: binding(), knownFacts: facts(), results: [],
  coverage: 'complete', gaps: [], origin: 'agent', ...changes });
function accepted(native = evidence(), userResponse = response) {
  const authority = createCompletionAuthority(native);
  const record = native.origin === 'runtime' ? reconstructCompletion(authority) :
    acceptAgentCompletion({ schemaVersion: SUCCESSOR_COMPLETION_SCHEMA_VERSION,
      kind: native.kind, facts: native.knownFacts, userResponse }, authority);
  return { record, authority };
}
function child(index, changes = {}, userResponse = response) {
  return accepted(evidence({ ...changes, binding: binding({ inputId: `input-${index}`,
    admissionId: `admission-${index}`, runId: `domain-run-${index}`, taskId: `task-${index}`,
    sessionKey: `agent:jessica-vacuum:${index}`, sessionId: `session-${index}`, ...changes.binding }) }), userResponse);
}
function main(results = [], changes = {}) {
  return accepted(evidence({ ...changes, kind: 'agent-run',
    binding: binding({ ...caller(), admissionId: 'main-admission', taskId: null, domain: null,
      caller: null, completionTarget: 'RESPONSE_CONTROLLER',
      parentContinuation: { eligible: false, reason: null },
      deliveryPolicy: { eligible: true, reason: null }, ...changes.binding }),
    knownFacts: facts({ domain: null, domainSchemaVersion: null, operation: null,
      verified: results.length ? true : 'not_applicable',
      verificationScope: results.length ? ['retained_domain_results'] : [],
      data: { answer: 'Owner-authored answer' }, effects: [], uncertainty: [], ...changes.knownFacts }), results }));
}
function roundTrip({ record, authority }) {
  assert.deepEqual(copy(validateCompletion(copy(record), authority)), copy(record));
  assert.ok(Object.isFrozen(record));
}

test('v5 is explicit; legacy versions/defaults and no-Run contracts are separate', () => {
  assert.equal(COMPLETION_SCHEMA_VERSION, 3);
  assert.equal(CURRENT_COMPLETION_SCHEMA_VERSION, 4);
  assert.equal(SUCCESSOR_COMPLETION_SCHEMA_VERSION, 5);
  for (const schemaVersion of [1, 2, 6, '5', null, undefined]) {
    assert.throws(() => createCompletionAuthority(evidence({ schemaVersion })), /version_or_kind/);
  }
  const implicit = evidence(); delete implicit.schemaVersion;
  assert.throws(() => createCompletionAuthority(implicit), /binding_shape/);
  for (const kind of ['final-workflow', 'benson.no-run', 'benson.source-input']) {
    assert.throws(() => createCompletionAuthority(evidence({ kind })), /native_evidence_invalid/);
  }
  const { authority } = accepted();
  assert.throws(() => validateCompletion({ schemaVersion: 1, kind: 'benson.no-run' }, authority));
});

test('direct domain Run settles without a workflow/final wrapper or extra child', () => {
  const value = accepted(evidence({ binding: binding({ caller: null,
    completionTarget: 'RESPONSE_CONTROLLER', parentContinuation: { eligible: false, reason: null },
    deliveryPolicy: { eligible: true, reason: null } }) }));
  roundTrip(value);
  assert.equal(value.record.kind, 'domain-task');
  assert.equal(value.record.results.length, 0);
  assert.equal(value.record.completion.outcome, 'NORMAL');
  assert.deepEqual(copy(value.record.facts), facts());
  assert.deepEqual(copy(value.record.userResponse), response);
});

test('headless actual Runs settle with neither continuation nor outbound eligibility', () => {
  for (const origin of ['agent', 'runtime']) {
    const value = accepted(evidence({ origin, binding: binding({ conversationId: null,
      conversationGeneration: null, caller: null, completionTarget: 'NATIVE',
      parentContinuation: { eligible: false, reason: 'NO_PARENT' },
      deliveryPolicy: { eligible: false, reason: 'NO_NOTIFICATION_GRANT' } }) }));
    roundTrip(value);
    assert.equal(value.record.completion.outcome, origin === 'agent' ? 'NORMAL' : 'RECOVERED');
    assert.equal(value.record.facts.status, 'success');
    assert.equal(value.record.binding.deliveryPolicy.eligible, false);
  }
  roundTrip(main([], { origin: 'runtime', binding: { conversationId: null,
    conversationGeneration: null, completionTarget: 'NATIVE',
    deliveryPolicy: { eligible: false, reason: 'HEADLESS' } } }));
});

test('revoked parent/outbound eligibility does not erase settlement or possible effects', () => {
  for (const completionTarget of ['CALLER', 'RESPONSE_CONTROLLER', 'NATIVE']) {
    const value = accepted(evidence({ origin: 'runtime', coverage: 'incomplete',
      binding: binding({ completionTarget,
        parentContinuation: { eligible: false, reason: 'PARENT_CANCELLED' },
        deliveryPolicy: { eligible: false, reason: 'AUTHORITY_REVOKED' } }),
      knownFacts: facts({ effects: [{ kind: 'command_possible', operationId: 'original-operation' }] }) }));
    roundTrip(value);
    assert.equal(value.record.completion.outcome, 'FAILED');
    assert.equal(value.record.facts.status, 'success');
    assert.deepEqual(copy(value.record.facts.effects), [{ kind: 'command_possible', operationId: 'original-operation' }]);
    assert.equal(value.record.userResponse.state, 'unavailable');
  }
});

test('eligibility policies and trusted routing cannot redirect or invent a parent', () => {
  for (const changes of [
    { caller: null }, { caller: caller({ runId: 'domain-run' }) },
    { caller: { ...caller(), workflowId: 'old-workflow' } },
    { completionTarget: 'NATIVE' },
    { deliveryPolicy: { eligible: true, reason: null } },
    { parentContinuation: { eligible: 'true', reason: null } },
    { parentContinuation: { eligible: false, reason: 'untyped reason' } },
    { deliveryPolicy: { eligible: false } }, { completionTarget: 'AGENT_CHOSEN' },
    { conversationId: null }, { conversationGeneration: null },
  ]) assert.throws(() => accepted(evidence({ binding: binding(changes) })));
  // A retained parent identity alone does not make a continuation eligible.
  roundTrip(accepted(evidence({ binding: binding({ completionTarget: 'NATIVE',
    parentContinuation: { eligible: false, reason: 'PARENT_TERMINAL' } }) })));
});

test('removed lifecycle fields are rejected in v5 without changing vendor program IDs', () => {
  for (const field of ['workflowId', 'membershipRevision', 'acceptedIntentRevision',
    'admissionSequence', 'role', 'finality', 'membershipState']) {
    assert.throws(() => accepted(evidence({ binding: { ...binding(), [field]: 'obsolete' } })), /binding_shape/);
  }
  for (const field of ['workflow', 'semantics']) {
    assert.throws(() => accepted({ ...evidence(), [field]: null }), /native_evidence_shape/);
  }
  const value = accepted(evidence({ knownFacts: facts({ data: { workflowId: 'vendor-saved-program' } }) }));
  roundTrip(value);
  assert.equal(value.record.facts.data.workflowId, 'vendor-saved-program');
});

test('trusted input/domain/Run binding and original operation survive distinct fresh Runs', () => {
  const first = accepted();
  const second = accepted(evidence({ binding: binding({ runId: 'fresh-domain-run', runGeneration: 2,
    sessionId: 'fresh-session', sessionGeneration: 2 }) }));
  for (const value of [first, second]) {
    roundTrip(value);
    assert.equal(value.record.binding.inputId, 'original-input');
    assert.equal(value.record.binding.authorizationId, 'original-grant');
    assert.equal(value.record.facts.data.operationId, 'original-operation');
  }
  for (const key of ['inputId', 'admissionId', 'authorizationId', 'runId', 'sessionId', 'taskId', 'agentId']) {
    assert.throws(() => accepted(evidence({ binding: binding({ [key]: null }) })));
    const forged = copy(first.record); forged.binding[key] = 'foreign';
    assert.throws(() => validateCompletion(forged, first.authority));
  }
  assert.throws(() => accepted(evidence({ binding: binding({ domain: 'reminder' }) })), /domain_binding/);
  assert.throws(() => accepted(evidence({ knownFacts: facts({ domain: 'reminder',
    domainSchemaVersion: 'legacy-unversioned' }) })), /domain_binding/);
  const reminder = accepted(evidence({ binding: binding({ domain: 'reminder', agentId: 'reminder-service' }),
    knownFacts: facts({ domain: 'reminder', domainSchemaVersion: 'legacy-unversioned', operation: 'create' }) }));
  roundTrip(reminder);
});

test('Main aggregates exact independently bound domain Run results, without membership or anchoring', () => {
  const results = Array.from({ length: 16 }, (_, i) => child(i));
  const value = main(results);
  roundTrip(value);
  assert.equal(value.record.kind, 'agent-run');
  assert.equal(value.record.results.length, 16);
  assert.deepEqual(copy(value.record.results), results.map(value => copy(value.record)));
  // Distinct input/admission identities are retained; none is a first-member anchor.
  assert.equal(value.record.binding.admissionId, 'main-admission');
  assert.equal(value.record.results[0].binding.admissionId, 'admission-0');
  assert.throws(() => main([...results, child(16)]), /native_evidence_invalid/);
  assert.throws(() => main([results[0], results[0]]), /duplicate_task/);
  assert.throws(() => main([results[0], child(1, { binding: { runId: 'domain-run-0' } })]), /duplicate_run/);
  roundTrip(main()); // A Main answer need not manufacture a domain child Run.
});

test('child-to-parent correlation checks the full original native tuple', () => {
  for (const key of ['runId', 'runGeneration', 'agentId', 'sessionKey', 'sessionId', 'sessionGeneration']) {
    const foreign = caller({ [key]: key.endsWith('Generation') ? 2 : `foreign-${key}` });
    assert.throws(() => main([child(1, { binding: { caller: foreign } })]), /result_correlation/);
  }
  for (const changes of [{ conversationId: 'foreign-conversation' }, { conversationGeneration: 2 },
    { caller: null, completionTarget: 'NATIVE', parentContinuation: { eligible: false, reason: null } }]) {
    assert.throws(() => main([child(1, { binding: changes })]), /result_correlation/);
  }
  // Reporting a retained child is independent of permission to continue its parent.
  roundTrip(main([child(1, { binding: { completionTarget: 'NATIVE',
    parentContinuation: { eligible: false, reason: 'PARENT_TERMINAL' } } })]));
});

test('owner-authored facts, native handles and completion quality cannot be forged', () => {
  const { record, authority } = accepted();
  assert.throws(() => validateCompletion(record, {}), /native_completion_authority_required/);
  const proposal = { schemaVersion: 5, kind: 'domain-task', facts: facts(), userResponse: response };
  assert.throws(() => acceptAgentCompletion({ ...proposal, binding: binding() }, authority), /agent_completion_shape/);
  assert.throws(() => acceptAgentCompletion({ ...proposal, facts: facts({ effects: [] }) }, authority), /evidence_mismatch/);
  for (const change of [value => { value.facts.effects = []; }, value => { value.facts.data = { invented: true }; },
    value => { value.completion.outcome = 'RECOVERED'; },
    value => { value.binding.deliveryPolicy.eligible = true; }]) {
    const forged = copy(record); change(forged);
    assert.throws(() => validateCompletion(forged, authority));
  }
  assert.throws(() => reconstructCompletion(authority), /origin_mismatch/);
  const schema = completionProposalSchema(authority);
  assert.equal(schema.properties.schemaVersion.const, 5);
  assert.equal(schema.properties.kind.const, 'domain-task');
  assert.equal(schema.additionalProperties, false);
  assert.equal(Object.hasOwn(schema.properties, 'binding'), false);
});

test('FAILED reconstruction retains known facts when evidence fields are missing', () => {
  for (const field of ['domain', 'domainSchemaVersion', 'verificationScope', 'error', 'pendingContext']) {
    const knownFacts = facts(); delete knownFacts[field];
    assert.throws(() => accepted(evidence({ knownFacts })), /evidence_insufficient/);
    const value = accepted(evidence({ origin: 'runtime', knownFacts }));
    roundTrip(value);
    assert.equal(value.record.completion.outcome, 'FAILED');
    assert.equal(value.record.facts.status, 'success');
    assert.deepEqual(copy(value.record.facts.effects), facts().effects);
    assert.ok(value.record.completion.gaps.some(gap => gap.path === `facts.${field}`));
  }
});

test('missing facts cannot relax the domain/schema established by the trusted binding', () => {
  for (const [domain, agentId, schema, foreignDomain, foreignSchema] of [
    ['jessica-vacuum', 'jessica-vacuum', '1', 'reminder', 'legacy-unversioned'],
    ['reminder', 'reminder-service', 'legacy-unversioned', 'jessica-vacuum', '1'],
  ]) {
    for (const coverage of ['complete', 'incomplete']) {
      const ownerBinding = binding({ domain, agentId });
      const knownFacts = facts({ domain, domainSchemaVersion: foreignSchema });
      delete knownFacts.domain; // Exact failing shape: only the domain fact is absent.
      const original = copy(knownFacts);
      assert.throws(() => accepted(evidence({ origin: 'runtime', coverage,
        binding: ownerBinding, knownFacts })), /completion_domain_version/);
      assert.deepEqual(knownFacts, original); // Reject without rewriting effects or facts.
      const otherMissing = facts({ domain: foreignDomain, domainSchemaVersion: schema });
      delete otherMissing.domainSchemaVersion;
      assert.throws(() => accepted(evidence({ origin: 'runtime', coverage,
        binding: ownerBinding, knownFacts: otherMissing })), /completion_domain_binding/);
      const valid = facts({ domain, domainSchemaVersion: schema }); delete valid.domain;
      const value = accepted(evidence({ origin: 'runtime', coverage,
        binding: ownerBinding, knownFacts: valid }));
      roundTrip(value);
      assert.equal(value.record.completion.outcome, 'FAILED');
      assert.equal(value.record.facts.domainSchemaVersion, schema);
      assert.deepEqual(copy(value.record.facts.effects), valid.effects);
    }
  }
});

test('business outcome and completion quality remain independent through recovery', () => {
  const scenarios = [facts(), facts({ status: 'partial', verified: false }),
    facts({ status: 'failure', verified: false, error: { code: 'COMMAND_REJECTED' } }),
    facts({ status: 'unknown', verified: 'unknown', uncertainty: [{ kind: 'effect_possible' }] })];
  for (const knownFacts of scenarios) {
    for (const coverage of ['complete', 'incomplete']) {
      const value = accepted(evidence({ origin: 'runtime', coverage, knownFacts }));
      roundTrip(value);
      assert.equal(value.record.facts.status, knownFacts.status);
      assert.deepEqual(copy(value.record.facts.effects), knownFacts.effects);
      assert.equal(value.record.completion.outcome, coverage === 'complete' ? 'RECOVERED' : 'FAILED');
      const forged = copy(value.record); forged.userResponse = response;
      assert.throws(() => validateCompletion(forged, value.authority), /runtime_response_mismatch/);
    }
  }
});

test('malformed submissions cannot hide effects; independent reconstruction does not replay work', () => {
  const recovered = accepted(evidence({ origin: 'runtime', coverage: 'incomplete' }));
  const malformed = copy(recovered.record); delete malformed.userResponse;
  assert.throws(() => validateCompletion(malformed, recovered.authority), /completion_shape/);
  roundTrip(recovered);
  assert.deepEqual(copy(reconstructCompletion(recovered.authority).facts.effects), facts().effects);
  const failedChild = child(1, { origin: 'runtime', coverage: 'incomplete' });
  assert.throws(() => main([failedChild]), /evidence_insufficient/);
  const parent = main([failedChild], { origin: 'runtime' });
  roundTrip(parent);
  assert.equal(parent.record.completion.outcome, 'FAILED');
  assert.deepEqual(copy(parent.record.results[0]), copy(failedChild.record));
  assert.ok(parent.record.completion.gaps.some(gap => gap.code === 'CHILD_COMPLETION_INCOMPLETE'));
});

test('success cannot hide a failed business result or fabricate proof of empty execution', () => {
  const failed = child(1, { knownFacts: facts({ status: 'failure', verified: false, error: { code: 'FAILED_COMMAND' } }) });
  assert.throws(() => main([failed]), /success_hides_result/);
  assert.throws(() => main([], { knownFacts: { verified: true, verificationScope: ['invented_execution'] } }),
    /empty_execution_proof/);
  roundTrip(main([failed], { knownFacts: { status: 'failure', verified: false, error: { code: 'DOMAIN_FAILED' } } }));
});

test('completion response budgets and malformed candidates fail closed', () => {
  const { authority } = accepted();
  const proposal = userResponse => ({ schemaVersion: 5, kind: 'domain-task', facts: facts(), userResponse });
  for (const userResponse of [null, {}, { ...response, text: '' }, { ...response, text: ' ' },
    { ...response, text: 'x'.repeat(4097) }, { ...response, language: 'xx' }, { state: 'unavailable' }]) {
    assert.throws(() => acceptAgentCompletion(proposal(userResponse), authority));
  }
  roundTrip(accepted(evidence(), { ...response, text: 'x'.repeat(4096) }));
});

test('v5 preserves 256 KiB/depth-16 components and lossless 16-result aggregate capacity', () => {
  const limit = 262144;
  for (const origin of ['agent', 'runtime']) {
    // The constructor also reserves its canonical recovery wording. Use the
    // same wording so the final record itself reaches the component boundary.
    const childAt = length => child(0, { origin, knownFacts: facts({
      data: { segments: [...Array(15).fill('x'.repeat(16384)), 'x'.repeat(length)] } }) },
      { state: 'unavailable', reason: { code: 'RUNTIME_WORDING_UNAVAILABLE',
        detail: 'No owner-authored usable message is retained.' } });
    let low = 0, high = 16384;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      try { childAt(middle); low = middle; }
      catch (error) { assert.match(error.message, /json_bytes_exceeded/); high = middle - 1; }
    }
    const boundary = childAt(low);
    assert.equal(Buffer.byteLength(JSON.stringify(boundary.record)), limit);
    assert.throws(() => childAt(low + 1), /json_bytes_exceeded/);
    roundTrip(boundary);
    const results = Array.from({ length: 16 }, (_, i) => child(i, { origin,
      knownFacts: facts({ data: { segments: Array(15).fill('x'.repeat(16384)) } }) }));
    const aggregate = main(results, { origin });
    assert.ok(Buffer.byteLength(JSON.stringify(aggregate.record)) > 16 * 245760);
    assert.ok(Buffer.byteLength(JSON.stringify(aggregate.record)) <= limit * 17 + 15);
    roundTrip(aggregate);
    assert.deepEqual(copy(aggregate.record.results), results.map(value => copy(value.record)));
    // Child component depth 16 embeds losslessly at aggregate depth 18.
    const deepAt = depth => {
      let data = { effect: 'known' };
      for (let i = 0; i < depth; i++) data = { nested: data };
      return child(0, { origin, knownFacts: facts({ data }) });
    };
    roundTrip(main([deepAt(13)], { origin }));
    assert.throws(() => deepAt(14), /json_too_deep/);
  }
});

test('unknown domain versions, bounds and mixed completion generations cannot be upgraded silently', () => {
  for (const changes of [{ domainSchemaVersion: 'future' },
    { effects: Array.from({ length: 65 }, () => ({ kind: 'known' })) },
    { uncertainty: Array.from({ length: 65 }, () => ({ kind: 'possible' })) }]) {
    assert.throws(() => accepted(evidence({ knownFacts: facts(changes) })));
  }
  const result = child(1);
  const downgraded = copy(result.record); downgraded.schemaVersion = 4;
  assert.throws(() => validateCompletion(downgraded, result.authority));
  assert.throws(() => main([{ record: downgraded, authority: result.authority }]));
});

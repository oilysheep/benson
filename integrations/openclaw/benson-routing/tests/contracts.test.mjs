import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { executeNormalizedReminderTool } from "../../plugins/benson-reminder-tool/dist/contracts.js";
import {
  CONTROL_CONTRACT_VERSION, RESPONSE_CONTRACT_VERSION, MAX_RESPONSE_RESULTS, MAX_RENDERED_TEXT,
  assertPendingContextBinding, completionRoute, createExecutionRoute, createResponseEnvelope,
  deriveResponseStatus, normalizeLegacyTaskResult,
  validateRenderedOutput, validateResponseEnvelope, validateTaskResultEnvelope,
} from "../envelope.mjs";

const policy = { allowedModes: ["deterministic", "safe_failure"], preferredMode: "deterministic" };
const trustedLegacy = {
  taskId: "native:task/1",
  pendingBinding: { requesterId: "oren", conversationId: "whatsapp:+972/turn" },
  pendingExpiresAt: "2026-09-25T22:00:00+03:00",
};
const corpus = JSON.parse(await readFile(new URL("./fixtures/presentation-cases.json", import.meta.url)));
const accepted = corpus.cases.filter((item) => item.validation.expected === "accept");

function result(raw, taskId = "task-1") {
  return normalizeLegacyTaskResult(raw, { ...trustedLegacy, taskId,
    pendingExpiresAt: raw.domain === "jessica-vacuum" && raw.pendingContext
      ? raw.pendingContext.expiresAt : trustedLegacy.pendingExpiresAt });
}
function response(results, status = results.length ? deriveResponseStatus(results) : "success") {
  return {
    schemaVersion: RESPONSE_CONTRACT_VERSION, requestId: "native-request-1",
    source: { type: "main", agentId: "main", runId: "main-run-1" },
    status, results, pendingContext: results.find((item) => item.pendingContext)?.pendingContext ?? null,
    messageCandidate: null, responsePolicy: policy,
    lifecycle: { domainExecution: results.length ? "attempted" : "none", failure: null },
    provenance: {
      executionVerified: results.length ? results.every((item) => item.verified) : "not_applicable",
      completionCorrelated: results.length > 0,
    },
  };
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test("accepted Jessica and Reminder legacy facts migrate losslessly", () => {
  assert.ok(accepted.some((item) => item.domain === "jessica"));
  assert.ok(accepted.some((item) => item.domain === "reminder"));
  for (const [index, item] of accepted.entries()) {
    const normalized = result(item.result, "native-task-" + index);
    assert.equal(normalized.schemaVersion, 1, item.id);
    assert.equal(normalized.domainSchemaVersion,
      item.domain === "jessica" ? "1" : "legacy-unversioned", item.id);
    for (const key of ["status", "domain", "operation", "verified", "data", "warnings", "error"]) {
      assert.deepEqual(plain(normalized[key]), item.result[key], item.id + ":" + key);
    }
    assert.deepEqual(plain(normalized.pendingContext?.value ?? null),
      item.result.pendingContext, item.id + ":pendingContext");
    assert.equal(normalized.messageCandidate, null);
    assert.ok(Object.isFrozen(normalized));
  }
});

test("legacy model payload cannot author route, trusted task link, verification, or version", () => {
  const legacy = accepted.find((item) => item.domain === "jessica").result;
  for (const field of ["taskId", "completionTarget", "responsePolicy", "provenance", "source"]) {
    assert.throws(() => result({ ...legacy, [field]: "forged" }), /legacy_result_shape/);
  }
  assert.throws(() => result({ ...legacy, schemaVersion: "future-2" }), /legacy_version_or_domain/);
  const normalized = result(legacy);
  assert.throws(() => validateTaskResultEnvelope({
    ...normalized, domainSchemaVersion: "future-2",
  }), /task_result_invalid/);
  assert.throws(() => result({ ...legacy, verified: false }), /task_result_invalid/);
  assert.throws(() => result({ ...legacy, warnings: ["not structured"] }), /task_result_invalid/);
  assert.throws(() => result({ ...legacy, data: () => "forged" }), /json_invalid_or_oversized/);
});

test("pending context retains exact value and requires trusted binding and expiry", () => {
  for (const item of accepted.filter((entry) => entry.result.pendingContext)) {
    assert.throws(
      () => normalizeLegacyTaskResult(item.result, { ...trustedLegacy, pendingBinding: null }),
      /legacy_pending_binding_required/,
    );
    assert.throws(
      () => normalizeLegacyTaskResult(item.result, { ...trustedLegacy, pendingExpiresAt: null }),
      /legacy_pending_binding_required/,
    );
    const normalized = result(item.result);
    assert.deepEqual(plain(normalized.pendingContext.value), item.result.pendingContext);
    assert.deepEqual(plain(normalized.pendingContext.binding), trustedLegacy.pendingBinding);
  }
});

test("trusted route separates executor and completion destination", () => {
  const route = createExecutionRoute({
    schemaVersion: 1, requestId: "request-1", executionOwner: "reminder-service",
    completionTarget: "CALLER", callerRunId: "main-run-1", responsePolicy: policy,
  });
  assert.deepEqual(completionRoute(route), {
    schemaVersion: 1, requestId: "request-1", executionOwner: "reminder-service",
    completionTarget: "CALLER", callerRunId: "main-run-1",
  });
  assert.throws(() => createExecutionRoute({ ...route, callerRunId: null }), /route_invalid/);
  assert.throws(() => createExecutionRoute({ ...route, completionTarget: "RESPONSE_CONTROLLER" }), /route_invalid/);
  assert.throws(() => createExecutionRoute({ ...route, recipient: "forged" }), /route_shape/);
  assert.throws(() => createExecutionRoute({ ...route, schemaVersion: 2 }), /route_invalid/);
});

test("response status preserves partial outcomes and per-result facts", () => {
  const success = result(accepted.find((item) => item.result.status === "success").result, "task-a");
  const failure = result(accepted.find((item) => item.result.status === "failure").result, "task-b");
  const mixed = [success, failure];
  assert.equal(deriveResponseStatus(mixed), "partial");
  const envelope = validateResponseEnvelope(response(mixed));
  assert.equal(envelope.status, "partial");
  assert.deepEqual(plain(envelope.results[1].error), plain(failure.error));
  assert.throws(() => validateResponseEnvelope(response(mixed, "success")), /response_results_invalid/);
  assert.throws(() => validateResponseEnvelope({
    ...response(mixed), provenance: { executionVerified: true, completionCorrelated: true },
  }), /response_results_invalid/);
  assert.throws(() => deriveResponseStatus(Array(MAX_RESPONSE_RESULTS + 1).fill(success)), /response_results_count/);
  assert.throws(() => validateResponseEnvelope(response([success, success])), /duplicate_task_result/);
});

test("Main-only conversation uses explicit not-applicable execution verification", () => {
  const mainOnly = response([]);
  assert.deepEqual(validateResponseEnvelope(mainOnly).results, []);
  assert.throws(() => validateResponseEnvelope({
    ...mainOnly, provenance: { executionVerified: true, completionCorrelated: false },
  }), /no_domain_result_invalid/);
  assert.throws(() => validateResponseEnvelope({
    ...mainOnly, source: { type: "direct", agentId: "jessica-vacuum", runId: "run" },
  }), /no_domain_result_invalid/);
});

test("agent response input cannot supply trusted route, source, policy, or provenance", () => {
  const trusted = response([]);
  const { messageCandidate: unused, schemaVersion: ignored, ...control } = trusted;
  const envelope = createResponseEnvelope({
    messageCandidate: { text: "Hello.", language: "en" },
  }, control);
  assert.equal(envelope.messageCandidate.text, "Hello.");
  for (const field of ["requestId", "source", "responsePolicy", "provenance", "results", "status"]) {
    assert.throws(() => createResponseEnvelope({
      messageCandidate: null, [field]: "forged",
    }, control), /response_candidate_shape/);
  }
  assert.throws(() => validateResponseEnvelope({ ...envelope, schemaVersion: 1 }), /response_invalid/);
});

test("rendered output is bounded and rejects unversioned authority claims", () => {
  assert.equal(validateRenderedOutput({ schemaVersion: 2, message: "Done." }).message, "Done.");
  assert.throws(() => validateRenderedOutput({ schemaVersion: 1, message: "Done." }), /rendered_invalid/);
  assert.throws(() => validateRenderedOutput({ schemaVersion: 2, message: "x".repeat(MAX_RENDERED_TEXT + 1) }), /rendered_invalid/);
  assert.throws(() => validateRenderedOutput({ schemaVersion: 2, message: "Done.", verified: true }), /rendered_shape/);
});


test("Reminder adapter retains the complete deterministic collection and keeps candidate text separate", async () => {
  const matches = [{ reminderId: "a", content: "First", status: "active" },
    { reminderId: "b", content: "Second", status: "paused" }];
  const serviceResult = { status: "success", operation: "list", verified: true,
    matchCount: matches.length, matches, warnings: [] };
  const definition = { name: "benson_reminder_list", operation: "list-reminders", schema: {} };
  const dependencies = { validateJsonSchemaValue: ({ value }) => ({ ok: true, value }),
    runReminderService: async () => serviceResult };
  const candidate = { text: "All done", language: "en" };
  let invoked = false;
  await assert.rejects(executeNormalizedReminderTool(definition, { requesterId: "oren" },
    undefined, { ...dependencies, runReminderService: async () => { invoked = true; return serviceResult; } },
    { ...trustedLegacy, taskId: "" }), /identity is unavailable/);
  assert.equal(invoked, false);
  const envelope = await executeNormalizedReminderTool(definition, { requesterId: "oren" },
    undefined, dependencies, trustedLegacy, candidate);
  assert.deepEqual(plain(envelope.data), { matchCount: 2, matches });
  assert.deepEqual(plain(envelope.messageCandidate), candidate);
  assert.equal(envelope.verified, true);
  await assert.rejects(executeNormalizedReminderTool(definition, { requesterId: "oren" },
    undefined, { ...dependencies, runReminderService: async () => ({ ...serviceResult, matchCount: 1 }) },
    trustedLegacy, candidate), /incomplete/);
  await assert.rejects(executeNormalizedReminderTool(definition, { requesterId: "oren" },
    undefined, { ...dependencies, runReminderService: async () => ({ ...serviceResult, verified: false }) },
    trustedLegacy, candidate), /contradicts service verification/);
});

test("Reminder adapter preserves transaction, Calendar, warnings and pending delivery truth", async () => {
  const serviceResult = { status: "success", operation: "pause", reminderId: "r-1",
    idempotent: false, transaction: { status: "success", verified: true },
    data: { record: { reminderId: "r-1", status: "paused",
      calendar: { requested: true, eventId: "calendar-1" } } },
    transport: { deliveries: [{ kind: "reminder_lifecycle", status: "pending",
      idempotencyKey: "delivery-1", onFailure: { status: "warning", stateChangePreserved: true } }],
      deliveryFailurePolicy: { status: "warning", stateChangePreserved: true } },
    warnings: [{ code: "DELIVERY_PENDING", message: "Pending native delivery" }] };
  const definition = { name: "benson_reminder_pause", operation: "pause-reminder", schema: {} };
  const dependencies = { validateJsonSchemaValue: ({ value }) => ({ ok: true, value }),
    runReminderService: async () => serviceResult };
  const envelope = await executeNormalizedReminderTool(definition,
    { requesterId: "oren", reminderId: "r-1" }, undefined, dependencies, trustedLegacy);
  assert.equal(envelope.status, "success");
  assert.equal(envelope.data.transaction.verified, true);
  assert.equal(envelope.data.transport.deliveries[0].status, "pending");
  assert.deepEqual(plain(envelope.warnings), serviceResult.warnings);
  assert.equal(envelope.data.data.record.calendar.eventId, "calendar-1");
  await assert.rejects(executeNormalizedReminderTool(definition,
    { requesterId: "oren", reminderId: "r-1" }, undefined,
    { ...dependencies, runReminderService: async () => ({ ...serviceResult,
      transaction: { status: "success", verified: false } }) }, trustedLegacy,
    { text: "Paused", language: "en" }), /unverified/);
});


test("Reminder pending continuation keeps exact context and rejects foreign or expired binding", () => {
  const raw = accepted.find((item) => item.id === "reminder-clarification-exact-context-en").result;
  const normalized = result(raw);
  assert.deepEqual(plain(normalized.pendingContext.value), raw.pendingContext);
  assert.deepEqual(plain(assertPendingContextBinding(normalized.pendingContext,
    trustedLegacy.pendingBinding, new Date("2026-09-25T18:00:00Z")).value), raw.pendingContext);
  assert.throws(() => assertPendingContextBinding(normalized.pendingContext,
    { requesterId: "maya", conversationId: trustedLegacy.pendingBinding.conversationId },
    new Date("2026-09-25T18:00:00Z")), /pending_binding_or_expiry/);
  assert.throws(() => assertPendingContextBinding(normalized.pendingContext,
    trustedLegacy.pendingBinding, new Date("2026-09-25T20:00:00Z")), /pending_binding_or_expiry/);
});

// R02: new consumers use only this family; legacy v1/v2 readers above are retained
// for an explicit future cutover, never silently promoted to the new protocol.
import { COMPLETION_SCHEMA_VERSION, createCompletionAuthority, acceptAgentCompletion,
  reconstructCompletion, validateCompletion, COMPLETION_STATUSES } from '../envelope.mjs';

const newFacts = (changes = {}) => ({ status: 'success', domain: 'jessica-vacuum',
  domainSchemaVersion: '1', operation: 'clean', verified: true,
  verificationScope: ['command_started'], data: { operationId: 'op-1', started: true },
  warnings: [], error: null, effects: [{ kind: 'command_started', operationId: 'op-1' }],
  uncertainty: [{ kind: 'physical_completion_not_established' }], pendingContext: null, ...changes });
const newBinding = (changes = {}) => ({ requestId: 'request-r02', workflowId: 'workflow-r02',
  runId: 'run-r02', agentId: 'jessica-vacuum', sessionKey: 'agent:main:oren',
  sessionId: 'session-r02', generation: 1, taskId: 'task-r02', callerRunId: 'caller-r02',
  completionTarget: 'CALLER', finality: false, authorizationId: 'authorization-r02',
  deliveryPolicy: { eligible: false, reason: null }, ...changes });
const unavailableResponse = { state: 'unavailable', reason: {
  code: 'OWNER_MESSAGE_UNAVAILABLE', detail: 'Owner did not retain wording.' } };
const nativeEvidence = (changes = {}) => ({ kind: 'domain-task', binding: newBinding(),
  knownFacts: newFacts(), results: [], coverage: 'complete', gaps: [], origin: 'agent', ...changes });
const proposal = (changes = {}) => ({ schemaVersion: COMPLETION_SCHEMA_VERSION,
  kind: 'domain-task', facts: newFacts(), userResponse: { state: 'usable', text: 'Cleaning started.', language: 'en' },
  ...changes });

test('R02 discriminants, required response state and unknown versions fail closed', () => {
  const authority = createCompletionAuthority(nativeEvidence());
  for (const userResponse of [null, undefined, {}, { state: 'usable', text: '', language: 'en' },
    { state: 'usable', text: '   ', language: 'he' }, { state: 'unavailable' },
    { state: 'unavailable', reason: { code: 'bad code', detail: 'reason' } },
    { state: 'usable', text: 'x'.repeat(4097), language: 'en' },
    { state: 'usable', text: 'x', language: 'xx' }, { state: 'missing' }]) {
    assert.throws(() => acceptAgentCompletion(proposal({ userResponse }), authority));
  }
  const missing = proposal(); delete missing.userResponse;
  assert.throws(() => acceptAgentCompletion(missing, authority), /agent_completion_shape/);
  for (const schemaVersion of [1, 2, 4, '3', null]) {
    assert.throws(() => acceptAgentCompletion(proposal({ schemaVersion }), authority), /version_or_kind/);
  }
  for (const kind of ['response', 'task', null]) {
    assert.throws(() => acceptAgentCompletion(proposal({ kind }), authority), /version_or_kind/);
  }
  const accepted = acceptAgentCompletion(proposal({ userResponse: unavailableResponse }), authority);
  assert.equal(accepted.completion.outcome, 'NORMAL');
  assert.equal(accepted.facts.status, 'success');
  assert.equal(accepted.userResponse.state, 'unavailable');
  assert.ok(Object.isFrozen(accepted.facts.data));
  assert.deepEqual(plain(validateCompletion(plain(accepted), authority)), plain(accepted));
});

test('R02 agent payload and serialized objects cannot author native authority or outcome', () => {
  const authority = createCompletionAuthority(nativeEvidence());
  for (const field of ['binding', 'completion', 'provenance', 'taskId', 'results',
    'completionTarget', 'authorizationId', 'deliveryPolicy', 'messageCandidate']) {
    assert.throws(() => acceptAgentCompletion(proposal({ [field]: 'forged' }), authority), /agent_completion_shape/);
  }
  for (const fake of [nativeEvidence(), {}, JSON.parse(JSON.stringify(authority))]) {
    assert.throws(() => acceptAgentCompletion(proposal(), fake), /native_completion_authority_required/);
  }
  const accepted = acceptAgentCompletion(proposal(), authority);
  for (const field of ['requestId', 'workflowId', 'runId', 'agentId', 'sessionId', 'sessionKey',
    'generation', 'taskId', 'callerRunId', 'authorizationId']) {
    const raw = plain(accepted); raw.binding[field] = field === 'generation' ? 2 : 'forged';
    assert.throws(() => validateCompletion(raw, authority), /native_binding_mismatch/);
  }
  const raw = plain(accepted); raw.completion.outcome = 'RECOVERED';
  assert.throws(() => validateCompletion(raw, authority), /evidence_insufficient/);
  assert.throws(() => acceptAgentCompletion(proposal({ facts: newFacts({ data: { physicallyCompleted: true } }) }),
    authority), /evidence_mismatch/);
  assert.throws(() => reconstructCompletion(authority), /origin_mismatch/);
});

test('R02 domain version, collection bounds and JSON safety remain strict', () => {
  for (const domainSchemaVersion of ['2', 'future', null]) {
    assert.throws(() => createCompletionAuthority(nativeEvidence({ knownFacts: newFacts({ domainSchemaVersion }) })),
      /domain_version/);
  }
  assert.throws(() => createCompletionAuthority(nativeEvidence({ kind: 'other' })), /native_evidence_invalid/);
  assert.throws(() => createCompletionAuthority(nativeEvidence({ binding: newBinding({ taskId: null }) })), /binding_invalid/);
  assert.throws(() => createCompletionAuthority(nativeEvidence({ binding: newBinding({ callerRunId: null }) })), /binding_invalid/);
  for (const field of ['warnings', 'effects', 'uncertainty']) {
    createCompletionAuthority(nativeEvidence({ knownFacts: newFacts({ [field]: Array.from({ length: 64 }, () => ({ fact: 'known' })) }) }));
    assert.throws(() => createCompletionAuthority(nativeEvidence({ knownFacts: newFacts({
      [field]: Array.from({ length: 65 }, () => ({ fact: 'known' })) }) })));
  }
  for (const data of [() => {}, NaN, JSON.parse('{"__proto__":{"forged":true}}'),
    { text: 'x'.repeat(16385) }, Array(1), Object.assign([], { custom: 'lost' }),
    { [Symbol('lost')]: true }, Object.defineProperty({}, 'lost', { value: true }),
    Object.defineProperty({}, 'getter', { enumerable: true, get() { throw new Error('getter_executed'); } }), Array(257).fill(null), Object.fromEntries(Array.from({ length: 257 }, (_, i) => [i, 1]))]) {
    assert.throws(() => createCompletionAuthority(nativeEvidence({ knownFacts: newFacts({ data }) })));
  }
  let deep = null; for (let i = 0; i < 20; i++) deep = { child: deep };
  assert.throws(() => createCompletionAuthority(nativeEvidence({ knownFacts: newFacts({ data: deep }) })), /too_deep/);
  assert.throws(() => createCompletionAuthority(nativeEvidence({ knownFacts: newFacts({
    data: Array.from({ length: 20 }, () => 'x'.repeat(16384)) }) })), /bytes_exceeded/);
});

test('R02 business statuses are independent of runtime finalization outcomes', () => {
  const cases = {
    success: newFacts(),
    failure: newFacts({ status: 'failure', verified: false, verificationScope: [], error: { code: 'DEVICE_UNAVAILABLE' } }),
    partial: newFacts({ status: 'partial', verified: false, verificationScope: [], error: { code: 'ROOM_FAILED' } }),
    unknown: newFacts({ status: 'unknown', verified: 'unknown', verificationScope: [] }),
    not_applicable: newFacts({ status: 'not_applicable', verified: 'not_applicable', verificationScope: [], effects: [] }),
    clarification_required: newFacts({ status: 'clarification_required', verified: false, verificationScope: [], effects: [],
      pendingContext: { schemaVersion: 1, value: { room: 'ambiguous', evidenceId: 'native-evidence-1' },
        binding: { requesterId: 'oren', conversationId: 'agent:main:oren' }, expiresAt: '2026-09-29T12:00:00Z' } }),
  };
  for (const status of COMPLETION_STATUSES) {
    const facts = cases[status];
    const normalAuthority = createCompletionAuthority(nativeEvidence({ knownFacts: facts }));
    const normal = acceptAgentCompletion(proposal({ facts }), normalAuthority);
    const recoveryAuthority = createCompletionAuthority(nativeEvidence({ knownFacts: facts, origin: 'runtime' }));
    const recovered = reconstructCompletion(recoveryAuthority);
    const failedAuthority = createCompletionAuthority(nativeEvidence({ knownFacts: facts, origin: 'runtime', coverage: 'incomplete' }));
    const failed = reconstructCompletion(failedAuthority);
    for (const [record, authority, outcome] of [[normal, normalAuthority, 'NORMAL'],
      [recovered, recoveryAuthority, 'RECOVERED'], [failed, failedAuthority, 'FAILED']]) {
      assert.equal(record.facts.status, status);
      assert.equal(record.completion.outcome, outcome);
      assert.deepEqual(plain(record.facts), plain(facts));
      assert.deepEqual(plain(validateCompletion(plain(record), authority)), plain(record));
      if (outcome !== 'NORMAL') {
        const injected = plain(record); injected.userResponse = proposal().userResponse;
        assert.throws(() => validateCompletion(injected, authority), /runtime_response_mismatch/);
      }
    }
  }
});

test('R02 missing meaning produces an evidence-preserving FAILED report, no guesses', () => {
  const knownFacts = newFacts(); delete knownFacts.data;
  const native = nativeEvidence({ knownFacts, origin: 'runtime' });
  const authority = createCompletionAuthority(native);
  native.knownFacts.effects.length = 0; // Native input is copied before any later change.
  const failed = reconstructCompletion(authority);
  assert.equal(failed.completion.outcome, 'FAILED');
  assert.equal(failed.facts.status, 'success');
  assert.equal(failed.facts.data, null);
  assert.equal(failed.facts.effects.length, 1);
  assert.ok(failed.completion.gaps.some((gap) => gap.path === 'facts.data'));
  const forged = plain(failed); forged.completion = { outcome: 'RECOVERED', gaps: [] };
  assert.throws(() => validateCompletion(forged, authority), /evidence_insufficient/);
  assert.throws(() => createCompletionAuthority(nativeEvidence({ knownFacts })), /evidence_insufficient/);
  const emptyAuthority = createCompletionAuthority(nativeEvidence({ knownFacts: {}, origin: 'runtime', coverage: 'incomplete' }));
  const empty = reconstructCompletion(emptyAuthority);
  assert.equal(empty.facts.status, 'unknown');
  assert.equal(empty.facts.domain, null);
  assert.equal(empty.facts.verified, 'unknown');
  assert.equal(empty.completion.outcome, 'FAILED');
  assert.throws(() => createCompletionAuthority(nativeEvidence({ binding: newBinding({ runId: null }), origin: 'runtime' })), /binding_identity/);
});

test('R02 retained legacy domain facts migrate only with explicit response and native evidence', () => {
  for (const entry of accepted) {
    const legacy = result(entry.result, `migration-${entry.id}`);
    const facts = { status: legacy.status, domain: legacy.domain, domainSchemaVersion: legacy.domainSchemaVersion,
      operation: legacy.operation, verified: legacy.verified, verificationScope: legacy.verified ? ['legacy_tool_verification'] : [],
      data: legacy.data, warnings: legacy.warnings, error: legacy.error, effects: [], uncertainty: [], pendingContext: legacy.pendingContext };
    const authority = createCompletionAuthority(nativeEvidence({ knownFacts: facts,
      binding: newBinding({ taskId: legacy.taskId, agentId: legacy.domain === 'reminder' ? 'reminder-service' : legacy.domain }) }));
    assert.throws(() => validateCompletion(legacy, authority), /completion_shape/);
    assert.throws(() => acceptAgentCompletion({ schemaVersion: 3, kind: 'domain-task', facts }, authority), /agent_completion_shape/);
    const migrated = acceptAgentCompletion(proposal({ facts, userResponse: unavailableResponse }), authority);
    for (const key of ['status', 'domain', 'domainSchemaVersion', 'operation', 'verified', 'data', 'warnings', 'error', 'pendingContext']) {
      assert.deepEqual(plain(migrated.facts[key]), plain(legacy[key]), `${entry.id}:${key}`);
    }
  }
});

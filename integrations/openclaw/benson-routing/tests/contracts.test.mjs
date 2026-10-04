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

import { CURRENT_COMPLETION_SCHEMA_VERSION, MAX_WORKFLOW_ADMISSIONS,
  completionProposalSchema } from '../envelope.mjs';
import { p02Facts, p02Binding, p02Evidence, p02Accepted, p02Child, p02Workflow } from './fixtures/completion-v4.mjs';

test('P02 v3 and v4 are strict transition readers, never implicit upgrades', () => {
  const oldAuthority = createCompletionAuthority(nativeEvidence());
  const oldRecord = acceptAgentCompletion(proposal(), oldAuthority);
  const native = p02Evidence({ knownFacts: plain(oldRecord.facts) });
  const { record, authority } = p02Accepted(native, plain(oldRecord.userResponse));
  assert.equal(record.schemaVersion, 4);
  assert.deepEqual(plain(record.facts), plain(oldRecord.facts));
  assert.deepEqual(plain(record.userResponse), plain(oldRecord.userResponse));
  assert.throws(() => validateCompletion(record, oldAuthority));
  assert.throws(() => validateCompletion(oldRecord, authority));
  for (const schemaVersion of [0, 1, 2, 5, '4', null]) {
    assert.throws(() => createCompletionAuthority({ ...native, schemaVersion }));
    assert.throws(() => acceptAgentCompletion({ schemaVersion, kind: native.kind,
      facts: native.knownFacts, userResponse: oldRecord.userResponse }, authority), /version_or_kind/);
  }
  const noVersion = { ...native }; delete noVersion.schemaVersion;
  assert.throws(() => createCompletionAuthority(noVersion), /native_evidence_shape/);
  const noResponse = { schemaVersion: 4, kind: 'domain-task', facts: native.knownFacts };
  assert.throws(() => acceptAgentCompletion(noResponse, authority), /agent_completion_shape/);
  assert.throws(() => acceptAgentCompletion({ ...noResponse, userResponse: null }, authority), /user_response_required/);
});

test('P02 every trusted identity and revision survives round-trip and rejects forgery', () => {
  const native = p02Evidence();
  const { record, authority } = p02Accepted(native);
  assert.deepEqual(plain(validateCompletion(plain(record), authority)), plain(record));
  for (const key of Object.keys(record.binding)) {
    const forged = plain(record);
    const value = forged.binding[key];
    forged.binding[key] = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : 'forged';
    assert.throws(() => validateCompletion(forged, authority), key);
  }
  for (const fake of [{}, plain(authority), native]) {
    assert.throws(() => validateCompletion(record, fake), /native_completion_authority_required/);
  }
  const restoredAuthority = createCompletionAuthority(p02Evidence());
  assert.deepEqual(plain(validateCompletion(plain(record), restoredAuthority)), plain(record));
  const model = { schemaVersion: 4, kind: 'domain-task', facts: p02Facts(), userResponse: record.userResponse };
  for (const key of ['binding', 'workflow', 'semantics', 'completion', 'results']) {
    assert.throws(() => acceptAgentCompletion({ ...model, [key]: plain(native[key] ?? {}) }, authority), /agent_completion_shape/);
  }
});

test('P02 membership evidence is ordered, complete, and mandatory for trusted references', () => {
  const native = p02Evidence();
  const changes = [
    { workflowId: 'foreign' }, { conversationGeneration: 2 }, { membershipRevision: 2 },
    { acceptedIntentRevision: 2 }, { admissions: [] },
    { admissions: [{ admissionId: 'other', sequence: 1 }] },
    { admissions: [{ admissionId: 'admission-1', sequence: 2 }] },
    { admissions: [{ admissionId: 'admission-1', sequence: 1 }, { admissionId: 'admission-1', sequence: 2 }] },
    { admissions: [{ admissionId: 'other', sequence: 2 }, { admissionId: 'admission-1', sequence: 1 }] },
  ];
  for (const change of changes) {
    assert.throws(() => createCompletionAuthority({ ...native, workflow: { ...native.workflow, ...change } }));
  }
  for (const key of ['workflow', 'semantics']) {
    const absent = { ...native }; delete absent[key];
    assert.throws(() => createCompletionAuthority(absent), /native_evidence_shape/);
  }
  const admissions = Array.from({ length: MAX_WORKFLOW_ADMISSIONS }, (_, index) =>
    ({ admissionId: `admission-${index + 1}`, sequence: index + 1 }));
  createCompletionAuthority({ ...native, workflow: { ...native.workflow, admissions } });
  assert.throws(() => createCompletionAuthority({ ...native, workflow: { ...native.workflow,
    admissions: [...admissions, { admissionId: 'overflow', sequence: MAX_WORKFLOW_ADMISSIONS + 1 }] } }), /admissions_count/);
  assert.equal(Object.hasOwn(p02Accepted(native).record, 'workflow'), false);
});

test('P02 roles use trusted task/workflow authority rather than fixed agent names', () => {
  for (const agentId of ['jessica-vacuum', 'future-approved-agent']) {
    const { record } = p02Accepted(p02Evidence({ binding: p02Binding({ agentId }) }));
    assert.equal(record.kind, 'domain-task');
  }
  for (const change of [{ role: 'workflow-final' }, { taskId: null }, { sessionGeneration: 0 },
    { runGeneration: 0 }, { caller: null }, { finality: true }]) {
    assert.throws(() => createCompletionAuthority(p02Evidence({ binding: p02Binding(change) })));
  }
  const caller = p02Binding().caller;
  assert.throws(() => createCompletionAuthority(p02Evidence({ binding: p02Binding({
    caller: { ...caller, workflowId: 'foreign' } }) })), /caller_binding/);
  assert.throws(() => createCompletionAuthority(p02Evidence({ knownFacts: p02Facts({ domainSchemaVersion: '2' }) })), /domain_version/);
  const reminder = p02Accepted(p02Evidence({ knownFacts: p02Facts({ domain: 'reminder',
    domainSchemaVersion: 'legacy-unversioned', operation: 'create' }),
    binding: p02Binding({ agentId: 'reminder-service' }) })).record;
  assert.equal(reminder.facts.domainSchemaVersion, 'legacy-unversioned');
});

test('P02 response and pending provenance remain explicit and bounded', () => {
  const native = p02Evidence();
  const authority = createCompletionAuthority(native);
  const model = { schemaVersion: 4, kind: 'domain-task', facts: native.knownFacts };
  for (const userResponse of [{ state: 'usable', text: '', language: 'en' },
    { state: 'usable', text: 'x'.repeat(MAX_RENDERED_TEXT + 1), language: 'en' },
    { state: 'unavailable' }, { state: 'missing' }]) {
    assert.throws(() => acceptAgentCompletion({ ...model, userResponse }, authority));
  }
  for (const userResponse of [unavailableResponse,
    { state: 'usable', text: 'א'.repeat(MAX_RENDERED_TEXT), language: 'he' }]) {
    assert.deepEqual(plain(acceptAgentCompletion({ ...model, userResponse }, authority).userResponse), userResponse);
  }
  const unicodeResponse = { state: 'usable', text: '🧹'.repeat(MAX_RENDERED_TEXT / 2), language: 'en' };
  assert.equal(acceptAgentCompletion({ ...model, userResponse: unicodeResponse }, authority).userResponse.text.length, MAX_RENDERED_TEXT);
  assert.throws(() => acceptAgentCompletion({ ...model, userResponse: {
    ...unicodeResponse, text: unicodeResponse.text + '🧹' } }, authority), /candidate_invalid/);
  const pendingContext = { schemaVersion: 1, value: { question: 'Which room?', evidenceId: 'admission-1' },
    binding: { requesterId: 'oren', conversationId: 'conversation-1' }, expiresAt: '2026-10-04T12:00:00Z' };
  const nativePending = p02Evidence({ knownFacts: p02Facts({ status: 'clarification_required', verified: false,
    verificationScope: [], effects: [], pendingContext }) });
  const pendingRecord = p02Accepted(nativePending).record;
  assert.deepEqual(plain(pendingRecord.facts.pendingContext), pendingContext);
  assert.throws(() => createCompletionAuthority({ ...nativePending, knownFacts: { ...nativePending.knownFacts,
    pendingContext: { ...pendingContext, binding: { ...pendingContext.binding, conversationId: 'foreign' } } } }), /pending_conversation/);
});

test('P02 domain outcomes and reconstruction retain effects independently of finalization', () => {
  for (const [status, change] of [
    ['success', {}], ['failure', { verified: false, error: { code: 'BUSINESS_FAILURE' } }],
    ['partial', { verified: false, error: { code: 'PARTIAL_EXECUTION' } }],
    ['unknown', { verified: 'unknown' }],
    ['not_applicable', { verified: 'not_applicable', verificationScope: [], effects: [] }],
    ['clarification_required', { verified: false, effects: [], pendingContext: { schemaVersion: 1,
      value: { evidenceId: 'admission-1' }, binding: { requesterId: 'oren', conversationId: 'conversation-1' },
      expiresAt: '2026-10-04T12:00:00Z' } }],
  ]) {
    const knownFacts = p02Facts({ status, ...change });
    for (const [origin, coverage, outcome] of [['agent', 'complete', 'NORMAL'],
      ['runtime', 'complete', 'RECOVERED'], ['runtime', 'incomplete', 'FAILED']]) {
      const { record, authority } = p02Accepted(p02Evidence({ knownFacts, origin, coverage }));
      assert.equal(record.completion.outcome, outcome);
      assert.deepEqual(plain(record.facts), knownFacts);
      assert.deepEqual(plain(validateCompletion(plain(record), authority)), plain(record));
    }
  }
});

test('P02 missing fact evidence yields FAILED and survives domain and final reconstruction', () => {
  const fields = [...new Set(['verificationScope', ...Object.keys(p02Facts())])];
  const checkKnown = (record, known, field) => {
    assert.equal(record.completion.outcome, 'FAILED');
    assert.ok(record.completion.gaps.some(gap => gap.code === 'FACT_NOT_ESTABLISHED' && gap.path === `facts.${field}`));
    for (const [key, value] of Object.entries(known)) assert.deepEqual(plain(record.facts[key]), value, `${field}:${key}`);
  };
  for (const field of fields) {
    for (const direct of [false, true]) {
      const knownFacts = p02Facts(); delete knownFacts[field];
      const binding = p02Binding(direct ? { caller: null, completionTarget: 'RESPONSE_CONTROLLER',
        finality: true, deliveryPolicy: { eligible: true, reason: null } } : {});
      const native = p02Evidence({ binding, knownFacts, origin: 'runtime' });
      const child = p02Accepted(native);
      checkKnown(child.record, knownFacts, field);
      assert.deepEqual(plain(validateCompletion(plain(child.record), child.authority)), plain(child.record));
      assert.throws(() => createCompletionAuthority({ ...native, origin: 'agent' }), /completion_evidence_insufficient/);
      const final = direct ? p02Accepted(p02Evidence({
        binding: { ...binding, role: 'direct-final', taskId: null },
        knownFacts: { ...plain(child.record.facts), domain: null, domainSchemaVersion: null, operation: null },
        results: [child], origin: 'runtime', semantics: null,
      })) : p02Workflow([child], { evidence: { origin: 'runtime' } });
      assert.equal(final.record.completion.outcome, 'FAILED');
      assert.deepEqual(plain(final.record.results[0]), plain(child.record));
      assert.deepEqual(plain(validateCompletion(plain(final.record), final.authority)), plain(final.record));
    }
    const child = p02Child('complete-child');
    const binding = p02Binding({ role: 'workflow-final', taskId: null, caller: null, agentId: 'main',
      completionTarget: 'RESPONSE_CONTROLLER', finality: true, deliveryPolicy: { eligible: true, reason: null } });
    const knownFacts = p02Facts({ domain: null, domainSchemaVersion: null, operation: null,
      data: { answer: 'Known partial owner result.' } }); delete knownFacts[field];
    const semantics = { ownerRunId: binding.runId, ownerRunGeneration: binding.runGeneration,
      acceptedIntentRevision: binding.acceptedIntentRevision, coverage: field === 'data' ? 'incomplete' : 'complete',
      value: knownFacts.data ?? null };
    const { record, authority } = p02Accepted(p02Evidence({ binding, knownFacts, results: [child], origin: 'runtime', semantics }));
    checkKnown(record, knownFacts, field);
    assert.deepEqual(plain(record.results[0]), plain(child.record));
    assert.deepEqual(plain(validateCompletion(plain(record), authority)), plain(record));
  }
  assert.throws(() => createCompletionAuthority(p02Evidence({ origin: 'runtime', coverage: 'incomplete',
    knownFacts: p02Facts({ verificationScope: [] }) })), /completion_verification_scope/);
  assert.throws(() => createCompletionAuthority(p02Evidence({ origin: 'runtime',
    knownFacts: p02Facts({ verificationScope: [] }), gaps: [{ code: 'FACT_NOT_ESTABLISHED',
      path: 'facts.verificationScope', detail: 'Claimed absent despite an explicitly supplied invalid scope.' }] })),
  /completion_verification_scope/);
  const unsupportedVersion = p02Facts({ domainSchemaVersion: 'unknown' }); delete unsupportedVersion.domain;
  assert.throws(() => createCompletionAuthority(p02Evidence({ origin: 'runtime', knownFacts: unsupportedVersion })), /completion_domain_version/);
  const oldMissing = newFacts(); delete oldMissing.verificationScope;
  assert.throws(() => createCompletionAuthority(nativeEvidence({ origin: 'runtime', knownFacts: oldMissing })), /completion_verification_scope/);
});

test('P02 supplementary schema is tied to canonical authority; unconstrained output is still checked', () => {
  const native = p02Evidence();
  const authority = createCompletionAuthority(native);
  const schema = completionProposalSchema(authority);
  assert.equal(schema.properties.schemaVersion.const, CURRENT_COMPLETION_SCHEMA_VERSION);
  assert.equal(schema.properties.kind.const, native.kind);
  assert.deepEqual(plain(schema.properties.facts.const), native.knownFacts);
  assert.deepEqual(schema.required, ['schemaVersion', 'kind', 'facts', 'userResponse']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.userResponse.oneOf[0].properties.text.maxLength, MAX_RENDERED_TEXT);
  assert.ok(Object.isFrozen(schema.properties.facts.const));
  assert.throws(() => completionProposalSchema({}), /native_completion_authority_required/);
  const unconstrained = { schemaVersion: 4, kind: native.kind,
    facts: p02Facts({ data: { physicallyCompleted: true } }), userResponse: unavailableResponse };
  assert.throws(() => acceptAgentCompletion(unconstrained, authority), /evidence_mismatch/);
});

test('P02 migration fixtures preserve approved domain schemas and runtime outcomes', () => {
  for (const entry of accepted) {
    const legacy = result(entry.result, `p02-migration-${entry.id}`);
    const facts = { status: legacy.status, domain: legacy.domain, domainSchemaVersion: legacy.domainSchemaVersion,
      operation: legacy.operation, verified: legacy.verified,
      verificationScope: legacy.verified ? ['legacy_tool_verification'] : [], data: legacy.data,
      warnings: legacy.warnings, error: legacy.error, effects: [], uncertainty: [], pendingContext: legacy.pendingContext };
    const conversationId = facts.pendingContext?.binding.conversationId ?? 'conversation-1';
    const native = p02Evidence({ knownFacts: facts, binding: p02Binding({ conversationId, taskId: legacy.taskId }) });
    const { record } = p02Accepted(native, unavailableResponse);
    assert.deepEqual(plain(record.facts), plain(facts), entry.id);
    assert.deepEqual(plain(record.userResponse), unavailableResponse);
    // The fixture explicitly supplies owner response state and fresh native
    // identity evidence; a legacy null candidate is never auto-promoted.
    assert.throws(() => validateCompletion(legacy, createCompletionAuthority(native)));
  }
  for (const coverage of ['complete', 'incomplete']) {
    const oldAuthority = createCompletionAuthority(nativeEvidence({ origin: 'runtime', coverage }));
    const oldRecord = reconstructCompletion(oldAuthority);
    const current = p02Accepted(p02Evidence({ knownFacts: plain(oldRecord.facts), origin: 'runtime', coverage })).record;
    assert.equal(current.completion.outcome, oldRecord.completion.outcome);
    assert.deepEqual(plain(current.facts), plain(oldRecord.facts));
    assert.deepEqual(plain(current.userResponse), plain(oldRecord.userResponse));
    assert.deepEqual(plain(current.completion.gaps), plain(oldRecord.completion.gaps));
  }
});

test('P02 opaque native generations retain exact values and types without a Benson counter', () => {
  const original = p02Binding();
  const binding = p02Binding({ conversationGeneration: 'conversation-incarnation',
    runGeneration: 'run-incarnation', sessionGeneration: 'session-incarnation',
    caller: { ...original.caller, runGeneration: 'caller-run-incarnation', sessionGeneration: 'caller-session-incarnation' } });
  const { record, authority } = p02Accepted(p02Evidence({ binding }));
  assert.deepEqual(plain(record.binding), binding);
  assert.deepEqual(plain(validateCompletion(plain(record), authority)), plain(record));
  for (const key of ['conversationGeneration', 'runGeneration', 'sessionGeneration']) {
    for (const value of [null, false, 0, -1, '', {}, 'x'.repeat(513)]) {
      assert.throws(() => createCompletionAuthority(p02Evidence({ binding: { ...binding, [key]: value } })), /binding_generation/);
    }
  }
  const numeric = p02Accepted(p02Evidence()).record;
  const coerced = plain(numeric); coerced.binding.runGeneration = '1';
  assert.throws(() => validateCompletion(coerced, createCompletionAuthority(p02Evidence())), /native_binding_mismatch/);
});

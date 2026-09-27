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

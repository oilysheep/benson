import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSourceAdmissionController, projectRequestAdmission } from "../request-control.mjs";
import { CONTROL_CONTRACT_VERSION, RESPONSE_CONTRACT_VERSION, CURRENT_COMPLETION_SCHEMA_VERSION,
  NO_RUN_DISPOSITIONS, validateTaskResultEnvelope, validateResponseEnvelope } from "../envelope.mjs";
import { validateResult } from "../../../../agents/jessica-vacuum/lib/results.mjs";

// Contract inputs only: these dependencies deliberately provide no native issuer,
// requester custody, persistence, domain grant or delivery capability.
const corpus = JSON.parse(readFileSync(new URL("./fixtures/presentation-cases.json", import.meta.url)));
const facts = corpus.cases.find((item) => item.id === "jessica-status-read-en").result;
const epoch = Date.parse(facts.data.observedAt);
const clone = (value) => JSON.parse(JSON.stringify(value));
function input(type = "ha") {
  return { schemaVersion: 1, kind: "benson.source-input",
    source: { type, ref: "fixture-source", inputId: "fixture-input-1" },
    domain: "jessica-vacuum", scope: "read", request: "fixture observation" };
}
function fixture(raw = input(), overrides = {}) {
  const state = { time: epoch, live: true, domainAllowed: true, calls: 0,
    grant: { inputId: raw.source.inputId, sourceType: raw.source.type, sourceRef: raw.source.ref,
      domain: raw.domain, subject: "fixture-source-principal", authorityRef: "fixture-authority-1",
      authorityRevision: "fixture-revision-1", scopes: ["read", "notify"], expiresAt: epoch + 60000,
      status: "active", cancelled: false, replayState: "fresh", commitment: "uncommitted" } };
  const dependencies = { now: () => state.time, readAuthority: () => state.grant,
    assertCurrent: () => { assert.equal(state.live, true, "fixture owner closed"); },
    assertDomainOutcome: (outcome) => {
      state.calls++;
      assert.equal(state.domainAllowed, true, "fixture domain denied");
      if (outcome.evidence.facts !== null) validateResult(outcome.evidence.facts, null, new Date(state.time));
    }, ...overrides };
  return { state, dependencies, controller: createSourceAdmissionController(dependencies), raw };
}
function outcome(admission, disposition = "handled") {
  return { schemaVersion: 1, kind: "benson.no-run",
    admission: { inputId: admission.source.inputId, sourceType: admission.source.type,
      sourceRef: admission.source.ref, authorityRef: admission.authority.ref,
      authorityRevision: admission.authority.revision, domain: admission.domain,
      subject: admission.authority.subject }, disposition,
    evidence: { ref: "fixture-evidence", observedAt: facts.data.observedAt, freshness: "fresh", facts: clone(facts) },
    effects: { status: "none", refs: [] }, reconciliation: { required: false, reason: null },
    notification: null, error: ["failed", "unresolved", "rejected"].includes(disposition)
      ? { code: "fixture_failure", message: "fixture outcome", retryable: false } : null };
}
function notification() {
  return { identity: "fixture-business-notification", policyRevision: "fixture-policy-1",
    evidenceRef: "fixture-evidence", route: { recipient: "fixture-recipient", channel: "fixture-channel",
      accountId: "fixture-account", target: "fixture-target" }, content: "Fixture observation only." };
}

test("source contract supports each source class without granting native authority", () => {
  for (const type of ["user", "ha", "automation"]) {
    const f = fixture(input(type));
    const admitted = f.controller.admit(f.raw);
    assert.equal(admitted.source.type, type);
    assert.equal(admitted.request, f.raw.request);
    assert.equal(admitted.authority.subject, f.state.grant.subject);
    assert.ok(Object.isFrozen(admitted.authority));
    f.controller.assertCurrent(admitted);
    assert.equal(f.state.calls, 0);
    assert.equal(f.controller.dispatch, undefined);
  }
  const f = fixture();
  const one = f.controller.admit(f.raw);
  f.state.grant.inputId = "fixture-input-2";
  const two = f.controller.admit({ ...f.raw, source: { ...f.raw.source, inputId: "fixture-input-2" } });
  assert.equal(one.request, two.request);
  assert.notEqual(one.source.inputId, two.source.inputId);
  assert.throws(() => f.controller.assertCurrent(one), /source_grant_rejected/);
});

test("missing, forged, foreign, stale, revoked and uncertain grants reject before domain handling", () => {
  for (const mutation of [
    { status: "untrusted" }, { status: "revoked" }, { status: "unresolved" }, { expiresAt: epoch },
    { sourceType: "user" }, { sourceRef: "foreign" }, { inputId: "foreign" }, { domain: "reminder" },
    { scopes: ["action"] }, { scopes: ["read", "read"] }, { scopes: ["unknown"] },
    { cancelled: true }, { replayState: "duplicate" }, { replayState: "recovery" },
    { replayState: "unknown" }, { commitment: "claimed" }, { commitment: "unknown" },
  ]) {
    const f = fixture();
    Object.assign(f.state.grant, mutation);
    assert.throws(() => f.controller.admit(f.raw), /source_grant_rejected/, JSON.stringify(mutation));
    assert.equal(f.state.calls, 0);
  }
  for (const missing of [null, {}, { authorityRef: "caller-supplied" }]) {
    const f = fixture(); f.state.grant = missing;
    assert.throws(() => f.controller.admit(f.raw), /source_contract_shape/);
  }
  assert.throws(() => createSourceAdmissionController({}), /dependencies_unavailable/);
});

test("closed source schema, bounds and admission branding reject forged entry paths", () => {
  const f = fixture();
  for (const bad of [
    { ...f.raw, schemaVersion: 2 }, { ...f.raw, kind: "benson.no-run" },
    { ...f.raw, authority: f.state.grant }, { ...f.raw, requesterSenderId: "forged" },
    { ...f.raw, scope: "exec" }, { ...f.raw, request: "א".repeat(4097) },
    { ...f.raw, source: { ...f.raw.source, type: "operator" } },
    { ...f.raw, source: { ...f.raw.source, jobId: "forged" } },
  ]) assert.throws(() => f.controller.admit(bad));
  const getter = { ...f.raw };
  Object.defineProperty(getter, "request", { get() { assert.fail("must not evaluate a getter"); } });
  assert.throws(() => f.controller.admit(getter), /source_contract_shape/);
  const handle = f.controller.admit(f.raw);
  assert.throws(() => f.controller.assertCurrent(clone(handle)), /source_admission_unowned/);
  assert.throws(() => fixture().controller.assertCurrent(handle), /source_admission_unowned/);
  f.state.live = false;
  assert.throws(() => f.controller.assertCurrent(handle), /owner closed/);
});

test("each no-Run disposition preserves the original admission and uses the existing domain evidence validator", () => {
  for (const disposition of NO_RUN_DISPOSITIONS) {
    const f = fixture(); const handle = f.controller.admit(f.raw);
    const raw = outcome(handle, disposition);
    const result = f.controller.validateOutcome(handle, raw);
    assert.deepEqual(clone(result), raw);
    assert.ok(Object.isFrozen(result.evidence.facts));
    assert.equal(f.state.calls, 1);
    assert.equal(result.runId, undefined);
    assert.equal(result.taskId, undefined);
    assert.throws(() => validateTaskResultEnvelope(result));
    assert.throws(() => validateResponseEnvelope(result));
  }
});

test("no-Run rejects bad correlation, versions, evidence, effects and notifications", () => {
  const f = fixture(); const handle = f.controller.admit(f.raw);
  const valid = outcome(handle);
  for (const key of Object.keys(valid.admission)) {
    assert.throws(() => f.controller.validateOutcome(handle,
      { ...valid, admission: { ...valid.admission, [key]: "foreign" } }), /no_run_admission_mismatch/);
  }
  for (const bad of [
    { ...valid, schemaVersion: 2 }, { ...valid, disposition: "success" },
    { ...valid, runId: "fake" }, { ...valid, evidence: { ...valid.evidence, freshness: "unknown" } },
    { ...valid, evidence: { ...valid.evidence, observedAt: "bad timestamp" } },
    { ...valid, evidence: { ...valid.evidence, facts: null } },
    { ...valid, effects: { status: "known", refs: [] } },
    { ...valid, effects: { status: "possible", refs: ["effect"] } },
    { ...valid, effects: { status: "known", refs: Array.from({ length: 17 }, (_, i) => `effect-${i}`) } },
    { ...valid, error: { code: "unexpected", message: "bad", retryable: false } },
    { ...valid, notification: { ...notification(), content: "x".repeat(4097) } },
    { ...valid, notification: { ...notification(), evidenceRef: "foreign" } },
    { ...valid, notification: { ...notification(), route: { ...notification().route, admin: true } } },
    { ...valid, disposition: "suppressed", notification: notification() },
  ]) assert.throws(() => f.controller.validateOutcome(handle, bad));
  const invalidDomainFacts = clone(valid);
  invalidDomainFacts.evidence.facts.verified = false;
  assert.throws(() => f.controller.validateOutcome(handle, invalidDomainFacts));
  f.state.domainAllowed = false;
  assert.throws(() => f.controller.validateOutcome(handle, valid), /domain denied/);
});

test("exception, timeout, restart and reasoning-required contracts retain possible effects for reconciliation", () => {
  const f = fixture(); const handle = f.controller.admit(f.raw);
  for (const cause of ["exception", "timeout", "restart", "reasoning-required"]) {
    const raw = outcome(handle, cause === "reasoning-required" ? cause : "unresolved");
    raw.effects = { status: "possible", refs: ["fixture-original-operation"] };
    raw.reconciliation = { required: true, reason: cause };
    raw.evidence = { ref: null, observedAt: null, freshness: "unknown", facts: null };
    const result = f.controller.validateOutcome(handle, raw);
    assert.deepEqual(clone(result.effects), raw.effects);
    assert.deepEqual(clone(result.reconciliation), raw.reconciliation);
    assert.equal(result.notification, null);
    assert.throws(() => f.controller.validateOutcome(handle,
      { ...raw, reconciliation: { required: false, reason: null } }), /no_run_reconciliation_invalid/);
  }
});

test("authority is checked again after an await and after domain validation; notification needs its own scope", async () => {
  for (const mutation of [{ cancelled: true }, { status: "revoked" }, { authorityRevision: "replaced" },
    { subject: "rebound" }, { expiresAt: epoch }]) {
    const f = fixture(); const handle = f.controller.admit(f.raw);
    await Promise.resolve(); Object.assign(f.state.grant, mutation);
    assert.throws(() => f.controller.validateOutcome(handle, outcome(handle)), /source_grant/);
  }
  const f = fixture(); const handle = f.controller.admit(f.raw);
  const raw = { ...outcome(handle), notification: notification() };
  assert.deepEqual(clone(f.controller.validateOutcome(handle, raw).notification), raw.notification);
  // A first eligible warning may accompany no-change; preventing reissue belongs
  // to the domain's eligibility/claim assertion, not a blanket disposition rule.
  assert.deepEqual(clone(f.controller.validateOutcome(handle,
    { ...raw, disposition: "no-change" }).notification), raw.notification);
  f.state.grant.scopes = ["read"];
  assert.throws(() => f.controller.validateOutcome(handle, raw), /source_notification_scope_missing/);
  let grant;
  const racing = fixture(input(), { assertDomainOutcome: () => { grant.status = "revoked"; } });
  grant = racing.state.grant;
  const racingHandle = racing.controller.admit(racing.raw);
  assert.throws(() => racing.controller.validateOutcome(racingHandle, outcome(racingHandle)), /source_grant_rejected/);
});

test("async or negative authority assertions fail closed without unhandled rejection", async () => {
  for (const overrides of [{ assertCurrent: () => false }, { assertCurrent: async () => { throw new Error("expired"); } },
    { readAuthority: async () => { throw new Error("unavailable"); } }, { now: async () => epoch }]) {
    const f = fixture(input(), overrides);
    assert.throws(() => f.controller.admit(f.raw), /source_authority/);
  }
  for (const assertion of [() => false, async () => { throw new Error("denied"); }]) {
    const f = fixture(input(), { assertDomainOutcome: assertion });
    const handle = f.controller.admit(f.raw);
    assert.throws(() => f.controller.validateOutcome(handle, outcome(handle)), /source_authority/);
  }
  await new Promise((resolve) => setImmediate(resolve));
});

test("no-Run carrier bounds and freshness reject malformed or future evidence", () => {
  const f = fixture(); const handle = f.controller.admit(f.raw);
  const raw = outcome(handle);
  const oversized = clone(raw);
  oversized.evidence.facts = { values: Array.from({ length: 20 }, () => "x".repeat(16384)) };
  assert.throws(() => f.controller.validateOutcome(handle, oversized), /json_bytes_exceeded/);
  const deep = clone(raw);
  let cursor = deep.evidence.facts;
  for (let i = 0; i < 17; i++) { cursor.next = {}; cursor = cursor.next; }
  assert.throws(() => f.controller.validateOutcome(handle, deep), /json_too_deep/);
  const sparse = clone(raw); sparse.effects.refs = Array(2);
  assert.throws(() => f.controller.validateOutcome(handle, sparse), /json_array_invalid/);
  const future = clone(raw);
  future.evidence.observedAt = new Date(epoch + 1).toISOString();
  assert.throws(() => f.controller.validateOutcome(handle, future), /source_evidence_in_future/);
  const stale = clone(raw);
  stale.evidence.facts.data.freshness = "stale";
  assert.throws(() => f.controller.validateOutcome(handle, stale));
});

test("legacy P03 admission and Run/Response versions retain explicit compatibility", () => {
  assert.equal(CONTROL_CONTRACT_VERSION, 1);
  assert.equal(RESPONSE_CONTRACT_VERSION, 2);
  assert.equal(CURRENT_COMPLETION_SCHEMA_VERSION, 4);
  const raw = { schemaVersion: 1, kind: "candidate", reason: null,
    requestId: "legacy-input", sessionKey: "legacy-session", request: "legacy request" };
  assert.equal(projectRequestAdmission(raw).taskEnvelope.request, raw.request);
  assert.throws(() => projectRequestAdmission({ ...raw, source: input().source }));
  assert.throws(() => projectRequestAdmission(input()));
});

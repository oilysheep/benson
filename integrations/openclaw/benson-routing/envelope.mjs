export const TASK_ENVELOPE_KIND = "benson.self-contained-request";
export const TASK_ENVELOPE_VERSION = 1;

const ENVELOPE_KEYS = new Set(["kind", "version", "request"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function createTaskEnvelope(request) {
  if (typeof request !== "string") {
    throw new TypeError("request_must_be_string");
  }

  return Object.freeze({
    kind: TASK_ENVELOPE_KIND,
    version: TASK_ENVELOPE_VERSION,
    request,
  });
}

export function formatTaskEnvelope(request) {
  return JSON.stringify(createTaskEnvelope(request));
}

export function parseTaskEnvelope(serialized) {
  if (typeof serialized !== "string") {
    throw new TypeError("envelope_must_be_string");
  }

  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new TypeError("invalid_envelope_json");
  }

  if (!isPlainObject(parsed)) {
    throw new TypeError("invalid_envelope_shape");
  }

  const keys = Object.keys(parsed);
  if (
    keys.length !== ENVELOPE_KEYS.size ||
    !keys.every((key) => ENVELOPE_KEYS.has(key)) ||
    parsed.kind !== TASK_ENVELOPE_KIND ||
    parsed.version !== TASK_ENVELOPE_VERSION ||
    typeof parsed.request !== "string"
  ) {
    throw new TypeError("invalid_envelope_shape");
  }

  return createTaskEnvelope(parsed.request);
}

// Private, inactive contracts. Native owners must supply trusted metadata.
export const CONTROL_CONTRACT_VERSION = 1;
export const RESPONSE_CONTRACT_VERSION = 2;
export const MAX_RESPONSE_RESULTS = 16;
export const MAX_RENDERED_TEXT = 4096;
const MAX_WARNINGS = 64;
const DOMAIN_VERSIONS = Object.freeze({ "jessica-vacuum": "1", reminder: "legacy-unversioned" });
const MAX_BYTES = 262144;
const RESULT_KEYS = ["schemaVersion", "domainSchemaVersion", "taskId", "status", "domain", "operation", "verified", "data", "warnings", "error", "pendingContext", "messageCandidate"];
const LEGACY_KEYS = ["status", "domain", "operation", "verified", "data", "warnings", "error", "pendingContext"];
const ROUTE_KEYS = ["schemaVersion", "requestId", "executionOwner", "completionTarget", "callerRunId", "responsePolicy"];
const RESPONSE_KEYS = ["schemaVersion", "requestId", "source", "status", "results", "pendingContext", "messageCandidate", "responsePolicy", "provenance", "lifecycle"];
const COMPLETION_ADMISSION_KEYS = ["schemaVersion", "requestId", "childRunId", "taskId", "destination", "callerRunId", "result"];
const COMPLETION_BINDING_KEYS = ["schemaVersion", "requestId", "parentSessionKey", "parentSessionId", "parentRunId", "childRunId", "childSessionKey", "executionOwner", "completionTarget", "callerRunId"];
const NATIVE_COMPLETION_KEYS = ["binding", "admission"];
const PARENT_SESSION_KEYS = ["sessionKey", "sessionId"];
const DOMAIN_AGENTS = Object.freeze({ "jessica-vacuum": "jessica-vacuum", reminder: "reminder-service" });
const MODES = ["pass_through", "deterministic", "response_model", "main_continuation", "safe_failure"];

function fail(code) { throw new TypeError(code); }
function exact(value, fields, code) {
  if (!isPlainObject(value) || Object.keys(value).length !== fields.length ||
      !fields.every((key) => Object.hasOwn(value, key))) fail(code);
}
function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
function timestamp(value) {
  return typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}
function jsonCopy(value, depth = 0) {
  if (depth > 16) fail("json_too_deep");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length <= 16384) return value;
  if (Array.isArray(value) && value.length <= 256) {
    if (Reflect.ownKeys(value).length !== value.length + 1 ||
        Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index)))
          .some((descriptor) => !descriptor || !Object.hasOwn(descriptor, 'value'))) fail("json_array_invalid");
    return value.map((item) => jsonCopy(item, depth + 1));
  }
  if (isPlainObject(value) && Object.keys(value).length <= 256) {
    if (Reflect.ownKeys(value).length !== Object.keys(value).length ||
        Object.values(Object.getOwnPropertyDescriptors(value)).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) {
      fail("json_object_invalid");
    }
    const copy = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      if (key.length > 128 || ["__proto__", "constructor", "prototype"].includes(key)) fail("json_key_invalid");
      copy[key] = jsonCopy(child, depth + 1);
    }
    return copy;
  }
  fail("json_invalid_or_oversized");
}
function boundedCopy(value) {
  const copy = jsonCopy(value);
  if (Buffer.byteLength(JSON.stringify(copy), "utf8") > MAX_BYTES) fail("json_bytes_exceeded");
  return copy;
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
// Separate inactive no-Run variant; legacy Run/Response versions stay unchanged.
export const NO_RUN_OUTCOME_VERSION = 1;
export const NATIVE_READ_OUTCOME_VERSION = 2;
export const NO_RUN_DISPOSITIONS = Object.freeze([
  "handled", "no-change", "suppressed", "rejected", "reasoning-required", "unresolved", "failed",
]);
const NO_RUN_KEYS = ["schemaVersion", "kind", "admission", "disposition", "evidence",
  "effects", "reconciliation", "notification", "error"];
const NO_RUN_ADMISSION_KEYS = ["inputId", "sourceType", "sourceRef", "authorityRef",
  "authorityRevision", "domain", "subject"];

// Shape/correlation validation is not authentication or domain authorization.
// The Request Controller accepts this only with its own live admission handle
// and the owning domain's synchronous evidence/permission assertion.
export function validateNoRunOutcome(raw, admission) {
  const value = boundedCopy(raw);
  exact(value, NO_RUN_KEYS, "no_run_shape");
  const nativeRead = value.schemaVersion === NATIVE_READ_OUTCOME_VERSION;
  if ((!nativeRead && value.schemaVersion !== NO_RUN_OUTCOME_VERSION) || value.kind !== "benson.no-run" ||
      !NO_RUN_DISPOSITIONS.includes(value.disposition) || admission?.kind !== "benson.source-admission" ||
      admission.schemaVersion !== value.schemaVersion) {
    fail("no_run_version_or_disposition");
  }
  const expected = nativeRead ? { authorityKind: admission.authority?.kind,
    callId: admission.callId, domain: admission.domain, subject: admission.authority?.subject }
    : { inputId: admission.source?.inputId, sourceType: admission.source?.type,
    sourceRef: admission.source?.ref, authorityRef: admission.authority?.ref,
    authorityRevision: admission.authority?.revision, domain: admission.domain,
    subject: admission.authority?.subject };
  exact(value.admission, nativeRead ? Object.keys(expected) : NO_RUN_ADMISSION_KEYS, "no_run_admission_shape");
  if ((nativeRead && (expected.authorityKind !== "native-invocation" || admission.scope !== "read")) ||
      !Object.keys(expected).every((key) => identifier(expected[key]) &&
      value.admission[key] === expected[key])) fail("no_run_admission_mismatch");
  exact(value.evidence, ["ref", "observedAt", "freshness", "facts"], "no_run_evidence_shape");
  if ((value.evidence.ref !== null && !identifier(value.evidence.ref)) ||
      (value.evidence.observedAt !== null && !timestamp(value.evidence.observedAt)) ||
      !["fresh", "stale", "unknown"].includes(value.evidence.freshness) ||
      (value.evidence.freshness === "fresh" && (value.evidence.ref === null ||
        value.evidence.observedAt === null || value.evidence.facts === null)) ||
      (["handled", "no-change"].includes(value.disposition) && value.evidence.freshness !== "fresh")) {
    fail("no_run_evidence_invalid");
  }
  exact(value.effects, ["status", "refs"], "no_run_effects_shape");
  if (!["none", "known", "possible"].includes(value.effects.status) ||
      !Array.isArray(value.effects.refs) || value.effects.refs.length > MAX_RESPONSE_RESULTS ||
      !value.effects.refs.every(identifier) || new Set(value.effects.refs).size !== value.effects.refs.length ||
      (value.effects.status === "none") !== (value.effects.refs.length === 0)) fail("no_run_effects_invalid");
  exact(value.reconciliation, ["required", "reason"], "no_run_reconciliation_shape");
  if (typeof value.reconciliation.required !== "boolean" ||
      (value.reconciliation.required ? !identifier(value.reconciliation.reason) :
        value.reconciliation.reason !== null) ||
      (value.effects.status === "possible" && !value.reconciliation.required)) {
    fail("no_run_reconciliation_invalid");
  }
  if (value.error !== null) {
    exact(value.error, ["code", "message", "retryable"], "no_run_error_shape");
    if (!identifier(value.error.code) || typeof value.error.message !== "string" ||
        !value.error.message.trim() || value.error.message.length > MAX_RENDERED_TEXT ||
        typeof value.error.retryable !== "boolean") fail("no_run_error_invalid");
  }
  if (["failed", "unresolved", "rejected"].includes(value.disposition) !== (value.error !== null)) {
    fail("no_run_error_disposition_mismatch");
  }
  if (value.notification !== null) {
    exact(value.notification, ["identity", "policyRevision", "evidenceRef", "route", "content"],
      "no_run_notification_shape");
    exact(value.notification.route, ["recipient", "channel", "accountId", "target"],
      "no_run_notification_route_shape");
    if (["suppressed", "rejected"].includes(value.disposition) ||
        value.evidence.freshness !== "fresh" ||
        !["identity", "policyRevision", "evidenceRef"].every((key) => identifier(value.notification[key])) ||
        value.notification.evidenceRef !== value.evidence.ref ||
        !Object.values(value.notification.route).every(identifier) ||
        typeof value.notification.content !== "string" || !value.notification.content.trim() ||
        value.notification.content.length > MAX_RENDERED_TEXT) fail("no_run_notification_invalid");
  }
  // Same-call reads cannot authorize durable effects, reconciliation or outbound.
  if (nativeRead && (value.effects.status !== "none" || value.reconciliation.required ||
      value.notification !== null)) fail("native_read_effects_or_notification");
  return freeze(value);
}

function candidate(value) {
  if (value === null) return null;
  exact(value, ["text", "language"], "candidate_shape");
  if (typeof value.text !== "string" || value.text.length < 1 ||
      value.text.length > MAX_RENDERED_TEXT || !value.text.trim() ||
      !["en", "he"].includes(value.language)) fail("candidate_invalid");
  return { text: value.text, language: value.language };
}
function policy(value) {
  exact(value, ["allowedModes", "preferredMode"], "policy_shape");
  if (!Array.isArray(value.allowedModes) || value.allowedModes.length < 1 ||
      value.allowedModes.length > MODES.length || new Set(value.allowedModes).size !== value.allowedModes.length ||
      !value.allowedModes.every((mode) => MODES.includes(mode)) ||
      !value.allowedModes.includes(value.preferredMode)) fail("policy_invalid");
  return { allowedModes: [...value.allowedModes], preferredMode: value.preferredMode };
}
function pending(value) {
  if (value === null) return null;
  exact(value, ["schemaVersion", "value", "binding", "expiresAt"], "pending_shape");
  exact(value.binding, ["requesterId", "conversationId"], "pending_binding_shape");
  if (value.schemaVersion !== CONTROL_CONTRACT_VERSION ||
      !identifier(value.binding.requesterId) || !identifier(value.binding.conversationId) ||
      !timestamp(value.expiresAt) || !isPlainObject(value.value)) fail("pending_invalid");
  return { schemaVersion: CONTROL_CONTRACT_VERSION, value: boundedCopy(value.value),
    binding: { ...value.binding }, expiresAt: value.expiresAt };
}

export function createExecutionRoute(trusted) {
  exact(trusted, ROUTE_KEYS, "route_shape");
  if (trusted.schemaVersion !== CONTROL_CONTRACT_VERSION || !identifier(trusted.requestId) ||
      !identifier(trusted.executionOwner) ||
      !["CALLER", "RESPONSE_CONTROLLER"].includes(trusted.completionTarget) ||
      (trusted.completionTarget === "CALLER" ? !identifier(trusted.callerRunId) : trusted.callerRunId !== null)) {
    fail("route_invalid");
  }
  return freeze({ ...trusted, responsePolicy: policy(trusted.responsePolicy) });
}

export function completionRoute(executionRoute) {
  const route = createExecutionRoute(executionRoute);
  return freeze({ schemaVersion: route.schemaVersion, requestId: route.requestId,
    executionOwner: route.executionOwner, completionTarget: route.completionTarget,
    callerRunId: route.callerRunId });
}

export function validateTaskResultEnvelope(raw) {
  exact(raw, RESULT_KEYS, "task_result_shape");
  if (raw.schemaVersion !== CONTROL_CONTRACT_VERSION || !identifier(raw.domainSchemaVersion) ||
      !identifier(raw.taskId) || !["success", "clarification_required", "failure"].includes(raw.status) ||
      DOMAIN_VERSIONS[raw.domain] !== raw.domainSchemaVersion || (raw.operation !== null && !identifier(raw.operation)) ||
      typeof raw.verified !== "boolean" || !Array.isArray(raw.warnings) ||
      raw.warnings.length > MAX_WARNINGS || raw.warnings.some((item) => !isPlainObject(item)) ||
      (raw.error !== null && !isPlainObject(raw.error)) ||
      (raw.status === "success" && (!raw.verified || raw.error !== null || raw.pendingContext !== null)) ||
      (raw.status === "clarification_required" &&
        (raw.verified || raw.error !== null || raw.pendingContext === null)) ||
      (raw.status === "failure" && raw.error === null)) fail("task_result_invalid");
  const result = { ...raw, data: boundedCopy(raw.data), warnings: boundedCopy(raw.warnings),
    error: boundedCopy(raw.error), pendingContext: pending(raw.pendingContext),
    messageCandidate: candidate(raw.messageCandidate) };
  boundedCopy(result);
  return freeze(result);
}

// Legacy agent fields are exact. New trusted task identity and pending binding
// arrive separately; no agent/model field can select a route or response policy.
export function normalizeLegacyTaskResult(raw, trusted, messageCandidate = null) {
  if (!isPlainObject(raw)) fail("legacy_result_shape");
  const jessica = raw.domain === "jessica-vacuum";
  exact(raw, jessica ? ["schemaVersion", ...LEGACY_KEYS] : LEGACY_KEYS, "legacy_result_shape");
  exact(trusted, ["taskId", "pendingBinding", "pendingExpiresAt"], "legacy_trusted_shape");
  if (!identifier(trusted.taskId) ||
      (jessica ? raw.schemaVersion !== "1" : raw.domain !== "reminder")) fail("legacy_version_or_domain");
  if (raw.pendingContext !== null &&
      (!isPlainObject(trusted.pendingBinding) || !timestamp(trusted.pendingExpiresAt) ||
       (jessica && raw.pendingContext.expiresAt !== trusted.pendingExpiresAt))) {
    fail("legacy_pending_binding_required");
  }
  return validateTaskResultEnvelope({
    schemaVersion: CONTROL_CONTRACT_VERSION,
    domainSchemaVersion: jessica ? "1" : "legacy-unversioned",
    taskId: trusted.taskId, status: raw.status, domain: raw.domain,
    operation: raw.operation, verified: raw.verified, data: raw.data,
    warnings: raw.warnings, error: raw.error,
    pendingContext: raw.pendingContext === null ? null : {
      schemaVersion: CONTROL_CONTRACT_VERSION, value: raw.pendingContext,
      binding: trusted.pendingBinding, expiresAt: trusted.pendingExpiresAt,
    },
    messageCandidate,
  });
}

export function deriveResponseStatus(results) {
  if (!Array.isArray(results) || results.length < 1 ||
      results.length > MAX_RESPONSE_RESULTS) fail("response_results_count");
  const statuses = results.map((result) => validateTaskResultEnvelope(result).status);
  return statuses.every((status) => status === statuses[0]) ? statuses[0] : "partial";
}

function responseLifecycle(value) {
  exact(value, ["domainExecution", "failure"], "response_lifecycle_shape");
  if (!["none", "attempted", "uncertain"].includes(value.domainExecution)) {
    fail("response_lifecycle_execution");
  }
  if (value.failure !== null) {
    exact(value.failure, ["code"], "response_failure_shape");
    if (typeof value.failure.code !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,63}$/u.test(value.failure.code)) fail("response_failure_code");
  }
  return { domainExecution: value.domainExecution,
    failure: value.failure === null ? null : { code: value.failure.code } };
}

export function deriveResponseStatusWithLifecycle(results, lifecycle) {
  const facts = responseLifecycle(lifecycle);
  if (results.length === 0) return facts.failure === null ? "success" : "failure";
  const resultStatus = deriveResponseStatus(results);
  if (facts.failure === null) return resultStatus;
  return results.some((result) => result.status !== "failure") ? "partial" : "failure";
}

export function validateResponseEnvelope(raw) {
  exact(raw, RESPONSE_KEYS, "response_shape");
  exact(raw.source, ["type", "agentId", "runId"], "source_shape");
  exact(raw.provenance, ["executionVerified", "completionCorrelated"], "provenance_shape");
  if (raw.schemaVersion !== RESPONSE_CONTRACT_VERSION || !identifier(raw.requestId) ||
      !["main", "direct"].includes(raw.source.type) ||
      !identifier(raw.source.agentId) || !identifier(raw.source.runId) ||
      !Array.isArray(raw.results) || raw.results.length > MAX_RESPONSE_RESULTS ||
      ![true, false, "not_applicable"].includes(raw.provenance.executionVerified) ||
      typeof raw.provenance.completionCorrelated !== "boolean") fail("response_invalid");
  const results = raw.results.map(validateTaskResultEnvelope);
  const lifecycle = responseLifecycle(raw.lifecycle);
  if (new Set(results.map((result) => result.taskId)).size !== results.length) fail("duplicate_task_result");
  if (results.length === 0) {
    if (raw.provenance.completionCorrelated || raw.pendingContext !== null ||
        raw.status !== deriveResponseStatusWithLifecycle(results, lifecycle) ||
        (lifecycle.failure === null && (raw.source.type !== "main" ||
          lifecycle.domainExecution !== "none" ||
          raw.provenance.executionVerified !== "not_applicable")) ||
        (lifecycle.failure !== null && raw.provenance.executionVerified !==
          (lifecycle.domainExecution === "none" ? "not_applicable" : false))) {
      fail("no_domain_result_invalid");
    }
  } else if (lifecycle.domainExecution === "none" ||
      raw.status !== deriveResponseStatusWithLifecycle(results, lifecycle) ||
      raw.provenance.executionVerified !== results.every((result) => result.verified) ||
      !raw.provenance.completionCorrelated ||
      (raw.source.type === "direct" && results.length !== 1)) fail("response_results_invalid");
  const contexts = results.map((result) => result.pendingContext).filter(Boolean);
  if (contexts.length > 1 ||
      (contexts.length === 0 ? raw.pendingContext !== null :
        JSON.stringify(raw.pendingContext) !== JSON.stringify(contexts[0]))) fail("response_pending_mismatch");
  const response = { ...raw, results, pendingContext: pending(raw.pendingContext),
    messageCandidate: candidate(raw.messageCandidate), responsePolicy: policy(raw.responsePolicy),
    source: { ...raw.source }, provenance: { ...raw.provenance }, lifecycle };
  boundedCopy(response);
  return freeze(response);
}

export function validateRenderedOutput(raw) {
  exact(raw, ["schemaVersion", "message"], "rendered_shape");
  if (raw.schemaVersion !== RESPONSE_CONTRACT_VERSION || typeof raw.message !== "string" ||
      raw.message.length < 1 || raw.message.length > MAX_RENDERED_TEXT ||
      !raw.message.trim()) fail("rendered_invalid");
  return freeze({ ...raw });
}

// Candidate text is the only agent-authored response input here. The native
// finalization owner supplies source, results, policy, and provenance.
export function createResponseEnvelope(candidateInput, trusted) {
  exact(candidateInput, ["messageCandidate"], "response_candidate_shape");
  exact(trusted, ["requestId", "source", "results", "status", "pendingContext", "responsePolicy", "provenance", "lifecycle"], "response_trusted_shape");
  return validateResponseEnvelope({
    schemaVersion: RESPONSE_CONTRACT_VERSION,
    ...trusted,
    messageCandidate: candidateInput.messageCandidate,
  });
}

function resultFromNativeCompletion(completion, requestId, parentSession, destination) {
  exact(completion, NATIVE_COMPLETION_KEYS, "native_completion_shape");
  exact(completion.binding, COMPLETION_BINDING_KEYS, "completion_binding_shape");
  exact(completion.admission, COMPLETION_ADMISSION_KEYS, "completion_admission_shape");
  const { binding, admission } = completion;
  if (binding.schemaVersion !== CONTROL_CONTRACT_VERSION ||
      binding.requestId !== requestId ||
      binding.parentSessionKey !== parentSession.sessionKey ||
      binding.parentSessionId !== parentSession.sessionId ||
      !((destination === "CALLER" && identifier(binding.parentRunId)) ||
        (destination === "RESPONSE_CONTROLLER" && binding.parentRunId === null)) ||
      !identifier(binding.childRunId) ||
      !identifier(binding.childSessionKey) || !identifier(binding.executionOwner) ||
      !binding.childSessionKey.startsWith(`agent:${binding.executionOwner}:subagent:`) ||
      binding.completionTarget !== destination ||
      (destination === "CALLER" ? binding.callerRunId !== binding.parentRunId :
        binding.callerRunId !== null)) fail("completion_binding_mismatch");
  if (admission.schemaVersion !== CONTROL_CONTRACT_VERSION ||
      admission.requestId !== requestId || admission.childRunId !== binding.childRunId ||
      !identifier(admission.taskId) || admission.destination !== destination ||
      admission.callerRunId !== binding.callerRunId) fail("completion_admission_mismatch");
  const result = validateTaskResultEnvelope(admission.result);
  if (result.taskId !== admission.taskId ||
      DOMAIN_AGENTS[result.domain] !== binding.executionOwner) fail("completion_result_mismatch");
  return result;
}

function factsFromCompletions(completions, requestId, parentSession, destination) {
  if (!Array.isArray(completions) || completions.length > MAX_RESPONSE_RESULTS) {
    fail("response_completions_count");
  }
  const seenRuns = new Set();
  const results = completions.map((completion) => {
    const result = resultFromNativeCompletion(completion, requestId, parentSession, destination);
    if (seenRuns.has(completion.binding.childRunId)) fail("duplicate_completion_run");
    seenRuns.add(completion.binding.childRunId);
    return result;
  });
  if (new Set(results.map((result) => result.taskId)).size !== results.length) {
    fail("duplicate_task_result");
  }
  const contexts = results.map((result) => result.pendingContext).filter(Boolean);
  if (contexts.length > 1) fail("response_pending_ambiguous");
  return { results, pendingContext: contexts[0] ?? null,
    provenance: { executionVerified: results.length ? results.every((result) => result.verified) : "not_applicable",
      completionCorrelated: results.length > 0 } };
}

// Only the native Main finalization owner supplies its current source run, the
// owning session, S07 completion records, request and policy. Main supplies
// candidate wording alone; earlier child caller runs may differ from this run.
export function createMainResponseEnvelope(candidateInput, trusted) {
  exact(trusted, ["requestId", "source", "parentSession", "completions", "lifecycle", "responsePolicy"],
    "main_finalization_shape");
  exact(trusted.source, ["type", "agentId", "runId"], "source_shape");
  exact(trusted.parentSession, PARENT_SESSION_KEYS, "parent_session_shape");
  if (!identifier(trusted.requestId) || trusted.source.type !== "main" ||
      trusted.source.agentId !== "main" || !identifier(trusted.source.runId) ||
      !identifier(trusted.parentSession.sessionKey) ||
      !identifier(trusted.parentSession.sessionId)) fail("main_finalization_source");
  const facts = factsFromCompletions(trusted.completions, trusted.requestId,
    trusted.parentSession, "CALLER");
  const lifecycle = responseLifecycle(trusted.lifecycle);
  return createResponseEnvelope(candidateInput, {
    requestId: trusted.requestId, source: trusted.source,
    status: deriveResponseStatusWithLifecycle(facts.results, lifecycle),
    results: facts.results, pendingContext: facts.pendingContext, lifecycle,
    responsePolicy: trusted.responsePolicy, provenance: { ...facts.provenance,
      executionVerified: facts.results.length === 0 && lifecycle.domainExecution !== "none" ? false : facts.provenance.executionVerified },
  });
}

// A direct completion becomes the same contract without a Main wrapper.
// Native finalization retains the owning session outside the response payload.
export function createDirectResponseEnvelope(completion, trusted) {
  exact(trusted, ["requestId", "source", "parentSession", "responsePolicy"],
    "direct_finalization_shape");
  exact(trusted.source, ["type", "agentId", "runId"], "source_shape");
  exact(trusted.parentSession, PARENT_SESSION_KEYS, "parent_session_shape");
  if (!identifier(trusted.requestId) || trusted.source.type !== "direct" ||
      !identifier(trusted.source.runId) ||
      !identifier(trusted.parentSession.sessionKey) ||
      !identifier(trusted.parentSession.sessionId)) fail("direct_finalization_source");
  const facts = factsFromCompletions([completion], trusted.requestId,
    trusted.parentSession, "RESPONSE_CONTROLLER");
  if (trusted.source.runId !== completion.binding.childRunId ||
      trusted.source.agentId !== completion.binding.executionOwner) {
    fail("direct_finalization_source");
  }
  return createResponseEnvelope({ messageCandidate: facts.results[0].messageCandidate }, {
    requestId: trusted.requestId, source: trusted.source,
    status: facts.results[0].status, results: facts.results,
    pendingContext: facts.pendingContext, responsePolicy: trusted.responsePolicy,
    provenance: facts.provenance,
    lifecycle: { domainExecution: "attempted", failure: null },
  });
}

// A native terminal failure can have no valid domain result. The failure fact
// remains separate from TaskResultEnvelope and cannot invent domain success.
export function createDirectFailureResponseEnvelope(trusted) {
  exact(trusted, ["requestId", "source", "parentSession", "responsePolicy", "lifecycle"],
    "direct_failure_shape");
  exact(trusted.parentSession, PARENT_SESSION_KEYS, "parent_session_shape");
  if (!identifier(trusted.parentSession.sessionKey) ||
      !identifier(trusted.parentSession.sessionId)) fail("direct_failure_session");
  return createResponseEnvelope({ messageCandidate: null }, {
    requestId: trusted.requestId, source: trusted.source, status: "failure",
    results: [], pendingContext: null, responsePolicy: trusted.responsePolicy,
    provenance: { executionVerified: trusted.lifecycle.domainExecution === "none" ?
      "not_applicable" : false, completionCorrelated: false },
    lifecycle: trusted.lifecycle,
  });
}

// Call at the native continuation boundary before accepting a clarification.
// Structural validation alone never authorizes reuse of pending context.
export function assertPendingContextBinding(value, trusted, now = new Date()) {
  exact(trusted, ["requesterId", "conversationId"], "pending_trusted_shape");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("pending_clock_invalid");
  const normalized = pending(value);
  if (normalized === null || normalized.binding.requesterId !== trusted.requesterId ||
      normalized.binding.conversationId !== trusted.conversationId ||
      Date.parse(normalized.expiresAt) <= now.getTime()) fail("pending_binding_or_expiry");
  return freeze(normalized);
}

// One private completion family. The v1/v2 consumers above remain transition
// readers; native integrations retain lifecycle, persistence and routing.
import { isDeepStrictEqual } from 'node:util';

// Pinned transition readers; successor producers must explicitly select v5.
export const COMPLETION_SCHEMA_VERSION = 3;
export const CURRENT_COMPLETION_SCHEMA_VERSION = 4;
// Explicit, inactive successor in the same family. Legacy defaults stay v3/v4.
export const SUCCESSOR_COMPLETION_SCHEMA_VERSION = 5;
export const MAX_WORKFLOW_ADMISSIONS = 256;
export const COMPLETION_KINDS = Object.freeze(['domain-task', 'final-workflow']);
const V5_COMPLETION_KINDS = ['domain-task', 'agent-run'];
export const COMPLETION_STATUSES = Object.freeze([
  'success', 'clarification_required', 'failure', 'partial', 'unknown', 'not_applicable',
]);
const FACT_KEYS = ['status', 'domain', 'domainSchemaVersion', 'operation', 'verified',
  'verificationScope', 'data', 'warnings', 'error', 'effects', 'uncertainty', 'pendingContext'];
const BINDING_KEYS = ['requestId', 'workflowId', 'runId', 'agentId', 'sessionKey',
  'sessionId', 'generation', 'taskId', 'callerRunId', 'completionTarget', 'finality',
  'authorizationId', 'deliveryPolicy'];
const V4_BINDING_KEYS = ['conversationId', 'conversationGeneration', 'admissionId',
  'admissionSequence', 'workflowId', 'membershipRevision', 'acceptedIntentRevision',
  'runId', 'runGeneration', 'agentId', 'sessionKey', 'sessionId', 'sessionGeneration',
  'taskId', 'caller', 'role', 'completionTarget', 'finality', 'authorizationId', 'deliveryPolicy'];
const V5_BINDING_KEYS = ['inputId', 'admissionId', 'conversationId', 'conversationGeneration',
  'runId', 'runGeneration', 'agentId', 'sessionKey', 'sessionId', 'sessionGeneration',
  'domain', 'taskId', 'caller', 'completionTarget', 'authorizationId',
  'parentContinuation', 'deliveryPolicy'];
const V5_CALLER_KEYS = ['runId', 'runGeneration', 'agentId', 'sessionKey', 'sessionId', 'sessionGeneration'];
const NATIVE_EVIDENCE_KEYS = ['kind', 'binding', 'knownFacts', 'results', 'coverage', 'gaps', 'origin'];
const RECORD_KEYS = ['schemaVersion', 'kind', 'facts', 'results', 'userResponse',
  'binding', 'completion'];
const authorities = new WeakMap();

function code(value) { return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value); }
function list(value, field) {
  if (!Array.isArray(value) || value.length > MAX_WARNINGS ||
      value.some((entry) => !isPlainObject(entry))) fail(`${field}_invalid`);
  return boundedCopy(value);
}
function gaps(value) {
  const result = list(value, 'completion_gaps');
  for (const gap of result) {
    exact(gap, ['code', 'path', 'detail'], 'completion_gap_shape');
    if (!code(gap.code) || !identifier(gap.path) || !identifier(gap.detail)) fail('completion_gap_invalid');
  }
  return result;
}
function userResponse(value) {
  if (!isPlainObject(value)) fail('user_response_required');
  if (value.state === 'usable') {
    exact(value, ['state', 'text', 'language'], 'user_response_shape');
    return { state: 'usable', ...candidate({ text: value.text, language: value.language }) };
  }
  if (value.state === 'unavailable') {
    exact(value, ['state', 'reason'], 'user_response_shape');
    exact(value.reason, ['code', 'detail'], 'user_response_reason_shape');
    if (!code(value.reason.code) || !identifier(value.reason.detail)) fail('user_response_reason_invalid');
    return boundedCopy(value);
  }
  fail('user_response_state');
}
function revision(value) { return Number.isSafeInteger(value) && value > 0; }
function generationToken(value) { return revision(value) || identifier(value); }
function completionKinds(version) {
  return version === SUCCESSOR_COMPLETION_SCHEMA_VERSION ? V5_COMPLETION_KINDS : COMPLETION_KINDS;
}
function componentCompletion(version) {
  return version === CURRENT_COMPLETION_SCHEMA_VERSION || version === SUCCESSOR_COMPLETION_SCHEMA_VERSION;
}
function v5Binding(value, kind) {
  exact(value, V5_BINDING_KEYS, 'completion_binding_shape');
  for (const key of ['inputId', 'admissionId', 'runId', 'agentId', 'sessionKey', 'sessionId', 'authorizationId']) {
    if (!identifier(value[key])) fail('completion_binding_identity');
  }
  for (const key of ['runGeneration', 'sessionGeneration']) {
    if (!generationToken(value[key])) fail('completion_binding_generation');
  }
  // Headless Runs have no invented conversation. Both fields must be absent together.
  if (value.conversationId === null ? value.conversationGeneration !== null :
      !identifier(value.conversationId) || !generationToken(value.conversationGeneration)) {
    fail('completion_conversation_binding');
  }
  if (kind === 'domain-task' ? !Object.hasOwn(DOMAIN_AGENTS, value.domain) ||
      value.agentId !== DOMAIN_AGENTS[value.domain] || !identifier(value.taskId) :
      value.domain !== null || value.taskId !== null) fail('completion_domain_binding');
  if (!['CALLER', 'RESPONSE_CONTROLLER', 'NATIVE'].includes(value.completionTarget)) {
    fail('completion_binding_invalid');
  }
  if (value.caller !== null) {
    exact(value.caller, V5_CALLER_KEYS, 'completion_caller_shape');
    for (const key of ['runId', 'agentId', 'sessionKey', 'sessionId']) {
      if (!identifier(value.caller[key])) fail('completion_caller_identity');
    }
    if (!generationToken(value.caller.runGeneration) || !generationToken(value.caller.sessionGeneration) ||
        value.caller.runId === value.runId) fail('completion_caller_binding');
  }
  for (const key of ['parentContinuation', 'deliveryPolicy']) {
    exact(value[key], ['eligible', 'reason'], 'completion_eligibility_shape');
    if (typeof value[key].eligible !== 'boolean' ||
        (value[key].reason !== null && !code(value[key].reason))) fail('completion_eligibility_invalid');
  }
  // Settlement is required even when continuation and outbound are both denied.
  // These host-projected eligibility facts grant nothing and perform no handoff.
  if ((value.completionTarget === 'CALLER' && value.caller === null) ||
      (value.parentContinuation.eligible && (value.caller === null || value.completionTarget !== 'CALLER')) ||
      (value.deliveryPolicy.eligible && value.completionTarget !== 'RESPONSE_CONTROLLER')) {
    fail('completion_eligibility_binding');
  }
  return freeze(boundedCopy(value));
}
function v4Binding(value, kind) {
  exact(value, V4_BINDING_KEYS, 'completion_binding_shape');
  for (const key of ['conversationId', 'admissionId', 'workflowId', 'runId', 'agentId',
    'sessionKey', 'sessionId', 'authorizationId']) {
    if (!identifier(value[key])) fail('completion_binding_identity');
  }
  for (const key of ['admissionSequence', 'membershipRevision', 'acceptedIntentRevision']) {
    if (!revision(value[key])) fail('completion_binding_revision');
  }
  for (const key of ['conversationGeneration', 'runGeneration', 'sessionGeneration']) {
    if (!generationToken(value[key])) fail('completion_binding_generation');
  }
  if (!['domain-task', 'direct-final', 'workflow-final'].includes(value.role) ||
      kind !== (value.role === 'domain-task' ? 'domain-task' : 'final-workflow') ||
      (kind === 'domain-task' ? !identifier(value.taskId) : value.taskId !== null) ||
      !['CALLER', 'RESPONSE_CONTROLLER'].includes(value.completionTarget) ||
      value.finality !== (value.completionTarget === 'RESPONSE_CONTROLLER') ||
      (kind === 'final-workflow' && !value.finality)) fail('completion_binding_invalid');
  if (value.completionTarget === 'CALLER') {
    exact(value.caller, ['workflowId', 'runId', 'runGeneration', 'agentId', 'sessionKey',
      'sessionId', 'sessionGeneration'], 'completion_caller_shape');
    for (const key of ['workflowId', 'runId', 'agentId', 'sessionKey', 'sessionId']) {
      if (!identifier(value.caller[key])) fail('completion_caller_identity');
    }
    if (value.caller.workflowId !== value.workflowId ||
        !generationToken(value.caller.runGeneration) || !generationToken(value.caller.sessionGeneration)) {
      fail('completion_caller_binding');
    }
  } else if (value.caller !== null) fail('completion_caller_binding');
  exact(value.deliveryPolicy, ['eligible', 'reason'], 'completion_delivery_policy_shape');
  if (typeof value.deliveryPolicy.eligible !== 'boolean' ||
      (value.deliveryPolicy.reason !== null && !code(value.deliveryPolicy.reason)) ||
      (!value.finality && value.deliveryPolicy.eligible)) fail('completion_delivery_policy_invalid');
  return freeze(boundedCopy(value));
}
function nativeBinding(value, kind, version = COMPLETION_SCHEMA_VERSION) {
  if (version === SUCCESSOR_COMPLETION_SCHEMA_VERSION) return v5Binding(value, kind);
  if (version === CURRENT_COMPLETION_SCHEMA_VERSION) return v4Binding(value, kind);
  exact(value, BINDING_KEYS, 'completion_binding_shape');
  for (const key of ['requestId', 'workflowId', 'runId', 'agentId', 'sessionKey',
    'sessionId', 'authorizationId']) if (!identifier(value[key])) fail('completion_binding_identity');
  if (!Number.isSafeInteger(value.generation) || value.generation < 1 ||
      (value.taskId !== null && !identifier(value.taskId)) ||
      (kind === 'domain-task' && value.taskId === null) ||
      (kind === 'final-workflow' && value.taskId !== null) ||
      !['CALLER', 'RESPONSE_CONTROLLER'].includes(value.completionTarget) ||
      (value.completionTarget === 'CALLER' ? !identifier(value.callerRunId) : value.callerRunId !== null) ||
      value.finality !== (value.completionTarget === 'RESPONSE_CONTROLLER')) fail('completion_binding_invalid');
  exact(value.deliveryPolicy, ['eligible', 'reason'], 'completion_delivery_policy_shape');
  if (typeof value.deliveryPolicy.eligible !== 'boolean' ||
      (value.deliveryPolicy.reason !== null && !code(value.deliveryPolicy.reason)) ||
      (!value.finality && value.deliveryPolicy.eligible)) fail('completion_delivery_policy_invalid');
  return freeze(boundedCopy(value));
}
function missingFactFields(missing) {
  return FACT_KEYS.filter(field => missing.some(gap =>
    gap.code === 'FACT_NOT_ESTABLISHED' && gap.path === `facts.${field}`));
}
function factAbsences(binding, ownFields, results) {
  return [...new Set([...ownFields, ...(binding.role === 'direct-final' ?
    missingFactFields(results[0]?.completion.gaps ?? []) : [])])];
}
function facts(value, kind, outcome, version, absentFields) {
  const absent = field => componentCompletion(version) &&
    outcome === 'FAILED' && absentFields.includes(field);
  exact(value, FACT_KEYS, 'completion_facts_shape');
  if (!COMPLETION_STATUSES.includes(value.status) ||
      ![true, false, 'unknown', 'not_applicable'].includes(value.verified) ||
      !Array.isArray(value.verificationScope) || value.verificationScope.length > MAX_WARNINGS ||
      value.verificationScope.some((entry) => !identifier(entry)) ||
      new Set(value.verificationScope).size !== value.verificationScope.length ||
      (value.error !== null && !isPlainObject(value.error)) ||
      (value.operation !== null && !identifier(value.operation))) fail('completion_facts_invalid');
  if (kind === 'domain-task') {
    if ((value.domain === null && absent('domain')) ||
        (value.domainSchemaVersion === null && absent('domainSchemaVersion'))) {
      if ((value.domain !== null && !Object.hasOwn(DOMAIN_VERSIONS, value.domain)) ||
          (value.domainSchemaVersion !== null && !Object.values(DOMAIN_VERSIONS).includes(value.domainSchemaVersion))) {
        fail('completion_domain_version');
      }
    } else if (value.domain === null && value.domainSchemaVersion === null) {
      if (outcome !== 'FAILED') fail('completion_domain_unknown');
    } else if (!Object.hasOwn(DOMAIN_VERSIONS, value.domain) ||
        DOMAIN_VERSIONS[value.domain] !== value.domainSchemaVersion) fail('completion_domain_version');
  } else if (value.domain !== null || value.domainSchemaVersion !== null || value.operation !== null) {
    fail('completion_workflow_domain');
  }
  if (value.verified === true && value.verificationScope.length === 0 && !absent('verificationScope')) {
    fail('completion_verification_scope');
  }
  if (value.verified === 'not_applicable' && (value.verificationScope.length || value.effects.length)) {
    fail('completion_verification_not_applicable');
  }
  // A FAILED report may have gaps in error/pending/verification evidence. Known
  // business status is retained; the completion gaps explicitly explain absence.
  if (outcome !== 'FAILED') {
    if (value.status === 'success' && (value.error !== null || value.pendingContext !== null ||
        (kind === 'domain-task' && value.verified !== true))) fail('completion_success_invalid');
    if (value.status === 'failure' && value.error === null) fail('completion_failure_error');
    if (value.status === 'clarification_required' &&
        (value.pendingContext === null || value.error !== null || value.verified !== false)) fail('completion_clarification_invalid');
    if (value.status === 'unknown' && value.uncertainty.length === 0) fail('completion_unknown_unexplained');
    if (value.status === 'not_applicable' && value.verified !== 'not_applicable') fail('completion_not_applicable_invalid');
  }
  return freeze({ ...value, verificationScope: [...value.verificationScope],
    data: boundedCopy(value.data), warnings: list(value.warnings, 'completion_warnings'),
    error: boundedCopy(value.error), effects: list(value.effects, 'completion_effects'),
    uncertainty: list(value.uncertainty, 'completion_uncertainty'), pendingContext: pending(value.pendingContext) });
}

// Shape validation alone never establishes trust. Every consumer additionally
// requires validateCompletion(record, nativeAuthority) against native evidence.
function incompleteChildGap(record, index = 0) {
  const path = componentCompletion(record.schemaVersion) ?
    `results.${index}` : `results.${record.binding.taskId}`;
  return { code: 'CHILD_COMPLETION_INCOMPLETE', path,
    detail: 'Child report preserves known facts but lacks complete semantics.' };
}
function completionBounds(record) {
  if (record.schemaVersion === COMPLETION_SCHEMA_VERSION) {
    boundedCopy(record);
    return;
  }
  // Each v4/v5 record component has the original budget. Its validated domain
  // children keep their own budget when embedded two structural levels deeper.
  boundedCopy({ ...record, results: [] });
  const count = record.results.length;
  const maximum = MAX_BYTES * (count + 1) + Math.max(0, count - 1);
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > maximum) fail('json_bytes_exceeded');
}
function completionShape(raw) {
  exact(raw, RECORD_KEYS, 'completion_shape');
  if (![COMPLETION_SCHEMA_VERSION, CURRENT_COMPLETION_SCHEMA_VERSION, SUCCESSOR_COMPLETION_SCHEMA_VERSION]
      .includes(raw.schemaVersion) || !completionKinds(raw.schemaVersion).includes(raw.kind)) {
    fail('completion_version_or_kind');
  }
  exact(raw.completion, ['outcome', 'gaps'], 'completion_outcome_shape');
  if (!['NORMAL', 'RECOVERED', 'FAILED'].includes(raw.completion.outcome)) fail('completion_outcome_invalid');
  const missing = gaps(raw.completion.gaps);
  if ((raw.completion.outcome === 'FAILED') !== (missing.length > 0)) fail('completion_outcome_gaps');
  if (!Array.isArray(raw.results) || raw.results.length > MAX_RESPONSE_RESULTS ||
      (raw.kind === 'domain-task' && raw.results.length)) fail('completion_results_count');
  const results = raw.results.map((result) => {
    if (result?.kind !== 'domain-task' || result.schemaVersion !== raw.schemaVersion) fail('completion_result_kind');
    return completionShape(result);
  });
  if (new Set(results.map((result) => result.binding.taskId)).size !== results.length) fail('completion_duplicate_task');
  const binding = nativeBinding(raw.binding, raw.kind, raw.schemaVersion);
  const result = { schemaVersion: raw.schemaVersion, kind: raw.kind,
    facts: facts(raw.facts, raw.kind, raw.completion.outcome, raw.schemaVersion,
      factAbsences(binding, missingFactFields(missing), results)), results,
    userResponse: userResponse(raw.userResponse), binding,
    completion: { outcome: raw.completion.outcome, gaps: missing } };
  if (raw.schemaVersion === SUCCESSOR_COMPLETION_SCHEMA_VERSION) {
    if (result.facts.domain !== binding.domain &&
        !(result.completion.outcome === 'FAILED' && result.facts.domain === null &&
          missingFactFields(missing).includes('domain'))) fail('completion_domain_binding');
    // Missing domain evidence cannot relax the schema of a domain already
    // established by the trusted binding. Preserve valid partial recovery.
    if (binding.domain !== null && result.facts.domainSchemaVersion !== null &&
        result.facts.domainSchemaVersion !== DOMAIN_VERSIONS[binding.domain]) {
      fail('completion_domain_version');
    }
    if (new Set(results.map(child => child.binding.runId)).size !== results.length) {
      fail('completion_duplicate_run');
    }
  }
  for (const child of results) {
    if (raw.schemaVersion === SUCCESSOR_COMPLETION_SCHEMA_VERSION) {
      if (child.binding.conversationId !== binding.conversationId ||
          child.binding.conversationGeneration !== binding.conversationGeneration ||
          child.binding.caller === null ||
          V5_CALLER_KEYS.some(key => child.binding.caller[key] !== binding[key])) {
        fail('completion_result_correlation');
      }
      continue;
    }
    if (raw.schemaVersion === CURRENT_COMPLETION_SCHEMA_VERSION) {
      if (child.binding.workflowId !== result.binding.workflowId ||
          child.binding.conversationId !== result.binding.conversationId ||
          child.binding.conversationGeneration !== result.binding.conversationGeneration ||
          child.binding.membershipRevision > result.binding.membershipRevision ||
          child.binding.acceptedIntentRevision > result.binding.acceptedIntentRevision) {
        fail('completion_result_correlation');
      }
      if (result.binding.role === 'direct-final') {
        const keys = ['conversationId', 'conversationGeneration', 'admissionId', 'admissionSequence',
          'workflowId', 'membershipRevision', 'acceptedIntentRevision', 'runId', 'runGeneration',
          'agentId', 'sessionKey', 'sessionId', 'sessionGeneration', 'authorizationId', 'deliveryPolicy'];
        if (results.length !== 1 || child.binding.completionTarget !== 'RESPONSE_CONTROLLER' ||
            keys.some((key) => !isDeepStrictEqual(child.binding[key], result.binding[key]))) {
          fail('completion_direct_result_binding');
        }
      } else if (child.binding.completionTarget !== 'CALLER' ||
          child.binding.caller.agentId !== result.binding.agentId) fail('completion_result_caller');
      continue;
    }
    if (child.binding.requestId !== result.binding.requestId ||
        child.binding.workflowId !== result.binding.workflowId ||
        child.binding.sessionId !== result.binding.sessionId ||
        child.binding.sessionKey !== result.binding.sessionKey) fail('completion_result_correlation');
    if (child.binding.completionTarget === 'RESPONSE_CONTROLLER' &&
        (results.length !== 1 || result.binding.completionTarget !== 'RESPONSE_CONTROLLER' ||
         child.binding.runId !== result.binding.runId || child.binding.agentId !== result.binding.agentId ||
         child.binding.generation !== result.binding.generation)) fail('completion_direct_result_binding');
  }
  if (['final-workflow', 'agent-run'].includes(raw.kind) && raw.completion.outcome !== 'FAILED') {
    if (raw.facts.status === 'success' && results.some((child) =>
        !['success', 'not_applicable'].includes(child.facts.status))) fail('completion_success_hides_result');
    if (!results.length && raw.facts.status === 'success' && raw.facts.verified !== 'not_applicable') {
      fail('completion_empty_execution_proof');
    }
  }
  if (raw.schemaVersion === CURRENT_COMPLETION_SCHEMA_VERSION && result.binding.role === 'direct-final') {
    if (results.length !== 1) fail('completion_direct_results_count');
    const projected = { ...results[0].facts, domain: null, domainSchemaVersion: null, operation: null };
    if (!isDeepStrictEqual(boundedCopy(result.facts), boundedCopy(projected))) fail('completion_direct_facts');
    if (result.completion.outcome !== results[0].completion.outcome) fail('completion_direct_outcome');
    if (!isDeepStrictEqual(boundedCopy(result.userResponse), boundedCopy(results[0].userResponse))) {
      fail('completion_direct_response');
    }
  }
  completionBounds(result);
  if (raw.schemaVersion === CURRENT_COMPLETION_SCHEMA_VERSION && result.kind === 'domain-task' &&
      result.binding.completionTarget === 'RESPONSE_CONTROLLER') {
    // Reserve the enclosing record's own component, including retained wording
    // and the canonical recovery gap. The child has its independent budget.
    boundedCopy({ ...result, kind: 'final-workflow',
      facts: { ...result.facts, domain: null, domainSchemaVersion: null, operation: null },
      results: [], binding: { ...result.binding, role: 'direct-final', taskId: null },
      completion: { outcome: result.completion.outcome,
        gaps: result.completion.outcome === 'FAILED' ? [incompleteChildGap(result)] : [] } });
  }
  return freeze(result);
}
function authoritySnapshot(authority) {
  const snapshot = authorities.get(authority);
  if (!snapshot) fail('native_completion_authority_required');
  return snapshot;
}
function unknownFacts() {
  return { status: 'unknown', domain: null, domainSchemaVersion: null, operation: null,
    verified: 'unknown', verificationScope: [], data: null, warnings: [], error: null,
    effects: [], uncertainty: [], pendingContext: null };
}

// This is a transient projection from the native lifecycle owner, not a ledger
// or a claim that the installed host exposes atomic membership/intent reads.
function checkWorkflowEvidence(workflow, binding, results) {
  exact(workflow, ['workflowId', 'conversationId', 'conversationGeneration',
    'membershipRevision', 'acceptedIntentRevision', 'membershipState', 'admissions'], 'native_workflow_shape');
  for (const key of ['workflowId', 'conversationId', 'conversationGeneration',
    'membershipRevision', 'acceptedIntentRevision']) {
    if (workflow[key] !== binding[key]) fail('completion_workflow_binding_mismatch');
  }
  if (!['open', 'closed'].includes(workflow.membershipState) ||
      (binding.finality && workflow.membershipState !== 'closed')) fail('completion_membership_not_closed');
  if (!Array.isArray(workflow.admissions) || !workflow.admissions.length ||
      workflow.admissions.length > MAX_WORKFLOW_ADMISSIONS) fail('native_admissions_count');
  const members = new Map();
  let previousSequence = 0;
  for (const admission of workflow.admissions) {
    exact(admission, ['admissionId', 'sequence'], 'native_admission_shape');
    if (!identifier(admission.admissionId) || !revision(admission.sequence) ||
        admission.sequence <= previousSequence || members.has(admission.admissionId)) {
      fail('native_admission_order_or_identity');
    }
    members.set(admission.admissionId, admission.sequence);
    previousSequence = admission.sequence;
  }
  for (const entry of [binding, ...results.map((result) => result.binding)]) {
    if (members.get(entry.admissionId) !== entry.admissionSequence) fail('completion_admission_not_member');
  }
  if (binding.finality && binding.admissionId !== workflow.admissions[0].admissionId) {
    fail('completion_final_admission_not_anchor');
  }
  boundedCopy(workflow);
}
function checkWorkflowSemantics(semantics, binding, known, missing) {
  if (binding.role !== 'workflow-final') {
    if (semantics !== null) fail('completion_semantics_not_applicable');
    return;
  }
  if (semantics !== null) {
    exact(semantics, ['ownerRunId', 'ownerRunGeneration', 'acceptedIntentRevision', 'coverage', 'value'],
      'native_semantics_shape');
    if (semantics.ownerRunId !== binding.runId || semantics.ownerRunGeneration !== binding.runGeneration ||
        semantics.acceptedIntentRevision !== binding.acceptedIntentRevision) fail('completion_semantic_binding_mismatch');
    if (!['complete', 'incomplete'].includes(semantics.coverage)) fail('native_semantics_coverage');
    if (semantics.value !== null &&
        !isDeepStrictEqual(boundedCopy(semantics.value), boundedCopy(known.data ?? null))) {
      fail('completion_semantic_evidence_mismatch');
    }
  }
  if (semantics === null || semantics.coverage !== 'complete' ||
      !isPlainObject(semantics.value) || !Object.keys(semantics.value).length) {
    missing.push({ code: 'WORKFLOW_SEMANTICS_NOT_ESTABLISHED', path: 'workflow.semantics',
      detail: 'Child facts alone do not establish the final owner semantics for the accepted intent.' });
  }
}

// Private, in-memory capability for an independently collected native evidence
// snapshot. Never expose this constructor as an agent tool or feed agent JSON
// into it. It owns no run state, completion history, retries or durable store.
// Following restart the native owner reconstructs it from existing native state.
export function createCompletionAuthority(native) {
  const version = Object.hasOwn(native ?? {}, 'schemaVersion') ? native.schemaVersion : COMPLETION_SCHEMA_VERSION;
  if (![COMPLETION_SCHEMA_VERSION, CURRENT_COMPLETION_SCHEMA_VERSION, SUCCESSOR_COMPLETION_SCHEMA_VERSION]
      .includes(version)) {
    fail('completion_version_or_kind');
  }
  // The original constructor remains a strict v3 reader. v4/v5 are always explicit.
  exact(native, version === CURRENT_COMPLETION_SCHEMA_VERSION ?
    ['schemaVersion', ...NATIVE_EVIDENCE_KEYS, 'workflow', 'semantics'] :
    version === SUCCESSOR_COMPLETION_SCHEMA_VERSION ? ['schemaVersion', ...NATIVE_EVIDENCE_KEYS] :
      NATIVE_EVIDENCE_KEYS, 'native_evidence_shape');
  if (!completionKinds(version).includes(native.kind) || !['agent', 'runtime'].includes(native.origin) ||
      !['complete', 'incomplete'].includes(native.coverage) ||
      !isPlainObject(native.knownFacts) || Object.keys(native.knownFacts).some((key) => !FACT_KEYS.includes(key)) ||
      !Array.isArray(native.results) || native.results.length > MAX_RESPONSE_RESULTS ||
      (native.kind === 'domain-task' && native.results.length)) fail('native_evidence_invalid');
  const binding = nativeBinding(native.binding, native.kind, version);
  const known = boundedCopy(native.knownFacts);
  const missing = gaps(native.gaps);
  if (native.coverage !== 'complete') missing.push({ code: 'EVIDENCE_COVERAGE_INCOMPLETE',
    path: 'evidence.coverage', detail: 'Native execution evidence does not account for all required work.' });
  const absentFields = FACT_KEYS.filter(field => !Object.hasOwn(known, field));
  for (const field of absentFields) {
    missing.push({ code: 'FACT_NOT_ESTABLISHED',
      path: `facts.${field}`, detail: 'Required semantic fact is absent from trusted native evidence.' });
  }
  const results = native.results.map((entry, index) => {
    exact(entry, ['record', 'authority'], 'native_result_evidence_shape');
    const record = validateCompletion(entry.record, entry.authority);
    if (record.completion.outcome === 'FAILED') missing.push(incompleteChildGap(record, index));
    return record;
  });
  if (version === CURRENT_COMPLETION_SCHEMA_VERSION) {
    checkWorkflowEvidence(native.workflow, binding, results);
    checkWorkflowSemantics(native.semantics, binding, known, missing);
  }
  const normalized = facts({ ...unknownFacts(), ...known }, native.kind,
    missing.length ? 'FAILED' : 'RECOVERED', version, factAbsences(binding, absentFields, results));
  if (componentCompletion(version) && normalized.pendingContext !== null &&
      normalized.pendingContext.binding.conversationId !== binding.conversationId) {
    fail('completion_pending_conversation_mismatch');
  }
  gaps(missing); // Includes generated gaps; never silently truncate evidence.
  const authority = Object.freeze(Object.create(null));
  if (native.origin === 'agent' && missing.length) fail('completion_evidence_insufficient');
  const snapshot = freeze({ schemaVersion: version, kind: native.kind, binding, facts: normalized, results, gaps: missing,
    outcome: native.origin === 'agent' ? 'NORMAL' : missing.length ? 'FAILED' : 'RECOVERED' });
  // Validate correlation and collection bounds even before an agent is consulted.
  completionShape(recordFromSnapshot(snapshot, 'unavailable', snapshot.outcome));
  authorities.set(authority, snapshot);
  return authority;
}
function recordFromSnapshot(snapshot, response, outcome) {
  const retainedResponse = snapshot.schemaVersion === CURRENT_COMPLETION_SCHEMA_VERSION &&
    snapshot.binding.role === 'direct-final' ? snapshot.results[0]?.userResponse : null;
  return { schemaVersion: snapshot.schemaVersion, kind: snapshot.kind,
    facts: snapshot.facts, results: snapshot.results,
    userResponse: response === 'unavailable' ? retainedResponse ?? { state: 'unavailable', reason: {
      code: 'RUNTIME_WORDING_UNAVAILABLE', detail: 'No owner-authored usable message is retained.' } } : response,
    binding: snapshot.binding, completion: { outcome, gaps: snapshot.gaps } };
}
function assertEvidence(record, snapshot) {
  if (record.schemaVersion !== snapshot.schemaVersion) fail('completion_version_or_kind');
  if (!isDeepStrictEqual(boundedCopy(record.binding), boundedCopy(snapshot.binding)) ||
      record.kind !== snapshot.kind) fail('completion_native_binding_mismatch');
  const sameResults = componentCompletion(record.schemaVersion) ?
    isDeepStrictEqual(record.results, snapshot.results) :
    isDeepStrictEqual(boundedCopy(record.results), boundedCopy(snapshot.results));
  if (!isDeepStrictEqual(boundedCopy(record.facts), boundedCopy(snapshot.facts)) ||
      !sameResults) fail('completion_evidence_mismatch');
  if (!isDeepStrictEqual(boundedCopy(record.completion.gaps), boundedCopy(snapshot.gaps)) ||
      record.completion.outcome !== snapshot.outcome) fail('completion_evidence_insufficient');
  if (snapshot.outcome !== 'NORMAL' && !isDeepStrictEqual(boundedCopy(record.userResponse),
      boundedCopy(recordFromSnapshot(snapshot, 'unavailable', snapshot.outcome).userResponse))) {
    fail('completion_runtime_response_mismatch');
  }
}
export function validateCompletion(raw, nativeAuthority) {
  const snapshot = authoritySnapshot(nativeAuthority);
  const record = completionShape(raw);
  assertEvidence(record, snapshot);
  return record;
}
export function acceptAgentCompletion(proposal, nativeAuthority) {
  const snapshot = authoritySnapshot(nativeAuthority);
  exact(proposal, ['schemaVersion', 'kind', 'facts', 'userResponse'], 'agent_completion_shape');
  if (proposal.schemaVersion !== snapshot.schemaVersion || proposal.kind !== snapshot.kind) fail('completion_version_or_kind');
  if (snapshot.outcome !== 'NORMAL') fail('completion_origin_mismatch');
  if (!isDeepStrictEqual(boundedCopy(proposal.facts), boundedCopy(snapshot.facts))) fail('completion_evidence_mismatch');
  return validateCompletion(recordFromSnapshot(snapshot, userResponse(proposal.userResponse), 'NORMAL'), nativeAuthority);
}

// Called only by native terminal handling after exhaustion or inability to
// continue. No callbacks, I/O, tools, replay, model calls or route selection.
export function reconstructCompletion(nativeAuthority) {
  const snapshot = authoritySnapshot(nativeAuthority);
  if (snapshot.outcome === 'NORMAL') fail('completion_origin_mismatch');
  return validateCompletion(recordFromSnapshot(snapshot, 'unavailable', snapshot.outcome), nativeAuthority);
}

// P06 may pass this supplementary JSON Schema to a proven constrained-output
// surface. Unsupported/ignored constraints never replace validateCompletion.
export function completionProposalSchema(nativeAuthority) {
  const snapshot = authoritySnapshot(nativeAuthority);
  if (snapshot.outcome !== 'NORMAL') fail('completion_origin_mismatch');
  const object = (properties) => ({ type: 'object', additionalProperties: false,
    required: Object.keys(properties), properties });
  return freeze({ $schema: 'https://json-schema.org/draft/2020-12/schema',
    ...object({ schemaVersion: { const: snapshot.schemaVersion }, kind: { const: snapshot.kind },
      facts: { const: boundedCopy(snapshot.facts) }, userResponse: { oneOf: [
        object({ state: { const: 'usable' }, text: { type: 'string', minLength: 1,
          maxLength: MAX_RENDERED_TEXT, pattern: '\\S' }, language: { enum: ['en', 'he'] } }),
        object({ state: { const: 'unavailable' }, reason: object({ code: { type: 'string',
          pattern: '^[A-Z][A-Z0-9_]{0,63}$' }, detail: { type: 'string', minLength: 1,
          maxLength: 512, pattern: '^[^\\u0000-\\u001f\\u007f]+$' } }) }),
      ] } }),
  });
}

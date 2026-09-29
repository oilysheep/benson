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
  if (Array.isArray(value) && value.length <= 256) return value.map((item) => jsonCopy(item, depth + 1));
  if (isPlainObject(value) && Object.keys(value).length <= 256) {
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

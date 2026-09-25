import { validateClassificationOutcome } from "./classification.mjs";
import { ROUTING_REASONS } from "./policy.mjs";

const EVENT_INPUT_KEYS = new Set([
  "requestId",
  "sessionId",
  "runId",
  "classifierAttempted",
  "classifierLatencyMs",
  "classification",
  "decision",
]);

const DECISION_KEYS = new Set([
  "route",
  "eligible",
  "reason",
  "classificationKind",
  "classificationReason",
  "classifiedCandidate",
  "classificationDiagnostic",
  "policyVersion",
]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKnownKeys(value, known) {
  return Object.keys(value).every((key) => known.has(key));
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function optionalIdentifier(value, field) {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${field}_invalid`);
  }

  return value;
}

function freezeEvent(event) {
  Object.freeze(event.ownerIds);
  Object.freeze(event.classifier);
  Object.freeze(event.policy);
  return Object.freeze(event);
}

export function createRoutingTelemetryEvent(input) {
  if (!isPlainObject(input) || !hasOnlyKnownKeys(input, EVENT_INPUT_KEYS)) {
    throw new TypeError("telemetry_input_shape");
  }

  if (typeof input.classifierAttempted !== "boolean") {
    throw new TypeError("classifier_attempted_not_boolean");
  }

  if (
    input.classifierLatencyMs !== null &&
    input.classifierLatencyMs !== undefined &&
    (!Number.isFinite(input.classifierLatencyMs) || input.classifierLatencyMs < 0)
  ) {
    throw new TypeError("classifier_latency_invalid");
  }

  const validated = validateClassificationOutcome(input.classification);
  const outcome = validated.outcome;

  if (!isPlainObject(input.decision) || !hasExactKeys(input.decision, DECISION_KEYS)) {
    throw new TypeError("decision_shape");
  }

  if (
    !["main", "jessica", "reminder"].includes(input.decision.route) ||
    typeof input.decision.eligible !== "boolean" ||
    !ROUTING_REASONS.includes(input.decision.reason)
  ) {
    throw new TypeError("decision_invalid");
  }

  const classifier = {
    attempted: input.classifierAttempted,
    latencyMs: input.classifierLatencyMs ?? null,
    outcome: outcome.kind,
    validationDiagnostic: validated.diagnostic,
    unavailableReason: outcome.kind === "unavailable" ? outcome.reason : null,
    provider: outcome.kind === "classified" ? outcome.provider : null,
    model: outcome.kind === "classified" ? outcome.model : null,
    rubricVersion: outcome.kind === "classified" ? outcome.rubricVersion : null,
    candidate: outcome.kind === "classified" ? outcome.candidate : null,
    routeConfidence:
      outcome.kind === "classified" ? outcome.routeConfidence.value : null,
    selfContainedProbability:
      outcome.kind === "classified"
        ? outcome.selfContainedProbability.value
        : null,
  };

  const policy = {
    route: input.decision.route,
    eligible: input.decision.eligible,
    reason: input.decision.reason,
    policyVersion: input.decision.policyVersion ?? null,
  };

  return freezeEvent({
    event: "benson.routing.decision",
    schemaVersion: 1,
    ownerIds: {
      requestId: optionalIdentifier(input.requestId, "request_id"),
      sessionId: optionalIdentifier(input.sessionId, "session_id"),
      runId: optionalIdentifier(input.runId, "run_id"),
    },
    classifier,
    policy,
  });
}

const CLASSIFIED_KEYS = new Set([
  "kind",
  "candidate",
  "routeConfidence",
  "selfContainedProbability",
  "contextRequired",
  "ambiguous",
  "continuationRequired",
  "unsupportedInput",
  "provider",
  "model",
  "rubricVersion",
]);

const UNAVAILABLE_KEYS = new Set(["kind", "reason"]);
const CLASSIFIER_INPUT_KEYS = new Set(["currentMessage", "rubric"]);
const RUBRIC_KEYS = new Set([
  "kind",
  "version",
  "review",
  "routingAlternatives",
  "uncertaintyDisposition",
  "contextCriteria",
  "boundaryCases",
  "dataBoundary",
]);
const RUBRIC_REVIEW_KEYS = new Set(["status", "reviewedBy", "reviewedAt"]);

export const CLASSIFICATION_CANDIDATES = Object.freeze([
  "jessica",
  "reminder",
  "main",
]);

export const UNAVAILABLE_REASONS = Object.freeze([
  "disabled",
  "not_configured",
  "missing_credential",
  "authentication_failed",
  "timeout",
  "unreachable",
  "rate_limited",
  "provider_error",
  "invalid_schema",
  "unsupported_result",
  "unsupported_input",
]);

export const SUPPORTED_SCORE_MEANINGS = Object.freeze(["probability_0_1"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function cloneAndFreezeJson(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreezeJson));
  }

  if (isPlainObject(value)) {
    const clone = {};
    for (const [key, child] of Object.entries(value)) {
      clone[key] = cloneAndFreezeJson(child);
    }
    return Object.freeze(clone);
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  throw new TypeError("rubric_not_plain_json");
}

function requirePlainSemanticSection(rubric, field) {
  if (!isPlainObject(rubric[field]) || Object.keys(rubric[field]).length === 0) {
    throw new TypeError(`rubric_${field}_invalid`);
  }
}

export function projectClassificationInput(input) {
  if (!isPlainObject(input) || !hasExactKeys(input, CLASSIFIER_INPUT_KEYS)) {
    throw new TypeError("classification_input_shape");
  }

  if (typeof input.currentMessage !== "string") {
    throw new TypeError("current_message_must_be_string");
  }

  const rubric = input.rubric;
  if (!isPlainObject(rubric) || !hasExactKeys(rubric, RUBRIC_KEYS)) {
    throw new TypeError("rubric_shape");
  }

  if (
    rubric.kind !== "benson.routing.semantic-rubric" ||
    !isBoundedIdentifier(rubric.version)
  ) {
    throw new TypeError("rubric_identity");
  }

  if (
    !isPlainObject(rubric.review) ||
    !hasExactKeys(rubric.review, RUBRIC_REVIEW_KEYS) ||
    rubric.review.status !== "reviewed" ||
    !isBoundedIdentifier(rubric.review.reviewedBy) ||
    typeof rubric.review.reviewedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(rubric.review.reviewedAt)
  ) {
    throw new TypeError("rubric_not_approved");
  }

  for (const field of [
    "routingAlternatives",
    "uncertaintyDisposition",
    "contextCriteria",
    "boundaryCases",
    "dataBoundary",
  ]) {
    requirePlainSemanticSection(rubric, field);
  }

  return cloneAndFreezeJson({
    kind: "benson.routing.classifier-input",
    version: 1,
    currentMessage: input.currentMessage,
    rubric: {
      version: rubric.version,
      routingAlternatives: rubric.routingAlternatives,
      uncertaintyDisposition: rubric.uncertaintyDisposition,
      contextCriteria: rubric.contextCriteria,
      boundaryCases: rubric.boundaryCases,
    },
  });
}

function isBoundedIdentifier(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u.test(value)
  );
}

function validateScore(score, field) {
  if (!isPlainObject(score)) {
    return `${field}_not_object`;
  }

  if (!hasExactKeys(score, new Set(["value", "meaning"]))) {
    return `${field}_shape`;
  }

  if (!Number.isFinite(score.value)) {
    return `${field}_not_finite`;
  }

  if (score.value < 0 || score.value > 1) {
    return `${field}_out_of_range`;
  }

  if (!SUPPORTED_SCORE_MEANINGS.includes(score.meaning)) {
    return `${field}_unsupported_meaning`;
  }

  return null;
}

function freezeOutcome(outcome) {
  if (outcome.kind === "classified") {
    Object.freeze(outcome.routeConfidence);
    Object.freeze(outcome.selfContainedProbability);
  }

  return Object.freeze(outcome);
}

export function unavailableClassification(reason = "not_configured") {
  if (!UNAVAILABLE_REASONS.includes(reason)) {
    throw new TypeError("unsupported_unavailable_reason");
  }

  return freezeOutcome({ kind: "unavailable", reason });
}

function invalid(diagnostic) {
  return Object.freeze({
    valid: false,
    diagnostic,
    outcome: unavailableClassification("invalid_schema"),
  });
}

export function validateClassificationOutcome(value) {
  if (!isPlainObject(value)) {
    return invalid("outcome_not_object");
  }

  if (value.kind === "unavailable") {
    if (!hasExactKeys(value, UNAVAILABLE_KEYS)) {
      return invalid("unavailable_shape");
    }

    if (!UNAVAILABLE_REASONS.includes(value.reason)) {
      return invalid("unavailable_reason");
    }

    return Object.freeze({
      valid: true,
      diagnostic: null,
      outcome: unavailableClassification(value.reason),
    });
  }

  if (value.kind !== "classified") {
    return invalid("outcome_kind");
  }

  if (!hasExactKeys(value, CLASSIFIED_KEYS)) {
    return invalid("classified_shape");
  }

  if (!CLASSIFICATION_CANDIDATES.includes(value.candidate)) {
    return invalid("candidate");
  }

  const routeScoreError = validateScore(value.routeConfidence, "route_confidence");
  if (routeScoreError !== null) {
    return invalid(routeScoreError);
  }

  const selfContainedScoreError = validateScore(
    value.selfContainedProbability,
    "self_contained_probability",
  );
  if (selfContainedScoreError !== null) {
    return invalid(selfContainedScoreError);
  }

  for (const field of [
    "contextRequired",
    "ambiguous",
    "continuationRequired",
    "unsupportedInput",
  ]) {
    if (typeof value[field] !== "boolean") {
      return invalid(`${field}_not_boolean`);
    }
  }

  for (const field of ["provider", "model", "rubricVersion"]) {
    if (!isBoundedIdentifier(value[field])) {
      return invalid(`${field}_invalid`);
    }
  }

  const outcome = freezeOutcome({
    kind: "classified",
    candidate: value.candidate,
    routeConfidence: { ...value.routeConfidence },
    selfContainedProbability: { ...value.selfContainedProbability },
    contextRequired: value.contextRequired,
    ambiguous: value.ambiguous,
    continuationRequired: value.continuationRequired,
    unsupportedInput: value.unsupportedInput,
    provider: value.provider,
    model: value.model,
    rubricVersion: value.rubricVersion,
  });

  return Object.freeze({ valid: true, diagnostic: null, outcome });
}

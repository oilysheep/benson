import { validateClassificationOutcome } from "./classification.mjs";

export const ROUTING_REASONS = Object.freeze([
  "invalid_classification",
  "classifier_unavailable",
  "classified_main",
  "invalid_policy_config",
  "policy_off",
  "shadow_mode",
  "policy_version_unapproved",
  "provider_unapproved",
  "model_unapproved",
  "rubric_unapproved",
  "thresholds_unset",
  "unsupported_input",
  "context_required",
  "ambiguous",
  "continuation_required",
  "unknown_evidence",
  "low_route_confidence",
  "low_self_contained_probability",
  "domain_disabled",
  "lifecycle_unavailable",
  "eligible",
]);

const POLICY_KEYS = new Set([
  "mode",
  "policyVersion",
  "approvedPolicyVersions",
  "approvedProviders",
  "approvedModels",
  "approvedRubricVersions",
  "thresholds",
  "domains",
  "lifecycle",
]);

const DOMAIN_KEYS = new Set(["jessica", "reminder"]);
const LIFECYCLE_KEYS = new Set([
  "trustedContext",
  "isolatedDelegation",
  "exclusiveExecution",
  "completionIntegrity",
]);
const THRESHOLD_KEYS = new Set([
  "routeConfidence",
  "selfContainedProbability",
]);

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

function isBoundedIdentifier(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u.test(value)
  );
}

function validateIdentifierList(value, field) {
  if (!Array.isArray(value)) {
    return `${field}_not_array`;
  }

  if (!value.every(isBoundedIdentifier)) {
    return `${field}_invalid_entry`;
  }

  if (new Set(value).size !== value.length) {
    return `${field}_duplicate`;
  }

  return null;
}

function freezeConfig(config) {
  Object.freeze(config.approvedPolicyVersions);
  Object.freeze(config.approvedProviders);
  Object.freeze(config.approvedModels);
  Object.freeze(config.approvedRubricVersions);
  if (config.thresholds !== null) {
    Object.freeze(config.thresholds);
  }
  Object.freeze(config.domains);
  Object.freeze(config.lifecycle);
  return Object.freeze(config);
}

export const DEFAULT_ROUTING_POLICY = freezeConfig({
  mode: "off",
  policyVersion: "unconfigured",
  approvedPolicyVersions: [],
  approvedProviders: [],
  approvedModels: [],
  approvedRubricVersions: [],
  thresholds: null,
  domains: { jessica: false, reminder: false },
  lifecycle: {
    trustedContext: false,
    isolatedDelegation: false,
    exclusiveExecution: false,
    completionIntegrity: false,
  },
});

function invalidConfig(diagnostic) {
  return Object.freeze({ valid: false, diagnostic, config: null });
}

export function validateRoutingPolicyConfig(value) {
  if (!isPlainObject(value)) {
    return invalidConfig("policy_not_object");
  }

  if (!hasExactKeys(value, POLICY_KEYS)) {
    return invalidConfig("policy_shape");
  }

  if (!["off", "shadow", "enabled"].includes(value.mode)) {
    return invalidConfig("policy_mode");
  }

  if (!isBoundedIdentifier(value.policyVersion)) {
    return invalidConfig("policy_version");
  }

  for (const field of [
    "approvedPolicyVersions",
    "approvedProviders",
    "approvedModels",
    "approvedRubricVersions",
  ]) {
    const listError = validateIdentifierList(value[field], field);
    if (listError !== null) {
      return invalidConfig(listError);
    }
  }

  if (value.thresholds !== null) {
    if (!isPlainObject(value.thresholds) || !hasExactKeys(value.thresholds, THRESHOLD_KEYS)) {
      return invalidConfig("thresholds_shape");
    }

    for (const field of THRESHOLD_KEYS) {
      const threshold = value.thresholds[field];
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
        const diagnosticField =
          field === "routeConfidence"
            ? "route_confidence"
            : "self_contained_probability";
        return invalidConfig(`${diagnosticField}_threshold`);
      }
    }
  }

  if (!isPlainObject(value.domains) || !hasExactKeys(value.domains, DOMAIN_KEYS)) {
    return invalidConfig("domains_shape");
  }

  for (const domain of DOMAIN_KEYS) {
    if (typeof value.domains[domain] !== "boolean") {
      return invalidConfig(`${domain}_enabled`);
    }
  }

  if (
    !isPlainObject(value.lifecycle) ||
    !hasExactKeys(value.lifecycle, LIFECYCLE_KEYS)
  ) {
    return invalidConfig("lifecycle_shape");
  }

  for (const prerequisite of LIFECYCLE_KEYS) {
    if (typeof value.lifecycle[prerequisite] !== "boolean") {
      return invalidConfig(`${prerequisite}_lifecycle`);
    }
  }

  const config = freezeConfig({
    mode: value.mode,
    policyVersion: value.policyVersion,
    approvedPolicyVersions: [...value.approvedPolicyVersions],
    approvedProviders: [...value.approvedProviders],
    approvedModels: [...value.approvedModels],
    approvedRubricVersions: [...value.approvedRubricVersions],
    thresholds: value.thresholds === null ? null : { ...value.thresholds },
    domains: { ...value.domains },
    lifecycle: { ...value.lifecycle },
  });

  return Object.freeze({ valid: true, diagnostic: null, config });
}

function decision({
  route = "main",
  eligible = false,
  reason,
  classificationKind,
  classificationReason = null,
  classifiedCandidate = null,
  classificationDiagnostic = null,
  policyVersion = null,
}) {
  if (!ROUTING_REASONS.includes(reason)) {
    throw new TypeError("unsupported_routing_reason");
  }

  return Object.freeze({
    route,
    eligible,
    reason,
    classificationKind,
    classificationReason,
    classifiedCandidate,
    classificationDiagnostic,
    policyVersion,
  });
}

export function evaluateRouting(
  classification,
  policy = DEFAULT_ROUTING_POLICY,
) {
  const validatedClassification = validateClassificationOutcome(classification);
  const outcome = validatedClassification.outcome;
  const validatedPolicy = validateRoutingPolicyConfig(policy);
  const base = {
    classificationKind: outcome.kind,
    classificationReason:
      outcome.kind === "unavailable" ? outcome.reason : null,
    classifiedCandidate:
      outcome.kind === "classified" ? outcome.candidate : null,
    classificationDiagnostic: validatedClassification.diagnostic,
    policyVersion: validatedPolicy.valid
      ? validatedPolicy.config.policyVersion
      : null,
  };

  if (!validatedClassification.valid) {
    return decision({ ...base, reason: "invalid_classification" });
  }

  if (outcome.kind === "unavailable") {
    return decision({ ...base, reason: "classifier_unavailable" });
  }

  if (outcome.candidate === "main") {
    return decision({ ...base, reason: "classified_main" });
  }

  if (!validatedPolicy.valid) {
    return decision({ ...base, reason: "invalid_policy_config" });
  }

  const config = validatedPolicy.config;

  if (config.mode === "off") {
    return decision({ ...base, reason: "policy_off" });
  }

  if (config.mode === "shadow") {
    return decision({ ...base, reason: "shadow_mode" });
  }

  if (!config.approvedPolicyVersions.includes(config.policyVersion)) {
    return decision({ ...base, reason: "policy_version_unapproved" });
  }

  if (!config.approvedProviders.includes(outcome.provider)) {
    return decision({ ...base, reason: "provider_unapproved" });
  }

  if (!config.approvedModels.includes(outcome.model)) {
    return decision({ ...base, reason: "model_unapproved" });
  }

  if (!config.approvedRubricVersions.includes(outcome.rubricVersion)) {
    return decision({ ...base, reason: "rubric_unapproved" });
  }

  if (config.thresholds === null) {
    return decision({ ...base, reason: "thresholds_unset" });
  }

  if (outcome.unsupportedInput) {
    return decision({ ...base, reason: "unsupported_input" });
  }

  if (outcome.contextRequired) {
    return decision({ ...base, reason: "context_required" });
  }

  if (outcome.ambiguous) {
    return decision({ ...base, reason: "ambiguous" });
  }

  if (outcome.continuationRequired) {
    return decision({ ...base, reason: "continuation_required" });
  }

  if (["unsupportedInput", "contextRequired", "ambiguous", "continuationRequired"].some(
    (field) => outcome[field] === null,
  ) || outcome.routeConfidence === null || outcome.selfContainedProbability === null) {
    return decision({ ...base, reason: "unknown_evidence" });
  }

  if (outcome.routeConfidence.value < config.thresholds.routeConfidence) {
    return decision({ ...base, reason: "low_route_confidence" });
  }

  if (
    outcome.selfContainedProbability.value <
    config.thresholds.selfContainedProbability
  ) {
    return decision({ ...base, reason: "low_self_contained_probability" });
  }

  if (!config.domains[outcome.candidate]) {
    return decision({ ...base, reason: "domain_disabled" });
  }

  if (Object.values(config.lifecycle).some((available) => !available)) {
    return decision({ ...base, reason: "lifecycle_unavailable" });
  }

  return decision({
    ...base,
    route: outcome.candidate,
    eligible: true,
    reason: "eligible",
  });
}

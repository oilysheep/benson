import {
  CLASSIFICATION_CANDIDATES,
  validateClassificationOutcome,
} from "./classification.mjs";
import { evaluateRouting, validateRoutingPolicyConfig } from "./policy.mjs";

const CORPUS_KEYS = new Set([
  "kind",
  "version",
  "rubricVersion",
  "review",
  "cases",
]);
const REVIEW_KEYS = new Set(["status", "reviewedBy", "reviewedAt"]);
const CASE_KEYS = new Set([
  "id",
  "groupId",
  "split",
  "language",
  "category",
  "currentMessage",
  "history",
  "adjudicationRationale",
  "expected",
  "provenance",
  "evaluationOnly",
]);
const EXPECTED_KEYS = new Set([
  "candidate",
  "contextLabel",
  "authorization",
  "deployedCapability",
]);
const PROVENANCE_KEYS = new Set(["source", "author", "reviewStatus"]);
const EVALUATION_ONLY_KEYS = new Set(["contextualOwner"]);
const HISTORY_KEYS = new Set(["role", "text"]);
const OBSERVATION_KEYS = new Set([
  "caseId",
  "outcome",
  "latencyMs",
  "costUsd",
  "inputTokens",
  "outputTokens",
  "mainCalls",
]);

const SPLITS = Object.freeze(["tuning", "held_out"]);
const LANGUAGES = Object.freeze(["en", "he"]);
const CONTEXT_LABELS = Object.freeze([
  "self_contained",
  "context_required",
  "ambiguous",
  "continuation_required",
  "unsupported_input",
]);
const AUTHORIZATION_LABELS = Object.freeze([
  "authorized",
  "unauthorized",
  "unknown",
  "not_applicable",
]);
const CAPABILITY_LABELS = Object.freeze([
  "supported",
  "unsupported",
  "not_evaluated",
]);
const CATEGORIES = Object.freeze([
  "domain_self_contained",
  "general_reasoning",
  "mixed_domain",
  "ambiguous",
  "quoted_instruction",
  "implicit_reference",
  "clarification_followup",
  "authorization_separation",
  "capability_separation",
  "unsupported_input",
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

function isIdentifier(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  );
}

function isNonEmptyText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096;
}

function add(diagnostics, condition, code) {
  if (!condition) {
    diagnostics.push(code);
  }
}

function validateReview(review, diagnostics, prefix) {
  if (!isPlainObject(review) || !hasExactKeys(review, REVIEW_KEYS)) {
    diagnostics.push(`${prefix}_shape`);
    return false;
  }

  if (!["pending_operator_review", "reviewed"].includes(review.status)) {
    diagnostics.push(`${prefix}_status`);
    return false;
  }

  if (review.status === "reviewed") {
    add(diagnostics, isIdentifier(review.reviewedBy), `${prefix}_reviewer`);
    add(
      diagnostics,
      typeof review.reviewedAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(review.reviewedAt),
      `${prefix}_reviewed_at`,
    );
  } else {
    add(diagnostics, review.reviewedBy === null, `${prefix}_pending_reviewer`);
    add(diagnostics, review.reviewedAt === null, `${prefix}_pending_reviewed_at`);
  }

  return true;
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function validateEvaluationCorpus(corpus, rubric) {
  const diagnostics = [];

  if (!isPlainObject(corpus) || !hasExactKeys(corpus, CORPUS_KEYS)) {
    return Object.freeze({
      valid: false,
      readyForAcceptance: false,
      diagnostics: Object.freeze(["corpus_shape"]),
      summary: null,
    });
  }

  add(
    diagnostics,
    corpus.kind === "benson.routing.classification-corpus",
    "corpus_kind",
  );
  add(diagnostics, isIdentifier(corpus.version), "corpus_version");
  add(diagnostics, isIdentifier(corpus.rubricVersion), "corpus_rubric_version");
  const reviewShapeValid = validateReview(corpus.review, diagnostics, "corpus_review");

  add(
    diagnostics,
    isPlainObject(rubric) &&
      rubric.kind === "benson.routing.semantic-rubric" &&
      rubric.version === corpus.rubricVersion,
    "rubric_mismatch",
  );
  const rubricReviewShapeValid = validateReview(
    rubric?.review,
    diagnostics,
    "rubric_review",
  );

  const cases = Array.isArray(corpus.cases) ? corpus.cases : [];
  if (cases.length === 0) {
    diagnostics.push("cases_missing");
  }

  const ids = new Set();
  const groupSplits = new Map();
  const splitCounts = { tuning: 0, held_out: 0 };
  const languages = [];
  const categories = [];
  let reviewedCaseCount = 0;
  let contextPairedCaseCount = 0;

  for (const [index, item] of cases.entries()) {
    const prefix = `case_${index}`;
    if (!isPlainObject(item) || !hasExactKeys(item, CASE_KEYS)) {
      diagnostics.push(`${prefix}_shape`);
      continue;
    }

    add(diagnostics, isIdentifier(item.id), `${prefix}_id`);
    add(diagnostics, isIdentifier(item.groupId), `${prefix}_group_id`);
    add(diagnostics, !ids.has(item.id), `${prefix}_duplicate_id`);
    ids.add(item.id);

    add(diagnostics, SPLITS.includes(item.split), `${prefix}_split`);
    if (SPLITS.includes(item.split)) {
      splitCounts[item.split] += 1;
      const existingSplit = groupSplits.get(item.groupId);
      if (existingSplit !== undefined && existingSplit !== item.split) {
        diagnostics.push(`${prefix}_group_split_leakage`);
      } else {
        groupSplits.set(item.groupId, item.split);
      }
    }

    add(diagnostics, LANGUAGES.includes(item.language), `${prefix}_language`);
    add(diagnostics, CATEGORIES.includes(item.category), `${prefix}_category`);
    if (LANGUAGES.includes(item.language)) languages.push(item.language);
    if (CATEGORIES.includes(item.category)) categories.push(item.category);
    add(diagnostics, typeof item.currentMessage === "string", `${prefix}_message`);
    add(
      diagnostics,
      isNonEmptyText(item.adjudicationRationale),
      `${prefix}_rationale`,
    );

    if (!Array.isArray(item.history)) {
      diagnostics.push(`${prefix}_history`);
    } else {
      if (item.history.length > 0) contextPairedCaseCount += 1;
      for (const [historyIndex, turn] of item.history.entries()) {
        add(
          diagnostics,
          isPlainObject(turn) &&
            hasExactKeys(turn, HISTORY_KEYS) &&
            ["user", "assistant"].includes(turn.role) &&
            isNonEmptyText(turn.text),
          `${prefix}_history_${historyIndex}`,
        );
      }
    }

    if (!isPlainObject(item.expected) || !hasExactKeys(item.expected, EXPECTED_KEYS)) {
      diagnostics.push(`${prefix}_expected_shape`);
    } else {
      add(
        diagnostics,
        CLASSIFICATION_CANDIDATES.includes(item.expected.candidate),
        `${prefix}_candidate`,
      );
      add(
        diagnostics,
        CONTEXT_LABELS.includes(item.expected.contextLabel),
        `${prefix}_context_label`,
      );
      add(
        diagnostics,
        AUTHORIZATION_LABELS.includes(item.expected.authorization),
        `${prefix}_authorization`,
      );
      add(
        diagnostics,
        CAPABILITY_LABELS.includes(item.expected.deployedCapability),
        `${prefix}_capability`,
      );
      if (item.expected.contextLabel !== "self_contained") {
        add(
          diagnostics,
          item.expected.candidate === "main",
          `${prefix}_uncertain_forced_domain`,
        );
      }
    }

    if (
      !isPlainObject(item.provenance) ||
      !hasExactKeys(item.provenance, PROVENANCE_KEYS)
    ) {
      diagnostics.push(`${prefix}_provenance_shape`);
    } else {
      add(
        diagnostics,
        item.provenance.source === "synthetic",
        `${prefix}_provenance_source`,
      );
      add(
        diagnostics,
        isIdentifier(item.provenance.author),
        `${prefix}_provenance_author`,
      );
      add(
        diagnostics,
        ["pending_operator_review", "reviewed"].includes(
          item.provenance.reviewStatus,
        ),
        `${prefix}_review_status`,
      );
      if (item.provenance.reviewStatus === "reviewed") reviewedCaseCount += 1;
    }

    if (
      !isPlainObject(item.evaluationOnly) ||
      !hasExactKeys(item.evaluationOnly, EVALUATION_ONLY_KEYS)
    ) {
      diagnostics.push(`${prefix}_evaluation_only_shape`);
    } else {
      add(
        diagnostics,
        item.evaluationOnly.contextualOwner === null ||
          CLASSIFICATION_CANDIDATES.includes(item.evaluationOnly.contextualOwner),
        `${prefix}_contextual_owner`,
      );
    }
  }

  add(diagnostics, splitCounts.tuning > 0, "tuning_split_empty");
  add(diagnostics, splitCounts.held_out > 0, "held_out_split_empty");
  add(diagnostics, contextPairedCaseCount > 0, "context_pairs_missing");

  const humanReviewed =
    reviewShapeValid &&
    rubricReviewShapeValid &&
    corpus.review.status === "reviewed" &&
    rubric.review.status === "reviewed" &&
    reviewedCaseCount === cases.length;

  const summary = Object.freeze({
    caseCount: cases.length,
    splitCounts: Object.freeze({ ...splitCounts }),
    languageCounts: Object.freeze(countBy(languages)),
    categoryCounts: Object.freeze(countBy(categories)),
    contextPairedCaseCount,
    reviewedCaseCount,
    reviewStatus: humanReviewed ? "reviewed" : "pending_operator_review",
  });

  return Object.freeze({
    valid: diagnostics.length === 0,
    readyForAcceptance: diagnostics.length === 0 && humanReviewed,
    diagnostics: Object.freeze(diagnostics),
    summary,
  });
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function nearestRank(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1];
}

function operationalSummary(observations, field, mode) {
  const values = observations
    .map((observation) => observation[field])
    .filter((value) => value !== null);
  const totalCount = observations.length;
  const observedCount = values.length;
  const availability =
    observedCount === 0
      ? "unavailable"
      : observedCount === totalCount
        ? "complete"
        : "partial";
  const complete = availability === "complete" && totalCount > 0;

  return Object.freeze({
    availability,
    observedCount,
    missingCount: totalCount - observedCount,
    total: complete && mode === "total" ? values.reduce((sum, value) => sum + value, 0) : null,
    p50: complete && mode === "percentile" ? nearestRank(values, 0.5) : null,
    p95: complete && mode === "percentile" ? nearestRank(values, 0.95) : null,
  });
}

function emptyConfusion() {
  const matrix = {};
  for (const expected of CLASSIFICATION_CANDIDATES) {
    matrix[expected] = { jessica: 0, reminder: 0, main: 0, abstain: 0 };
  }
  return matrix;
}

function baseMetrics(records) {
  const confusion = emptyConfusion();
  let correct = 0;
  let classified = 0;
  let acceptedFastPaths = 0;
  let falseFastPaths = 0;

  for (const record of records) {
    confusion[record.expectedCandidate][record.prediction] += 1;
    if (record.prediction !== "abstain") classified += 1;
    if (record.prediction === record.expectedCandidate) correct += 1;
    if (record.decision.eligible) {
      acceptedFastPaths += 1;
      if (
        record.decision.route !== record.expectedCandidate ||
        record.expectedContextLabel !== "self_contained"
      ) {
        falseFastPaths += 1;
      }
    }
  }

  const total = records.length;
  return Object.freeze({
    total,
    classified,
    unavailable: total - classified,
    accuracy: Object.freeze({
      correct,
      denominator: total,
      value: ratio(correct, total),
    }),
    coverage: Object.freeze({
      classified,
      denominator: total,
      value: ratio(classified, total),
    }),
    abstention: Object.freeze({
      unavailable: total - classified,
      denominator: total,
      value: ratio(total - classified, total),
    }),
    falseFastPathRateAmongAccepted: Object.freeze({
      falseFastPaths,
      denominator: acceptedFastPaths,
      value: ratio(falseFastPaths, acceptedFastPaths),
    }),
    falseFastPathRateOverall: Object.freeze({
      falseFastPaths,
      denominator: total,
      value: ratio(falseFastPaths, total),
    }),
    confusion: Object.freeze(
      Object.fromEntries(
        Object.entries(confusion).map(([key, value]) => [key, Object.freeze(value)]),
      ),
    ),
  });
}

function sliced(records, field) {
  const values = [...new Set(records.map((record) => record[field]))].sort();
  return Object.freeze(
    Object.fromEntries(
      values.map((value) => [
        value,
        baseMetrics(records.filter((record) => record[field] === value)),
      ]),
    ),
  );
}

function calibration(records, scoreField, target) {
  const scored = records.filter((record) => record.validatedOutcome.kind === "classified");
  const squaredErrors = scored.map((record) => {
    const probability = record.validatedOutcome[scoreField].value;
    const expected = target(record) ? 1 : 0;
    return (probability - expected) ** 2;
  });

  return Object.freeze({
    meaning: "probability_0_1",
    count: squaredErrors.length,
    brierMean:
      squaredErrors.length === 0
        ? null
        : squaredErrors.reduce((sum, value) => sum + value, 0) /
          squaredErrors.length,
  });
}

function validateObservation(observation, caseIds, seen, index) {
  if (!isPlainObject(observation) || !hasExactKeys(observation, OBSERVATION_KEYS)) {
    throw new TypeError(`observation_${index}_shape`);
  }
  if (!caseIds.has(observation.caseId) || seen.has(observation.caseId)) {
    throw new TypeError(`observation_${index}_case_id`);
  }
  seen.add(observation.caseId);

  for (const field of ["latencyMs", "costUsd", "inputTokens", "outputTokens", "mainCalls"]) {
    const value = observation[field];
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new TypeError(`observation_${index}_${field}`);
    }
  }

  for (const field of ["inputTokens", "outputTokens", "mainCalls"]) {
    if (observation[field] !== null && !Number.isInteger(observation[field])) {
      throw new TypeError(`observation_${index}_${field}_integer`);
    }
  }
}

export function evaluateOffline({
  corpus,
  rubric,
  observations,
  policy,
  observationKind,
}) {
  const corpusValidation = validateEvaluationCorpus(corpus, rubric);
  if (!corpusValidation.valid) {
    throw new TypeError(`invalid_corpus:${corpusValidation.diagnostics[0]}`);
  }

  const policyValidation = validateRoutingPolicyConfig(policy);
  if (!policyValidation.valid) {
    throw new TypeError(`invalid_policy:${policyValidation.diagnostic}`);
  }

  if (!Array.isArray(observations) || !["synthetic", "real"].includes(observationKind)) {
    throw new TypeError("evaluation_input");
  }

  const caseIds = new Set(corpus.cases.map((item) => item.id));
  const seen = new Set();
  observations.forEach((observation, index) =>
    validateObservation(observation, caseIds, seen, index),
  );
  if (seen.size !== caseIds.size) {
    throw new TypeError("observation_coverage");
  }

  const observationsById = new Map(
    observations.map((observation) => [observation.caseId, observation]),
  );
  const records = corpus.cases.map((item) => {
    const observation = observationsById.get(item.id);
    const validation = validateClassificationOutcome(observation.outcome);
    const decision = evaluateRouting(observation.outcome, policyValidation.config);
    return Object.freeze({
      caseId: item.id,
      split: item.split,
      language: item.language,
      contextLabel: item.expected.contextLabel,
      expectedCandidate: item.expected.candidate,
      expectedContextLabel: item.expected.contextLabel,
      prediction:
        validation.outcome.kind === "classified"
          ? validation.outcome.candidate
          : "abstain",
      validatedOutcome: validation.outcome,
      decision,
    });
  });

  const metrics = baseMetrics(records);
  const report = {
    kind: "benson.routing.offline-evaluation",
    version: 1,
    observationKind,
    corpusVersion: corpus.version,
    rubricVersion: corpus.rubricVersion,
    humanReviewStatus: corpusValidation.summary.reviewStatus,
    productionThresholdSelected: false,
    metrics,
    slices: {
      language: sliced(records, "language"),
      context: sliced(records, "contextLabel"),
    },
    calibration: {
      routeConfidence: calibration(
        records,
        "routeConfidence",
        (record) => record.prediction === record.expectedCandidate,
      ),
      selfContainedProbability: calibration(
        records,
        "selfContainedProbability",
        (record) => record.expectedContextLabel === "self_contained",
      ),
    },
    operational: {
      latencyMs: operationalSummary(observations, "latencyMs", "percentile"),
      costUsd: operationalSummary(observations, "costUsd", "total"),
      inputTokens: operationalSummary(observations, "inputTokens", "total"),
      outputTokens: operationalSummary(observations, "outputTokens", "total"),
      mainCalls: operationalSummary(observations, "mainCalls", "total"),
    },
  };

  Object.freeze(report.slices);
  Object.freeze(report.calibration);
  Object.freeze(report.operational);
  return Object.freeze(report);
}

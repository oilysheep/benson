import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  evaluateOffline,
  validateEvaluationCorpus,
} from "../evaluation.mjs";
import { unavailableClassification } from "../classification.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROUTING_DIR = resolve(TEST_DIR, "..");
const RUBRIC = JSON.parse(await readFile(resolve(ROUTING_DIR, "rubric.json"), "utf8"));
const CORPUS = JSON.parse(
  await readFile(resolve(TEST_DIR, "fixtures/classification-cases.json"), "utf8"),
);

function classified(candidate, overrides = {}) {
  return {
    kind: "classified",
    candidate,
    routeConfidence: { value: 0.9, meaning: "probability_0_1" },
    selfContainedProbability: { value: 0.9, meaning: "probability_0_1" },
    contextRequired: false,
    ambiguous: false,
    continuationRequired: false,
    unsupportedInput: false,
    provider: "synthetic-offline-provider",
    model: "synthetic-offline-model-v1",
    rubricVersion: "benson-routing-rubric-v1",
    ...overrides,
  };
}

function syntheticPolicy() {
  return {
    mode: "enabled",
    policyVersion: "synthetic-offline-policy-v1",
    approvedPolicyVersions: ["synthetic-offline-policy-v1"],
    approvedProviders: ["synthetic-offline-provider"],
    approvedModels: ["synthetic-offline-model-v1"],
    approvedRubricVersions: ["benson-routing-rubric-v1"],
    thresholds: {
      routeConfidence: 0.75,
      selfContainedProbability: 0.75
    },
    domains: { jessica: true, reminder: true },
    lifecycle: {
      trustedContext: true,
      isolatedDelegation: true,
      exclusiveExecution: true,
      completionIntegrity: true
    }
  };
}

function selectCase(id) {
  const item = CORPUS.cases.find((candidate) => candidate.id === id);
  assert.ok(item, `missing fixture ${id}`);
  return structuredClone(item);
}

function miniCorpus() {
  return {
    ...structuredClone(CORPUS),
    version: "synthetic-hand-calculated-v1",
    cases: [
      selectCase("tune-jessica-clean-en-authorized"),
      selectCase("tune-reminder-create-en"),
      selectCase("held-main-ambiguous-en"),
      selectCase("held-reminder-continuation-en")
    ]
  };
}

function observation(caseId, outcome, overrides = {}) {
  return {
    caseId,
    outcome,
    latencyMs: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    mainCalls: null,
    ...overrides
  };
}

test("canonical corpus is structurally valid, partitioned, synthetic, and human-reviewed", () => {
  const result = validateEvaluationCorpus(CORPUS, RUBRIC);

  assert.equal(result.valid, true);
  assert.equal(result.readyForAcceptance, true);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.summary.caseCount, 26);
  assert.deepEqual(result.summary.splitCounts, { tuning: 13, held_out: 13 });
  assert.deepEqual(result.summary.languageCounts, { en: 16, he: 10 });
  assert.equal(result.summary.contextPairedCaseCount, 4);
  assert.equal(result.summary.reviewedCaseCount, 26);
  assert.equal(result.summary.reviewStatus, "reviewed");
});

test("review metadata is necessary and sufficient only after every label is reviewed", () => {
  const reviewedCorpus = structuredClone(CORPUS);
  const reviewedRubric = structuredClone(RUBRIC);
  const review = {
    status: "reviewed",
    reviewedBy: "synthetic-test-reviewer",
    reviewedAt: "2026-09-23T00:00:00Z"
  };
  reviewedCorpus.review = { ...review };
  reviewedRubric.review = { ...review };
  for (const item of reviewedCorpus.cases) {
    item.provenance.reviewStatus = "reviewed";
  }

  const complete = validateEvaluationCorpus(reviewedCorpus, reviewedRubric);
  assert.equal(complete.valid, true);
  assert.equal(complete.readyForAcceptance, true);
  assert.equal(complete.summary.reviewedCaseCount, reviewedCorpus.cases.length);

  reviewedCorpus.cases[0].provenance.reviewStatus = "pending_operator_review";
  const incomplete = validateEvaluationCorpus(reviewedCorpus, reviewedRubric);
  assert.equal(incomplete.valid, true);
  assert.equal(incomplete.readyForAcceptance, false);
});

test("group leakage and forced domain labels for uncertainty are rejected", () => {
  const leaked = structuredClone(CORPUS);
  leaked.cases.find((item) => item.split === "held_out").groupId =
    leaked.cases.find((item) => item.split === "tuning").groupId;
  const leakageResult = validateEvaluationCorpus(leaked, RUBRIC);
  assert.equal(leakageResult.valid, false);
  assert.equal(
    leakageResult.diagnostics.some((value) => value.endsWith("group_split_leakage")),
    true,
  );

  const forced = structuredClone(CORPUS);
  const ambiguous = forced.cases.find(
    (item) => item.expected.contextLabel === "ambiguous",
  );
  ambiguous.expected.candidate = "jessica";
  const forcedResult = validateEvaluationCorpus(forced, RUBRIC);
  assert.equal(forcedResult.valid, false);
  assert.equal(
    forcedResult.diagnostics.some((value) => value.endsWith("uncertain_forced_domain")),
    true,
  );
});

test("authorization and deployed capability labels remain separate from semantic ownership", () => {
  const cleanCases = CORPUS.cases.filter(
    (item) => item.currentMessage === "Clean Tal's room",
  );
  assert.equal(cleanCases.length, 2);
  assert.deepEqual(
    new Set(cleanCases.map((item) => item.expected.authorization)),
    new Set(["authorized", "unauthorized"]),
  );
  assert.deepEqual(
    new Set(cleanCases.map((item) => item.expected.candidate)),
    new Set(["jessica"]),
  );

  const unsupportedCapability = CORPUS.cases.find(
    (item) => item.expected.deployedCapability === "unsupported",
  );
  assert.equal(unsupportedCapability.expected.candidate, "jessica");
  assert.equal(unsupportedCapability.expected.contextLabel, "self_contained");
});

test("context-paired fixtures keep history evaluation-only and expose changed interpretation", () => {
  const paired = CORPUS.cases.filter(
    (item) => item.currentMessage === "What about his room?",
  );
  assert.equal(paired.length, 2);
  assert.deepEqual(new Set(paired.map((item) => item.split)), new Set(["tuning"]));
  assert.deepEqual(
    new Set(paired.map((item) => item.expected.contextLabel)),
    new Set(["context_required"]),
  );
  assert.deepEqual(
    new Set(paired.map((item) => item.evaluationOnly.contextualOwner)),
    new Set(["jessica", "main"]),
  );
});

test("hand-calculated observations produce explicit accuracy, confusion, false-fast-path, slice, and calibration metrics", () => {
  const corpus = miniCorpus();
  const observations = [
    observation(
      "tune-jessica-clean-en-authorized",
      classified("jessica", {
        routeConfidence: { value: 0.9, meaning: "probability_0_1" },
        selfContainedProbability: { value: 0.8, meaning: "probability_0_1" }
      }),
      { latencyMs: 10, inputTokens: 10, outputTokens: 2, mainCalls: 0 }
    ),
    observation(
      "tune-reminder-create-en",
      unavailableClassification("timeout"),
      { latencyMs: 20, inputTokens: null, outputTokens: 0, mainCalls: 1 }
    ),
    observation(
      "held-main-ambiguous-en",
      classified("jessica", {
        routeConfidence: { value: 0.9, meaning: "probability_0_1" },
        selfContainedProbability: { value: 0.9, meaning: "probability_0_1" }
      }),
      { latencyMs: 30, inputTokens: 10, outputTokens: 2, mainCalls: 0 }
    ),
    observation(
      "held-reminder-continuation-en",
      classified("main", {
        routeConfidence: { value: 0.7, meaning: "probability_0_1" },
        selfContainedProbability: { value: 0.3, meaning: "probability_0_1" },
        contextRequired: true,
        continuationRequired: true
      }),
      { latencyMs: 40, inputTokens: 10, outputTokens: 2, mainCalls: 1 }
    )
  ];

  const report = evaluateOffline({
    corpus,
    rubric: RUBRIC,
    observations,
    policy: syntheticPolicy(),
    observationKind: "synthetic"
  });

  assert.equal(report.observationKind, "synthetic");
  assert.equal(report.humanReviewStatus, "reviewed");
  assert.equal(report.productionThresholdSelected, false);
  assert.deepEqual(report.metrics.accuracy, {
    correct: 2,
    denominator: 4,
    value: 0.5
  });
  assert.deepEqual(report.metrics.coverage, {
    classified: 3,
    denominator: 4,
    value: 0.75
  });
  assert.deepEqual(report.metrics.abstention, {
    unavailable: 1,
    denominator: 4,
    value: 0.25
  });
  assert.deepEqual(report.metrics.falseFastPathRateAmongAccepted, {
    falseFastPaths: 1,
    denominator: 2,
    value: 0.5
  });
  assert.deepEqual(report.metrics.falseFastPathRateOverall, {
    falseFastPaths: 1,
    denominator: 4,
    value: 0.25
  });
  assert.equal(report.metrics.confusion.jessica.jessica, 1);
  assert.equal(report.metrics.confusion.reminder.abstain, 1);
  assert.equal(report.metrics.confusion.main.jessica, 1);
  assert.equal(report.metrics.confusion.main.main, 1);
  assert.equal(report.slices.language.en.total, 4);
  assert.equal(report.slices.context.self_contained.total, 2);
  assert.equal(report.calibration.routeConfidence.count, 3);
  assert.ok(
    Math.abs(report.calibration.routeConfidence.brierMean - 0.30333333333333334) <
      Number.EPSILON,
  );
  assert.ok(
    Math.abs(
      report.calibration.selfContainedProbability.brierMean -
        0.31333333333333335,
    ) < Number.EPSILON,
  );
  assert.notEqual(
    report.calibration.routeConfidence.brierMean,
    report.calibration.selfContainedProbability.brierMean,
  );
  assert.deepEqual(report.operational.latencyMs, {
    availability: "complete",
    observedCount: 4,
    missingCount: 0,
    total: null,
    p50: 20,
    p95: 40
  });
  assert.deepEqual(report.operational.costUsd, {
    availability: "unavailable",
    observedCount: 0,
    missingCount: 4,
    total: null,
    p50: null,
    p95: null
  });
  assert.equal(report.operational.inputTokens.availability, "partial");
  assert.equal(report.operational.inputTokens.total, null);
  assert.equal(report.operational.mainCalls.total, 2);
});

test("zero denominators and missing operational observations remain null, never fabricated zero", () => {
  const corpus = miniCorpus();
  const observations = corpus.cases.map((item) =>
    observation(item.id, unavailableClassification("not_configured")),
  );
  const report = evaluateOffline({
    corpus,
    rubric: RUBRIC,
    observations,
    policy: syntheticPolicy(),
    observationKind: "synthetic"
  });

  assert.deepEqual(report.metrics.falseFastPathRateAmongAccepted, {
    falseFastPaths: 0,
    denominator: 0,
    value: null
  });
  assert.equal(report.metrics.coverage.value, 0);
  assert.equal(report.metrics.abstention.value, 1);
  assert.equal(report.calibration.routeConfidence.count, 0);
  assert.equal(report.calibration.routeConfidence.brierMean, null);
  assert.equal(report.operational.latencyMs.availability, "unavailable");
  assert.equal(report.operational.latencyMs.p50, null);
  assert.equal(report.operational.costUsd.total, null);
  assert.equal(report.operational.mainCalls.total, null);
});

test("evaluation is deterministic, does not mutate inputs, and rejects missing or duplicate observations", () => {
  const corpus = miniCorpus();
  const observations = corpus.cases.map((item) =>
    observation(item.id, classified(item.expected.candidate)),
  );
  const before = structuredClone({ corpus, observations });
  const args = {
    corpus,
    rubric: RUBRIC,
    observations,
    policy: syntheticPolicy(),
    observationKind: "synthetic"
  };

  assert.deepEqual(evaluateOffline(args), evaluateOffline(args));
  assert.deepEqual({ corpus, observations }, before);

  assert.throws(
    () => evaluateOffline({ ...args, observations: observations.slice(1) }),
    /observation_coverage/,
  );
  assert.throws(
    () =>
      evaluateOffline({
        ...args,
        observations: [...observations.slice(0, -1), observations[0]]
      }),
    /observation_.*_case_id/,
  );
});

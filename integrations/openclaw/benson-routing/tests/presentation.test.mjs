import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { renderPresentation } from "../presentation.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROUTING_DIR = resolve(TEST_DIR, "..");
const PROJECT_ROOT = resolve(ROUTING_DIR, "../../..");
const PRESENTATION_PATH = resolve(ROUTING_DIR, "presentation.mjs");
const CORPUS = JSON.parse(
  await readFile(resolve(TEST_DIR, "fixtures/presentation-cases.json"), "utf8"),
);

function expectedUnsupportedReason(item) {
  if (item.expected.disposition === "semantic_rendering_required") {
    return "semantic_rendering_required";
  }
  if (item.expected.disposition === "native_delivery_required") {
    return "native_delivery_required";
  }
  if (item.id === "jessica-unsupported-schema-en") return "unsupported_schema";
  if (item.id === "reminder-unverified-success-en") return "unverified_result";
  throw new Error(`No unsupported reason is defined for ${item.id}`);
}

test("reviewed render candidates produce exact goldens and preserve clarification context", async () => {
  assert.deepEqual(CORPUS.review, {
    status: "reviewed",
    reviewedBy: "Oren",
    reviewedAt: "2026-09-23T06:30:15Z",
  });
  assert.equal(CORPUS.cases.every((item) => item.reviewStatus === "reviewed"), true);

  const { validateResult } = await import(
    pathToFileURL(resolve(PROJECT_ROOT, CORPUS.ownerCatalog.jessicaResultValidator.path)),
  );
  const fixedNow = new Date(CORPUS.fixedClock.now);
  const candidates = CORPUS.cases.filter(
    (item) => item.expected.disposition === "render_candidate",
  );
  assert.equal(candidates.length, 8);

  for (const item of candidates) {
    if (item.domain === "jessica") {
      assert.doesNotThrow(
        () => validateResult(item.result, item.validation.expectedPlan ?? null, fixedNow),
        item.id,
      );
    }
    const before = structuredClone(item.result);
    const first = renderPresentation({ result: item.result, language: item.language });
    const second = renderPresentation({ result: item.result, language: item.language });

    assert.deepEqual(first, second, item.id);
    assert.deepEqual(item.result, before, item.id);
    assert.equal(first.kind, "rendered", item.id);
    assert.equal(first.text, item.expected.exactText, item.id);
    assert.deepEqual(first.pendingContext, item.expected.exactPendingContext ?? null, item.id);
    assert.equal(Object.isFrozen(first), true, item.id);
    if (first.pendingContext !== null) {
      assert.equal(Object.isFrozen(first.pendingContext), true, item.id);
      assert.notEqual(first.pendingContext, item.result.pendingContext, item.id);
    }
  }
});

test("semantic, delivery-dependent, unverified, and unsupported results fail closed", () => {
  const unsupportedCases = CORPUS.cases.filter(
    (item) => item.expected.disposition !== "render_candidate",
  );
  assert.equal(unsupportedCases.length, 7);

  for (const item of unsupportedCases) {
    const before = structuredClone(item.result);
    const output = renderPresentation({ result: item.result, language: item.language });
    assert.deepEqual(item.result, before, item.id);
    assert.deepEqual(output, {
      kind: "unsupported",
      reason: expectedUnsupportedReason(item),
    }, item.id);
    assert.equal(Object.isFrozen(output), true, item.id);
    assert.equal("text" in output, false, item.id);
  }
});

test("unknown inputs and caller trust claims cannot widen the renderer", () => {
  const supported = CORPUS.cases.find((item) => item.id === "jessica-status-read-en");
  const variants = [
    null,
    {},
    { result: supported.result },
    { result: supported.result, language: "fr" },
    { result: supported.result, language: "en", validated: true },
    { result: { ...supported.result, domain: "future-domain" }, language: "en" },
    { result: { ...supported.result, operation: "future-operation" }, language: "en" },
    { result: { ...supported.result, verified: false }, language: "en" },
  ];

  for (const input of variants) {
    const output = renderPresentation(input);
    assert.equal(output.kind, "unsupported");
    assert.equal("text" in output, false);
  }
});

test("renderer has no clock, I/O, model, execution, transport, or delivery surface", async () => {
  const source = await readFile(PRESENTATION_PATH, "utf8");
  const forbidden = [
    /from\s+["']node:/u,
    /process\./u,
    /\bfetch\s*\(/u,
    /\bDate\b/u,
    /\bIntl\b/u,
    /\bset(?:Timeout|Interval|Immediate)\s*\(/u,
    /\bsessions_(?:spawn|yield)\b/u,
    /\bdecisionModel\b/u,
    /\bformat_user_datetime\b/u,
    /\b(?:dispatch|deliver|send|message)\s*\(/u,
    /\b(?:exec|spawn|fork)\s*\(/u,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(source, pattern);

  const guardProgram = String.raw`
    import fs from "node:fs";
    const deny = (name) => () => { throw new Error("side_effect:" + name); };
    globalThis.fetch = deny("fetch");
    globalThis.setTimeout = deny("setTimeout");
    globalThis.setInterval = deny("setInterval");
    globalThis.setImmediate = deny("setImmediate");
    globalThis.sessions_spawn = deny("sessions_spawn");
    globalThis.dispatch = deny("dispatch");
    await import(process.argv[1] + "?presentation-side-effect-guard");
    fs.writeSync(1, "PASS");
  `;
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    guardProgram,
    pathToFileURL(PRESENTATION_PATH).href,
  ], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(child.stdout, "PASS");
});

test("Reminder date goldens remain semantic because canonical formatting is not reusable from pure JS", () => {
  const dateCase = CORPUS.cases.find((item) => item.id === "reminder-create-verified-he");
  assert.equal(dateCase.expected.disposition, "semantic_rendering_required");
  assert.deepEqual(
    renderPresentation({ result: dateCase.result, language: dateCase.language }),
    { kind: "unsupported", reason: "semantic_rendering_required" },
  );
});

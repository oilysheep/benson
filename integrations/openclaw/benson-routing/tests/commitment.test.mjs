import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";

import { unavailableClassification } from "../classification.mjs";
import { evaluateRouting } from "../policy.mjs";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT ??
  resolve(homedir(), ".npm-global/lib/node_modules/openclaw");
const name = "dispatch-from-config-Cu599NRF.mjs";
const original = readFileSync(join(packageRoot, "dist", name), "utf8");
const nativeStoreSource = readFileSync(join(packageRoot, "dist",
  "session-accessor.sqlite-entry-store-DTntRuil.mjs"), "utf8");
const patchRoot = new URL("../../patches/", import.meta.url);
const stage = mkdtempSync(join(tmpdir(), "benson-s05-patch-"));
let patched;
try {
  mkdirSync(join(stage, "dist"));
  writeFileSync(join(stage, "dist", name), original);
  for (const patchName of [
    "openclaw-2026.9.6-benson-request-admission.patch",
    "openclaw-2026.9.6-benson-commitment.patch",
  ].filter((patchName) => patchName.includes("request-admission")
    ? !original.includes("function resolveBensonRequestAdmission(state)")
    : !original.includes("function commitBensonNativeOwner(state, decision)"))) {
    const applied = spawnSync("patch", ["-p1", "-d", stage], {
      input: readFileSync(new URL(patchName, patchRoot), "utf8"), encoding: "utf8",
    });
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  }
  const checked = spawnSync(process.execPath, ["--check", join(stage, "dist", name)],
    { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  patched = readFileSync(join(stage, "dist", name), "utf8");
} finally {
  rmSync(stage, { recursive: true, force: true });
}

const native = await import(pathToFileURL(join(packageRoot, "dist",
  "session-accessor.sqlite-entry-UCl9kr-O.mjs")).href);
const body = patched.match(/async function commitBensonNativeOwner\(state, decision\) \{[^]*?\n\}/u);
assert.ok(body, "native commitment function absent from patched bundle");
const dataRoot = mkdtempSync(join(tmpdir(), "benson-s05-native-"));
const env = { ...process.env, OPENCLAW_STATE_DIR: dataRoot };
const sessionKey = "agent:main:benson-s05-commitment";
const storePath = join(dataRoot, "agents", "main", "sessions", "sessions.json");
const scope = { sessionKey, storePath, env };
const nativePatch = (where, update, options) => native.d({ ...where, env }, update,
  { ...options, skipMaintenance: true });
const createCommitter = (patchEntry = nativePatch) => vm.runInNewContext(`(${body[0]})`, {
  patchSessionEntryCore: patchEntry,
  DispatchReplyOperationAbortedError: class extends Error {},
  Error, Object, Array,
});
const mainDecision = evaluateRouting(unavailableClassification("not_configured"));
assert.equal(mainDecision.route, "main");
assert.equal(mainDecision.reason, "classifier_unavailable");
const admission = (requestId) => ({ kind: "candidate", requestId, sessionKey });
let sessionId = "s05-session-1";
const state = (requestId, overrides = {}) => ({
  bensonRequestAdmission: admission(requestId),
  operationSessionStoreEntry: { sessionKey, storePath, entry: { sessionId } },
  isDispatchOperationAborted: () => false,
  ...overrides,
});
const records = () => native.l(scope)?.bensonDecisionCommitments ?? [];

try {
  await nativePatch(scope, () => ({ sessionId, updatedAt: Date.now() }),
    { fallbackEntry: { sessionId, updatedAt: Date.now() } });

  test("host patch uses only native session entry and stays disabled in production", () => {
    assert.match(patched, /async function commitBensonNativeOwner\(state, decision\)/u);
    assert.match(patched, /const BENSON_ROUTING_PRODUCTION_ENABLED = false;/u);
    assert.match(patched, /if \(BENSON_ROUTING_PRODUCTION_ENABLED && \["candidate", "main_only"\]\.includes\(state\.bensonRequestAdmission\?\.kind\)\)/u);
    assert.match(patched, /await patchSessionEntryCore\(/u);
    assert.match(patched, /await resolveBensonStagedDecision\(\)/u);
    assert.match(nativeStoreSource, /previousBensonCommitments/gu);
    assert.match(nativeStoreSource, /Benson native commitment cannot be removed or rewritten/u);
    assert.doesNotMatch(patched, /state\.bensonRoutingDecision/u);
  });

  test("native durable Main commitment survives lost receipt and restart", async () => {
    const first = await createCommitter()(state("turn-1"), mainDecision);
    assert.deepEqual(JSON.parse(JSON.stringify(first)), { status: "committed", owner: "main" });
    // Treat the first result as a lost acknowledgment. A new function instance
    // observes the native committed owner and does not accept another one.
    const readModule = pathToFileURL(join(packageRoot, "dist",
      "session-accessor.sqlite-entry-UCl9kr-O.mjs")).href;
    const separateProcess = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const native = await import(${JSON.stringify(readModule)});
       const entry = native.l({ sessionKey: ${JSON.stringify(sessionKey)},
         storePath: ${JSON.stringify(storePath)}, env: process.env });
       process.stdout.write(JSON.stringify(entry?.bensonDecisionCommitments ?? []));`],
    { encoding: "utf8", env });
    assert.equal(separateProcess.status, 0, separateProcess.stderr);
    assert.equal(JSON.parse(separateProcess.stdout).filter((row) => row.requestId === "turn-1").length, 1);
    const retry = await createCommitter()(state("turn-1"), mainDecision);
    assert.equal(retry.status, "already_committed");
    assert.equal(records().filter((row) => row.requestId === "turn-1").length, 1);
  });

  test("concurrent retries commit once; distinct identical-text admissions remain distinct", async () => {
    const commit = createCommitter();
    const same = await Promise.all(Array.from({ length: 4 }, () =>
      commit(state("turn-2"), mainDecision)));
    assert.equal(same.filter((result) => result.status === "committed").length, 1);
    assert.equal(same.filter((result) => result.status === "already_committed").length, 3);
    const distinct = await Promise.all(["turn-3", "turn-4"].map((id) =>
      commit(state(id), mainDecision)));
    assert.deepEqual(distinct.map((result) => result.status), ["committed", "committed"]);
    assert.equal(records().filter((row) => ["turn-2", "turn-3", "turn-4"].includes(row.requestId)).length, 3);
  });

  test("cancelled and late work cannot create a commitment", async () => {
    const commit = createCommitter();
    const result = await commit(state("cancelled", { isDispatchOperationAborted: () => true }), mainDecision);
    assert.equal(result.status, "cancelled");
    assert.equal(records().some((row) => row.requestId === "cancelled"), false);
  });

  test("cancellation between preparation and native commit leaves no owner", async () => {
    let cancelled = false;
    const interruptedPatch = (where, update, options) => nativePatch(where,
      (entry, context) => {
        const candidate = update(entry, context);
        cancelled = true;
        return candidate;
      }, options);
    await assert.rejects(createCommitter(interruptedPatch)(state("cancel-before-write", {
      isDispatchOperationAborted: () => cancelled,
    }), mainDecision));
    assert.equal(records().some((row) => row.requestId === "cancel-before-write"), false);
  });

  test("session replacement rejects stale work and allows a distinct new generation", async () => {
    const old = state("replaced");
    sessionId = "s05-session-2";
    await nativePatch(scope, () => ({ sessionId, updatedAt: Date.now() }), {});
    await assert.rejects(createCommitter()(old, mainDecision), /session replaced/u);
    assert.equal(records().some((row) => row.requestId === "replaced"), false);
    const current = await createCommitter()(state("replaced"), mainDecision);
    assert.equal(current.status, "committed");
    assert.equal(records().find((row) => row.requestId === "replaced")?.sessionId, sessionId);
  });

  test("native full replacement retains immutable commitments across restart boundary", async () => {
    const before = records();
    sessionId = "s05-session-3";
    native.g(scope, { sessionId, updatedAt: Date.now() });
    assert.deepEqual(records(), before);
    await assert.rejects(createCommitter()(state("turn-1"), mainDecision),
      /Benson commitment owner conflict/u);
    assert.throws(() => native.g(scope, {
      sessionId: "s05-session-4", updatedAt: Date.now(),
      bensonDecisionCommitments: [],
    }), /cannot be removed or rewritten/u);
    assert.deepEqual(records(), before);
  });

  test("native commitment validator admits only canonical Direct owners and preserves immutability", async () => {
    for (const owner of ["jessica-vacuum", "reminder-service"]) {
      const row = { requestId: "direct-" + owner, sessionId, owner, phase: "committed" };
      await nativePatch(scope, (entry) => ({
        bensonDecisionCommitments: [...entry.bensonDecisionCommitments, row],
      }), {});
      assert.deepEqual(records().at(-1), row);
    }
    await assert.rejects(nativePatch(scope, (entry) => ({
      bensonDecisionCommitments: [...entry.bensonDecisionCommitments,
        { requestId: "foreign-owner", sessionId, owner: "foreign", phase: "committed" }],
    }), {}), /Benson native commitment write invalid/u);
    await assert.rejects(nativePatch(scope, (entry) => ({
      bensonDecisionCommitments: entry.bensonDecisionCommitments.slice(0, -1),
    }), {}), /cannot be removed or rewritten/u);
  });
  test("direct candidate fails closed without native completion and response capability", async () => {
    const before = records().length;
    const result = await createCommitter()(state("direct"), { route: "jessica", eligible: true });
    assert.equal(result.status, "direct_unavailable");
    assert.equal(records().length, before);
  });
} finally {
  // node:test callbacks execute after module evaluation. Cleanup follows below.
}
process.on("exit", () => rmSync(dataRoot, { recursive: true, force: true }));

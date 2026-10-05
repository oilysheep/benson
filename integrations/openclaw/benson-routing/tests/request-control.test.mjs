import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";

import { formatTaskEnvelope } from "../envelope.mjs";
import { projectRequestAdmission } from "../request-control.mjs";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT ??
  resolve(homedir(), ".npm-global/lib/node_modules/openclaw");
const bundleName = "dispatch-from-config-Cu599NRF.mjs";
const installedBundle = join(packageRoot, "dist", bundleName);
const patchFile = new URL("../../patches/openclaw-2026.9.6-benson-request-admission.patch", import.meta.url);
const original = readFileSync(installedBundle, "utf8");
const patchText = readFileSync(patchFile, "utf8");
const tempRoot = mkdtempSync(join(tmpdir(), "benson-s03-native-"));
let patched;
try {
  mkdirSync(join(tempRoot, "dist"));
  writeFileSync(join(tempRoot, "dist", bundleName), original);
  if (!original.includes("function resolveBensonRequestAdmission(state)")) {
    const applied = spawnSync("patch", ["-p1", "-d", tempRoot], {
      input: patchText, encoding: "utf8",
    });
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  }
  const patchedPath = join(tempRoot, "dist", bundleName);
  const checked = spawnSync(process.execPath, ["--check", patchedPath], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  patched = readFileSync(patchedPath, "utf8");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
const sourceTurn = await import(pathToFileURL(join(packageRoot, "dist", "source-turn-id-BZGK3amb.mjs")).href);
const nativeFunction = patched.match(/function resolveBensonRequestAdmission\(state\) \{[^]*?\n\}/u);
assert.ok(nativeFunction, "patched native admission function missing");
const resolveNativeAdmission = vm.runInNewContext("(" + nativeFunction[0] + ")", {
  readChannelSourceTurnId: sourceTurn.n,
  Buffer,
  Object,
});
function state(overrides = {}) {
  const ctx = {
    InputProvenance: { kind: "external_user" },
    CommandTurn: { kind: "normal" },
    rawText: "שלום\t world \n",
    commandText: "שלום\t world \n",
    media: [],
    ...overrides.ctx,
  };
  sourceTurn.i(ctx, overrides.sourceTurnId === undefined ? "channel-user:v1:abc" : overrides.sourceTurnId);
  return {
    ctx, allowInboundHandlers: true, sessionAgentId: "main", pluginOwnedBinding: null,
    explicitCommandTurnCtx: false, inboundDedupeClaim: { status: "claimed", recovered: false },
    getDispatchReplyOperation: () => ({}), isPreDispatchOperationAborted: () => false,
    sessionStoreEntry: { sessionKey: "agent:main:whatsapp" },
    sessionKey: "agent:main:whatsapp", inboundAudio: false,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) =>
      !["ctx", "sourceTurnId"].includes(key))),
  };
}
function admission(value) { return JSON.parse(JSON.stringify(resolveNativeAdmission(value))); }

test("version-bound native admission remains production-disabled", () => {
  assert.equal(patched.includes("function resolveBensonRequestAdmission(state)"), true);
  assert.match(patched, /const bensonRequestAdmission = resolveBensonRequestAdmission\(state\);/u);
  assert.match(patched, /state: extendPreparedDispatchState\(state, \{\s*bensonRequestAdmission,/u);
  assert.equal((patched.match(/resolveBensonRequestAdmission\(state\)/gu) ?? []).length, 2);
  const takeover = patched.indexOf("const replyDispatchTakeover = await runReplyDispatchTakeover");
  const injection = patched.indexOf("const bensonRequestAdmission = resolveBensonRequestAdmission(state)");
  const resolver = patched.indexOf("const replyResolver = params.replyResolver");
  assert.ok(takeover < injection && injection < resolver);
  assert.doesNotMatch(patched, /bensonRequestAdmission\.(?:dispatch|run|commit)/u);
  if (patched.includes("commitBensonNativeOwner")) {
    assert.match(patched, /const BENSON_ROUTING_PRODUCTION_ENABLED = false;/u);
  } else {
    assert.doesNotMatch(patched, /bensonRequestAdmission\.kind === "candidate"/u);
  }
});

test("native source-turn identity keeps identical text in distinct turns", () => {
  const id1 = sourceTurn.t({ provider: "whatsapp", accountId: "benson",
    conversationId: "chat-1", messageId: "provider-1" });
  const id2 = sourceTurn.t({ provider: "whatsapp", accountId: "benson",
    conversationId: "chat-1", messageId: "provider-2" });
  assert.notEqual(id1, id2);
  const one = projectRequestAdmission(admission(state({ sourceTurnId: id1 })));
  const two = projectRequestAdmission(admission(state({ sourceTurnId: id2 })));
  assert.equal(one.kind, "candidate");
  assert.equal(two.kind, "candidate");
  assert.notEqual(one.trusted.requestId, two.trusted.requestId);
  assert.equal(formatTaskEnvelope(one.taskEnvelope.request),
    formatTaskEnvelope("שלום\t world \n"));
  assert.equal(one.taskEnvelope.request, two.taskEnvelope.request);
});

test("classifier projection contains only the exact current request", () => {
  const input = state({ ctx: {
    InputProvenance: undefined,
    rawText: "  שלום\\t\nnext line  ",
    commandText: "  שלום\\t\nnext line  ",
    BodyForAgent: "injected prior conversation",
    ChannelPromptContext: ["private history"],
    Secret: "must not project",
  } });
  const record = admission(input);
  assert.equal(record.kind, "candidate");
  const projected = projectRequestAdmission(record);
  assert.equal(projected.taskEnvelope.request, "  שלום\\t\nnext line  ");
  assert.deepEqual(Object.keys(projected).sort(), ["kind", "taskEnvelope", "trusted"]);
  assert.deepEqual(Object.keys(projected.trusted).sort(), ["requestId", "sessionKey"]);
  assert.doesNotMatch(JSON.stringify(projected), /private history|injected prior conversation|must not project/u);
});

test("native retry and non-external turns never reach classification", () => {
  const cases = [
    [state({ inboundDedupeClaim: { status: "duplicate", recovered: false } }), "duplicate_or_recovery"],
    [state({ inboundDedupeClaim: { status: "claimed", recovered: true } }), "duplicate_or_recovery"],
    [state({ allowInboundHandlers: false }), "non_external"],
    [state({ ctx: { InputProvenance: { kind: "inter_session" } } }), "non_external"],
    [state({ ctx: { InputProvenance: { kind: "internal_system" } } }), "non_external"],
    [state({ ctx: { InternalTurnSource: "cron" } }), "non_external"],
    [state({ ctx: { ParentSessionKey: "agent:main:parent" } }), "non_external"],
    [state({ ctx: { InboundEventKind: "room_event" } }), "non_external"],
    [state({ ctx: { CommandTurn: { kind: "native" } } }), "command"],
    [state({ ctx: { CommandTurn: { kind: "text-slash" } } }), "command"],
    [state({ ctx: { commandText: " /approve request" } }), "command"],
    [state({ pluginOwnedBinding: { pluginId: "other" } }), "plugin_binding"],
    [state({ getDispatchReplyOperation: () => null }), "already_owned"],
    [state({ isPreDispatchOperationAborted: () => true }), "cancelled"],
    [state({ sessionAgentId: "reminder-service" }), "non_main_owner"],
  ];
  for (const [input, reason] of cases) {
    const record = admission(input);
    assert.equal(record.kind, "bypass", reason);
    assert.equal(record.reason, reason);
    assert.equal(record.request, null);
    assert.equal(projectRequestAdmission(record).kind, "bypass");
  }
});

test("unsupported and identity-less inputs never supply classifier authority", () => {
  // The installed host keeps missing identity on native Main. The retained
  // standalone admission artifact used on an unmodified package says bypass.
  // Both fixtures must preserve their own contract without changing core.
  const identityKind = original.includes("function resolveBensonRequestAdmission(state)") ? "main_only" : "bypass";
  const cases = [
    [state({ sourceTurnId: null }), "identity_unavailable"],
    [state({ sessionStoreEntry: { sessionKey: null }, sessionKey: null }), "identity_unavailable"],
    [state({ inboundAudio: true }), "unsupported_input"],
    [state({ ctx: { media: [{ kind: "image" }] } }), "unsupported_input"],
    [state({ ctx: { rawText: "" } }), "empty_or_oversized"],
    [state({ ctx: { rawText: "x".repeat(8193) } }), "empty_or_oversized"],
  ];
  for (const [input, reason] of cases) {
    const record = admission(input);
    assert.equal(record.kind, reason === "identity_unavailable" ? identityKind : "main_only", reason);
    assert.equal(record.reason, reason);
    assert.equal(record.request, null);
    assert.equal(projectRequestAdmission(record).kind,
      reason === "identity_unavailable" ? identityKind : "main_only");
  }
});

test("forged or malformed native context is rejected before projection", () => {
  const valid = admission(state());
  for (const forged of [
    { ...valid, completionTarget: "RESPONSE_CONTROLLER" },
    { ...valid, schemaVersion: 2 },
    { ...valid, requestId: null },
    { ...valid, request: "x".repeat(8193) },
    { ...valid, reason: "eligible" },
    { ...valid, sessionKey: null },
    { ...valid, request: { text: "forged" } },
  ]) assert.throws(() => projectRequestAdmission(forged));
});

test("native dedupe claim retains its recovery disposition", () => {
  const source = patched.match(/function claimInboundDedupe\(ctx, opts\) \{[^]*?\n\}/u);
  assert.ok(source);
  const cache = new Map();
  const inFlight = new Map();
  const claim = vm.runInNewContext("(" + source[0] + ")", {
    buildInboundDedupeKey: (ctx) => ctx.id,
    inboundDedupeCache: {
      peek: (key) => cache.get(key),
      delete: (key) => cache.delete(key),
      check: (key) => cache.set(key, true),
    },
    inboundDedupeInFlight: inFlight,
  });
  const first = claim({ id: "turn-1" }, { reclaimPendingInput: () => false });
  assert.equal(first.status, "claimed");
  assert.equal(first.recovered, false);
  first.commit();
  assert.equal(claim({ id: "turn-1" }, { reclaimPendingInput: () => false }).status, "duplicate");
  const recovered = claim({ id: "turn-1" }, { reclaimPendingInput: () => true });
  assert.equal(recovered.status, "claimed");
  assert.equal(recovered.recovered, true);
  recovered.release();
  assert.equal(claim({ id: "turn-2" }, { reclaimPendingInput: () => false }).recovered, false);
});

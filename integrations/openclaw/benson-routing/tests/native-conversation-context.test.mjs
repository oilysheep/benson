import assert from "node:assert/strict";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createConversationContextController, MAX_TRANSCRIPT_HYDRATION_BYTES,
  MAX_TRANSCRIPT_HYDRATION_EVENTS } from "../request-control.mjs";

// Invoke with a fresh, explicit state fixture under the primary checkout's
// output directory. Imports must follow environment isolation; no live state.
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const fixtureRoot = process.env.OPENCLAW_P03_FIXTURE_DIR;
assert.ok(fixtureRoot && realpathSync(fixtureRoot).startsWith(join(repository, "output/p03-native-fixture-")),
  "an explicit isolated P03 fixture directory is required");
process.env.OPENCLAW_STATE_DIR = fixtureRoot;
process.env.OPENCLAW_CONFIG_PATH = join(fixtureRoot, "absent-config.json");
const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT ?? resolve(homedir(), ".npm-global/lib/node_modules/openclaw");
assert.equal(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version, "2026.9.6");
const installed = (name) => import(pathToFileURL(join(packageRoot, "dist", name)).href);
const { SessionManager } = await installed("plugin-sdk/agent-sessions.js");
const { getConversationSession, upsertSessionEntry, deleteSessionEntry, resolveStorePath, getSessionEntry,
  readTranscriptStatsSync } =
  await installed("plugin-sdk/session-store-runtime.js");
// Only the fixture plays OpenClaw's host producer: the native recorder factory
// and native address builder are not production Benson import dependencies.
const { t: createNativeRecorder } = await installed("user-turn-transcript-BkLX9Oj1.mjs");
const { rt: buildNativeIdentity } = await installed("session-accessor.sqlite-entry-store-DTntRuil.mjs");
let modelCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { modelCalls++; throw new Error("network/model work forbidden in P03 fixture"); };

function workflow() { return { status: "available", revision: "workflow-fixture-1", active: [], pending: [] }; }
function expectedState(binding) {
  const entry = getSessionEntry({ agentId: binding.agentId, storePath: binding.storePath,
    sessionKey: binding.sessionKey, readConsistency: "latest" });
  return { abortedLastRun: entry.abortedLastRun, status: entry.status };
}
function controller(binding, readWorkflowState = async () => workflow(), manager = SessionManager,
  readStats = readTranscriptStatsSync) {
  return createConversationContextController({ SessionManager: manager, getConversationSession,
    readTranscriptStatsSync: readStats, binding,
    assertAuthorized: (actual) => { assert.deepEqual(actual, binding); }, readWorkflowState });
}
function input(binding, text, key, senderId = binding.requesterId) {
  return { text, idempotencyKey: key, provenance: { kind: "external_user" },
    transport: { channel: binding.channel, conversationRef: binding.conversationRef,
      messageId: key, ...(binding.threadId === null ? {} : { threadId: binding.threadId }) },
    ...(binding.kind === "direct" ? {} : { sender: { id: senderId, name: `Name ${senderId}`,
      identity: { type: "observation", id: senderId, pluginId: binding.channel,
        accountId: binding.accountId, senderKind: "human" } } }) };
}
function assistant(binding, text, key) {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-responses",
    provider: "openclaw", model: "delivery-mirror", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    idempotencyKey: key, __openclaw: { transport: { channel: binding.channel,
      conversationRef: binding.conversationRef,
      ...(binding.threadId === null ? {} : { threadId: binding.threadId }) } } };
}
function source(binding, text, requestId) {
  return { schemaVersion: 1, kind: "candidate", reason: null, requestId,
    sessionKey: binding.sessionKey, request: text };
}
async function createBinding(name, options = {}) {
  const address = { agentId: "main", channel: "whatsapp", accountId: "account-a", kind: "direct",
    peerId: "+15550000001", ...options };
  const identity = buildNativeIdentity({ ...address, deliveryTarget: address.peerId });
  assert.ok(identity);
  const sessionKey = `agent:main:p03-${name}`;
  const sessionId = `p03-${name}-session`;
  const storePath = resolveStorePath(undefined, { agentId: "main" });
  const route = { channel: address.channel, to: identity.peerId, accountId: address.accountId,
    ...(address.threadId ? { threadId: address.threadId } : {}) };
  await upsertSessionEntry({ agentId: "main", sessionKey, storePath, entry: { sessionId,
    updatedAt: Date.now(), chatType: address.kind, delivery: { kind: "external", route, context: route,
      origin: { provider: address.channel, surface: address.channel, chatType: address.kind,
        from: identity.peerId, to: "fixture-bot", accountId: address.accountId,
        ...(address.threadId ? { threadId: address.threadId } : {}) } } } });
  const prepared = await SessionManager.openAsync({ agentId: "main", sessionKey, sessionId, storePath });
  const target = prepared.getSessionTarget();
  const binding = { agentId: "main", sessionKey, sessionId, storePath: target.storePath,
    channel: address.channel, accountId: address.accountId, kind: address.kind, peerId: identity.peerId,
    threadId: address.threadId ?? null, requesterId: address.kind === "direct" ? identity.peerId : "sender-a",
    conversationRef: identity.conversationRef };
  assert.deepEqual(getConversationSession({ ...address, peerId: identity.peerId, storePath: binding.storePath }),
    { sessionKey, sessionId });
  return binding;
}
async function adopt(binding, text, key, access = controller(binding)) {
  const recorder = createNativeRecorder({ input: input(binding, text, key), target: binding });
  const handle = await access.adoptCurrentTurn(source(binding, text, key), recorder,
    { expectedSessionState: expectedState(binding) });
  assert.equal(handle.status, "available", JSON.stringify(handle));
  return { access, recorder, handle };
}
async function settledTurn(binding, text, key, senderId = binding.requesterId) {
  const recorder = createNativeRecorder({ input: input(binding, text, key, senderId), target: binding });
  const accepted = await recorder.persistApproved({ expectedSessionId: binding.sessionId,
    expectedSessionState: expectedState(binding) });
  assert.ok(accepted?.admission);
  const manager = await SessionManager.openAsync(binding);
  const final = manager.appendMessageWithTranscriptAnchor(assistant(binding, `  reply ${text}\t\n`, `${key}:final`));
  assert.ok(final.anchor);
  return { user: accepted.messageId, assistant: final.entryId };
}

if (process.argv.includes("--measure-hydration")) {
  // Synthetic Pi sizing evidence, using only the installed native producer and
  // readers. Run each profile in a fresh process/state directory with --expose-gc.
  const profile = process.argv[process.argv.indexOf("--measure-hydration") + 1];
  const [messages, textBytes] = profile.split(":").map(Number);
  assert.ok(Number.isSafeInteger(messages) && messages > 0 && messages <= 8192);
  assert.ok(Number.isSafeInteger(textBytes) && textBytes > 0 && textBytes <= 65536);
  assert.equal(typeof globalThis.gc, "function");
  const binding = await createBinding("measurement");
  let producer = await SessionManager.openAsync(binding);
  for (let index = 0; index < messages; index++) {
    producer.appendMessage(assistant(binding, "x".repeat(textBytes), `measure-${index}`));
  }
  producer.flushPendingPersistence();
  producer = null;
  globalThis.gc();
  const runs = [];
  for (const kind of ["full", "bounded"]) for (let index = 0; index < 3; index++) {
    const before = process.memoryUsage();
    const statsStart = performance.now();
    const stats = readTranscriptStatsSync(binding);
    const statsMs = performance.now() - statsStart;
    const openStart = performance.now();
    let reader = await SessionManager.openAsync(binding, undefined, kind === "bounded" ?
      { maxBytes: MAX_TRANSCRIPT_HYDRATION_BYTES, maxEvents: MAX_TRANSCRIPT_HYDRATION_EVENTS - 2 } : undefined);
    const openMs = performance.now() - openStart;
    if (kind === "full") assert.equal(reader.getEntries().length, messages);
    const after = process.memoryUsage();
    runs.push({ kind, stats, statsMs, openMs, before, after,
      maxRssKiB: process.resourceUsage().maxRSS });
    reader = null;
    globalThis.gc();
  }
  const evidence = { node: process.version, platform: process.platform, arch: process.arch,
    boundedLimits: { maxBytes: MAX_TRANSCRIPT_HYDRATION_BYTES, maxEvents: MAX_TRANSCRIPT_HYDRATION_EVENTS - 2 },
    openclaw: "2026.9.6", profile: { messages, textBytes }, runs, modelCalls };
  writeFileSync(join(fixtureRoot, "hydration-measurement.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ profile, stats: runs[0].stats,
    statsMs: runs.map((run) => +run.statsMs.toFixed(2)),
    openMs: runs.map((run) => +run.openMs.toFixed(2)),
    rssDelta: runs.map((run) => run.after.rss - run.before.rss),
    heapDelta: runs.map((run) => run.after.heapUsed - run.before.heapUsed),
    maxRssKiB: Math.max(...runs.map((run) => run.maxRssKiB)), modelCalls }));
  assert.equal(modelCalls, 0);
  globalThis.fetch = originalFetch;
} else if (process.argv.includes("--verify-restart")) {
  const retained = JSON.parse(readFileSync(join(fixtureRoot, "restart-fixture.json"), "utf8"));
  const resumed = await adopt(retained.binding, retained.text, retained.key);
  assert.equal(resumed.handle.receipt.entryId, retained.receipt.entryId);
  assert.equal(resumed.handle.receipt.generation, retained.receipt.generation);
  const projection = await resumed.access.projectRoutingContext(resumed.handle);
  assert.equal(projection.status, "available", JSON.stringify(projection));
  assert.deepEqual(projection.context.previous.map((entry) => entry.entryId), retained.previousIds);
  assert.equal(projection.context.current.text, retained.text);
  const recovered = await resumed.access.verifyFinalReceipt(resumed.handle, retained.finalReceipt, () => {});
  assert.equal(recovered.status, "available", JSON.stringify(recovered));
  assert.deepEqual(recovered.receipt, retained.finalReceipt);
  assert.equal(modelCalls, 0);
  console.log("NATIVE_P03_RESTART_PASS");
} else {
  for (const dimension of ["bytes", "events", "at-boundary", "sparse-boundary", "growth", "event-growth", "boundary-growth"]) {
    test(`native ${dimension} hydration guard enforces bytes/events`, async () => {
      const binding = await createBinding(`hydration-${dimension}`);
      let producer = await SessionManager.openAsync(binding);
      if (dimension === "bytes") {
        producer.appendMessage(assistant(binding, "x".repeat(MAX_TRANSCRIPT_HYDRATION_BYTES), "oversized"));
      } else if (dimension === "sparse-boundary") {
        await adopt(binding, "exact earlier user", "sparse-earlier");
        producer = await SessionManager.openAsync(binding);
        for (let index = 0; index < MAX_TRANSCRIPT_HYDRATION_EVENTS - 3; index++) {
          await producer.appendModelChange("openclaw", "delivery-mirror");
        }
      } else if (["events", "at-boundary"].includes(dimension)) {
        // Include the header and adopted current turn in the total event count;
        // both boundary cases remain below the independent byte ceiling.
        const count = MAX_TRANSCRIPT_HYDRATION_EVENTS - (dimension === "at-boundary" ? 2 : 0);
        for (let index = 0; index < count; index++) {
          producer.appendMessage(assistant(binding, "x", `event-${index}`));
        }
      }
      let hydrationCalls = 0;
      let statsCalls = 0;
      const manager = { readSessionContext: SessionManager.readSessionContext,
        async openBoundedAsync(target, { onTruncated, signal, ...limits }) {
          hydrationCalls++;
          assert.deepEqual(limits, { maxBytes: MAX_TRANSCRIPT_HYDRATION_BYTES,
            maxEvents: MAX_TRANSCRIPT_HYDRATION_EVENTS - 2 });
          const bounded = await SessionManager.openBoundedAsync(target, { ...limits, signal, onTruncated });
          assert.equal(bounded.getHeader().type, "session");
          assert.ok(bounded.getEntries().length + 1 <= MAX_TRANSCRIPT_HYDRATION_EVENTS);
          if (dimension === "event-growth") assert.equal(bounded.getEntries().length + 1, MAX_TRANSCRIPT_HYDRATION_EVENTS - 1);
          if (dimension === "boundary-growth") {
            assert.equal(bounded.getEntries().length + 1, MAX_TRANSCRIPT_HYDRATION_EVENTS);
            assert.equal(bounded.getEntries().filter((entry) => entry.type === "compaction").length, 1);
          }
          if (dimension === "sparse-boundary") {
            assert.equal(bounded.getEntries().filter((entry) => entry.type === "message").length, 1);
            assert.equal(bounded.getBranch().filter((entry) => entry.type === "message").length, 1);
            assert.equal(bounded.getBranch()[0].parentId, null);
          }
          assert.ok(bounded.getEntries().reduce((bytes, entry) =>
            bytes + Buffer.byteLength(JSON.stringify(entry), "utf8") + 1, 0) <= MAX_TRANSCRIPT_HYDRATION_BYTES);
          assert.equal(bounded.getEntries().some((entry) => entry.message?.idempotencyKey === "growth"), false);
          return bounded;
        } };
      const access = controller(binding, async () => workflow(), manager, (target) => {
        const stats = readTranscriptStatsSync(target);
        statsCalls++;
        if (dimension.endsWith("growth") && statsCalls === 1) {
          // Grow after the preflight snapshot, before the actual native reader.
          if (dimension === "growth") {
            producer.appendMessage(assistant(binding, "x".repeat(MAX_TRANSCRIPT_HYDRATION_BYTES), "growth"));
          } else {
            if (dimension === "boundary-growth") producer.appendCompaction("existing native summary",
              producer.getLeafId(), 100);
            for (let index = 0; index < MAX_TRANSCRIPT_HYDRATION_EVENTS; index++) {
              producer.appendMessage(assistant(binding, "x", `growth-${index}`));
            }
          }
        }
        return stats;
      });
      const current = await adopt(binding, "bounded current", `${dimension}-current`, access);
      if (dimension.endsWith("growth")) producer = await SessionManager.openAsync(binding);
      const before = readTranscriptStatsSync(binding);
      if (dimension === "events") assert.ok(before.sizeBytes < MAX_TRANSCRIPT_HYDRATION_BYTES);
      const projection = await access.projectRoutingContext(current.handle);
      if (["at-boundary", "sparse-boundary"].includes(dimension)) {
        assert.equal(before.eventCount, MAX_TRANSCRIPT_HYDRATION_EVENTS);
        assert.deepEqual(projection,
          { status: "unavailable", route: "main", reason: "exact_window_unavailable" });
      } else assert.deepEqual(projection,
        { status: "unavailable", route: "main", reason: "transcript_hydration_bounds" });
      const hydrated = dimension.endsWith("growth") || ["at-boundary", "sparse-boundary"].includes(dimension);
      assert.equal(hydrationCalls, hydrated ? 1 : 0);
      assert.equal(statsCalls, hydrated ? 2 : 1);
      producer = null;
      assert.equal(modelCalls, 0);
    });
  }

  test("native recorder/direct-Main history survives reopen, compaction and later appends", async () => {
    const binding = await createBinding("custody", { peerId: "+15550000050" });
    const messages = [];
    for (let index = 0; index < 4; index++) {
      // Route order direct -> Main -> direct -> direct: the same O02 target,
      // with no child/session lifetime or model inference dependency.
      const pair = await settledTurn(binding, `  turn ${index}\t\n`, `custody-${index}`);
      messages.push(pair.user, pair.assistant);
    }
    // A native child execution session has a separate lifetime. Its removal
    // must not remove the canonical entries adopted above. This exercises
    // native custody, not P07 child dispatch or production terminal hooks.
    const child = { agentId: "main", storePath: binding.storePath,
      sessionKey: "agent:main:subagent:p03-fixture", sessionId: "p03-child-fixture" };
    await upsertSessionEntry({ ...child, entry: { sessionId: child.sessionId, updatedAt: Date.now() } });
    const childManager = await SessionManager.openAsync(child);
    childManager.appendMessage(assistant(binding, "PRIVATE CHILD EXECUTION", "child-result"));
    assert.equal(await deleteSessionEntry({ ...child, expectedSessionId: child.sessionId,
      archiveTranscript: true }), true);
    assert.equal(getSessionEntry(child), undefined);
    const manager = await SessionManager.openAsync(binding);
    manager.appendCompaction("EXISTING LOSSY SUMMARY", messages.at(-2), 1000);
    const current = await adopt(binding, "  exact current\t\n", "custody-current");
    const projection = await current.access.projectRoutingContext(current.handle);
    assert.equal(projection.status, "available", JSON.stringify(projection));
    assert.deepEqual(projection.context.previous.map((entry) => entry.entryId), messages.slice(-5));
    assert.equal(projection.context.previous.at(-1).text, "  reply   turn 3\t\n\t\n");
    assert.doesNotMatch(projection.serialized, /EXISTING LOSSY SUMMARY/u);
    const finalMessage = assistant(binding, "  exact adopted final\t\n", "custody-shared-final");
    const final = await current.access.appendFinal(current.handle, finalMessage, () => {});
    assert.equal(final.status, "available", JSON.stringify(final));
    const duplicate = await current.access.appendFinal(current.handle, finalMessage, () => {});
    // Installed SessionManager only returns duplicate-adoption anchors for
    // users. Assistant duplicate lookup throws; no second row is committed.
    // P09 must recover its retained native final receipt, never blindly append.
    assert.equal(duplicate.status, "unavailable");
    assert.equal(duplicate.recovery, "native_custody");
    assert.equal(Object.hasOwn(duplicate, "route"), false);
    const reopened = await SessionManager.openAsync(binding);
    assert.equal(reopened.getEntries().filter((entry) =>
      entry.message?.idempotencyKey === "custody-shared-final").length, 1);
    assert.equal(reopened.getEntry(final.receipt.entryId).message.content[0].text, "  exact adopted final\t\n");
    const recovered = await current.access.verifyFinalReceipt(current.handle, final.receipt, () => {});
    assert.equal(recovered.status, "available", JSON.stringify(recovered));
    assert.deepEqual(recovered.receipt, final.receipt);
    await settledTurn(binding, "FUTURE MUST NOT LEAK", "custody-future");
    const anchored = await current.access.projectRoutingContext(current.handle);
    assert.equal(anchored.status, "available", JSON.stringify(anchored));
    assert.deepEqual(anchored.context.previous.map((entry) => entry.entryId), messages.slice(-5));
    assert.doesNotMatch(anchored.serialized, /FUTURE MUST NOT LEAK|exact adopted final/u);
    writeFileSync(join(fixtureRoot, "restart-fixture.json"), JSON.stringify({ binding,
      text: "  exact current\t\n", key: "custody-current", receipt: current.handle.receipt,
      finalReceipt: final.receipt, previousIds: messages.slice(-5) }));
  });

  test("native account/peer/group/thread identities isolate the five-message window", async () => {
    const bindings = [];
    for (const [name, options] of [
      ["account-a", {}], ["account-b", { accountId: "account-b" }],
      ["peer-b", { peerId: "+15550000002" }],
      ["group-thread-a", { kind: "group", peerId: "10000000001@g.us", threadId: "thread-a" }],
      ["group-thread-b", { kind: "group", peerId: "10000000001@g.us", threadId: "thread-b" }],
    ]) {
      const binding = await createBinding(name, options);
      bindings.push(binding);
      await settledTurn(binding, `PRIVATE ${name}`, `history-${name}`,
        binding.kind === "group" ? "sender-b" : binding.requesterId);
      const current = await adopt(binding, `current ${name}`, `current-${name}`);
      const projection = await current.access.projectRoutingContext(current.handle);
      assert.equal(projection.status, "available", JSON.stringify(projection));
      assert.equal(projection.context.previous.length, 2);
      assert.equal(projection.context.previous[0].text, `PRIVATE ${name}`);
      if (binding.kind === "group") {
        assert.equal(projection.context.previous[0].sender.identity.id, "sender-b");
        assert.equal(projection.context.previous[0].sender.identity.accountId, binding.accountId);
      }
    }
    assert.equal(new Set(bindings.map((binding) => binding.conversationRef)).size, 5);
    assert.equal(new Set(bindings.map((binding) => binding.sessionId)).size, 5);
    const original = bindings[0];
    const current = await adopt(original, "isolated again", "isolation-current");
    const read = await SessionManager.openAsync(original);
    read.appendMessage(assistant(bindings[1], "CONTAMINATED ACCOUNT", "wrong-account-final"));
    const next = await adopt(original, "after contamination", "isolation-after");
    const denied = await next.access.projectRoutingContext(next.handle);
    assert.equal(denied.status, "unavailable");
    assert.equal(denied.reason, "conversation_provenance_mismatch");
    assert.equal(Object.hasOwn(denied, "context"), false);
    assert.equal((await current.access.projectRoutingContext(current.handle)).status, "available");
  });

  test("native workflow identity-only lookup, revision and receipt races fail closed", async () => {
    const binding = await createBinding("races", { peerId: "+15550000051" });
    const older = await settledTurn(binding, "OLDER EXACT QUOTE\t\n", "older-quote");
    for (let i = 0; i < 3; i++) await settledTurn(binding, `recent ${i}`, `recent-${i}`);
    let state = workflow();
    const access = controller(binding, async () => state);
    const current = await adopt(binding, "use that quote", "races-current", access);
    state.pending = [{ workflowId: "pending-native-fixture", metadata: { continuationEligible: true },
      turnReferences: [{ entryId: older.user, conversationRef: binding.conversationRef,
        sessionId: binding.sessionId, generation: current.handle.receipt.generation }] }];
    const projection = await access.projectRoutingContext(current.handle);
    assert.equal(projection.status, "available", JSON.stringify(projection));
    assert.equal(projection.context.older[0].text, "OLDER EXACT QUOTE\t\n");
    const compactingManager = { readSessionContext: SessionManager.readSessionContext.bind(SessionManager),
      async openBoundedAsync(...args) {
        const snapshot = await SessionManager.openBoundedAsync(...args);
        const writer = await SessionManager.openAsync(binding);
        writer.appendCompaction("CONCURRENT LOSSY SUMMARY", current.handle.receipt.entryId, 1000);
        return snapshot;
      } };
    const compacting = controller(binding, async () => state, compactingManager);
    const compactedHandle = await compacting.adoptCurrentTurn(
      source(binding, "use that quote", "races-current"), current.recorder);
    const compacted = await compacting.projectRoutingContext(compactedHandle);
    assert.equal(compacted.status, "available", JSON.stringify(compacted));
    assert.deepEqual(compacted.context, projection.context);
    assert.doesNotMatch(compacted.serialized, /CONCURRENT LOSSY SUMMARY/u);
    state = { ...state, revision: "workflow-fixture-2" };
    assert.equal((await access.revalidateProjection(projection)).reason, "workflow_context_changed");
    const racingManager = { readSessionContext: SessionManager.readSessionContext.bind(SessionManager),
      async openBoundedAsync(...args) {
        const snapshot = await SessionManager.openBoundedAsync(...args);
        const writer = await SessionManager.openAsync(binding);
        const entries = writer.getEntries();
        const cutoff = entries.findIndex((entry) => entry.id === current.handle.receipt.entryId);
        assert.ok(cutoff >= 0);
        const suffix = new Set(entries.slice(cutoff).map((entry) => entry.id));
        writer.removeTrailingEntries((entry) => suffix.has(entry.id));
        return snapshot;
      } };
    const racing = controller(binding, async () => state, racingManager);
    // Recreate a trusted host handle before installing the hydration race.
    const adopted = await racing.adoptCurrentTurn(source(binding, "use that quote", "races-current"), current.recorder);
    assert.equal(adopted.status, "available");
    const rejected = await racing.projectRoutingContext(adopted);
    assert.equal(rejected.status, "unavailable");
    assert.equal(Object.hasOwn(rejected, "context"), false);
    assert.equal((await access.revalidateProjection(projection)).status, "unavailable");
  });

  test("native reset, retained-history loss, abort and missing binding never become empty", async () => {
    const binding = await createBinding("reset", { peerId: "+15550000052" });
    const previous = await settledTurn(binding, "PRE RESET PRIVATE", "before-reset");
    const manager = await SessionManager.openAsync(binding);
    manager.appendResetBoundary("reset");
    const current = await adopt(binding, "post reset", "post-reset");
    const projection = await current.access.projectRoutingContext(current.handle);
    assert.equal(projection.status, "available", JSON.stringify(projection));
    assert.deepEqual(projection.context.previous, []);
    const state = workflow();
    state.active = [{ workflowId: "retained-reference", metadata: {}, turnReferences: [{
      entryId: previous.user, conversationRef: binding.conversationRef, sessionId: binding.sessionId,
      generation: current.handle.receipt.generation }] }];
    const dependent = controller(binding, async () => state);
    const handle = await dependent.adoptCurrentTurn(source(binding, "post reset", "post-reset"), current.recorder);
    assert.equal((await dependent.projectRoutingContext(handle)).reason, "workflow_reference_unavailable");
    assert.equal((await current.access.projectRoutingContext(current.handle,
      { signal: AbortSignal.abort() })).status, "unavailable");
    const absent = { ...binding, peerId: "+15550000099", conversationRef: "conv_absent" };
    const missing = controller(absent);
    assert.equal((await missing.adoptCurrentTurn(source(absent, "missing", "missing"), current.recorder)).reason,
      "conversation_binding_unavailable");
    const writer = await SessionManager.openAsync(binding);
    writer.removeTrailingEntries(() => true);
    assert.equal((await current.access.projectRoutingContext(current.handle)).status, "unavailable");
    await createBinding("reset-successor", { peerId: binding.peerId });
    assert.equal((await current.access.projectRoutingContext(current.handle)).reason, "conversation_binding_changed");
  });

  test("native context construction performs zero network/model calls", () => {
    assert.equal(modelCalls, 0);
    globalThis.fetch = originalFetch;
    console.log("NATIVE_P03_FIXTURE_COMPLETE");
  });
}

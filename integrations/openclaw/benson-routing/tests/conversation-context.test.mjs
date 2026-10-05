import assert from "node:assert/strict";
import test from "node:test";
import { createConversationContextController, MAX_ROUTING_CONTEXT_BYTES,
  MAX_ROUTING_REFERENCES, MAX_ROUTING_WORKFLOW_BYTES, MAX_TRANSCRIPT_HYDRATION_BYTES,
  MAX_TRANSCRIPT_HYDRATION_EVENTS, ROUTING_TRANSCRIPT_TIERS } from "../request-control.mjs";

function fixture(changes = {}) {
  const binding = { agentId: "main", channel: "whatsapp", accountId: "account-a",
    kind: "direct", peerId: "peer-a", threadId: null, requesterId: "peer-a",
    conversationRef: "conv_a", sessionKey: "agent:main:conversation-a",
    sessionId: "session-a", storePath: "/fixture/store", ...changes.binding };
  let receipt = { ...Object.fromEntries(["agentId", "sessionKey", "sessionId", "storePath"]
    .map((key) => [key, binding[key]])), generation: "generation-a", entryId: "current", rawSeq: 9,
  effectiveParentId: "m7", activeMessagePosition: 7, logicalTurnId: "turn-a", role: "user" };
  const source = { schemaVersion: 1, kind: "candidate", reason: null, requestId: "request-a",
    sessionKey: binding.sessionKey, request: "  now\t\n" };
  function message(id, role, text, extra = {}) {
    return { type: "message", id, parentId: null, message: { role, content: text,
      ...(role === "user" ? { provenance: { kind: "external_user" } } : {}),
      __openclaw: { transport: { channel: binding.channel, conversationRef: binding.conversationRef,
        ...(binding.threadId === null ? {} : { threadId: binding.threadId }) },
      ...(role === "user" && binding.kind !== "direct" ? { senderId: binding.requesterId,
        senderIdentity: { type: "observation", id: binding.requesterId, pluginId: binding.channel,
          accountId: binding.accountId, senderKind: "human" } } : {}) }, ...extra } };
  }
  const entries = Array.from({ length: 7 }, (_, index) => message(`m${index + 1}`,
    index % 2 ? "assistant" : "user", `  exact ${index + 1}\t\n`));
  entries.push(message("current", "user", source.request), message("future", "user", "PRIVATE FUTURE"));
  entries.forEach((entry, index) => { entry.parentId = entries[index - 1]?.id ?? null; });
  let state = { status: "available", revision: "workflow-revision-1", active: [], pending: [] };
  let registry = { sessionKey: binding.sessionKey, sessionId: binding.sessionId };
  let denied = false;
  const deniedEntries = new Set();
  const calls = { model: 0, stats: 0, hydration: 0, receipt: 0, append: 0, workflow: 0, reads: [] };
  let scopedAdmission;
  const infer = () => { calls.model++; throw new Error("inference forbidden"); };
  const native = {
    readTranscriptStatsSync(target) {
      calls.stats++;
      assert.equal(target.sessionId, binding.sessionId);
      return native.onStats ? native.onStats() : { eventCount: entries.length + 1,
        maxSeq: entries.length, sizeBytes: Buffer.byteLength(JSON.stringify(entries), "utf8") };
    },
    getConversationSession(params) {
      assert.equal(params.accountId, binding.accountId);
      assert.equal(params.peerId, binding.peerId);
      assert.equal(params.threadId ?? null, binding.threadId);
      return registry;
    },
    SessionManager: {
      generateSummary: infer, embedding: infer, agent: infer, semanticReranker: infer,
      async openBoundedAsync(target, { signal, onTruncated, ...limits }) {
        assert.equal(target.sessionId, binding.sessionId);
        const admission = structuredClone(scopedAdmission);
        assert.deepEqual(admission, receipt);
        calls.hydration++;
        calls.reads.push({ limits, admission });
        const selected = native.onBounded?.(calls.reads.length) ?? {};
        await native.onOpen?.();
        signal?.throwIfAborted();
        const cutoff = entries.findIndex((entry) => entry.id === admission.entryId);
        let branch = entries.slice(0, cutoff);
        if (selected.count !== undefined) branch = branch.slice(branch.length - selected.count);
        if (selected.unfenced) branch = entries;
        if (selected.truncated ?? native.truncated) onTruncated();
        return { getSessionId: () => binding.sessionId,
          getAppendParentId: () => selected.parentId === undefined ? admission.effectiveParentId : selected.parentId,
          getBranch: () => branch.map((entry, index) => ({ ...entry, parentId: branch[index - 1]?.id ?? null })),
          getEntry: (id) => branch.find((entry) => entry.id === id) };
      },
      readSessionContext(_target, read, { admission }) {
        calls.receipt++;
        assert.equal(admission.entryId, receipt.entryId);
        if (admission.generation !== receipt.generation) throw new Error("stale native receipt");
        scopedAdmission = admission;
        try {
          const result = read({ [Symbol.iterator]() { throw new Error("must not consume model context"); } },
            { id: binding.sessionId });
          assert.equal(typeof result?.then, "undefined", "native transaction callback must be synchronous");
          return result;
        } finally { scopedAdmission = undefined; }
      },
      async openAsync(_target, _cwd, limits) {
        assert.deepEqual(limits, { maxBytes: MAX_TRANSCRIPT_HYDRATION_BYTES,
          maxEvents: MAX_TRANSCRIPT_HYDRATION_EVENTS - 2 });
        calls.hydration++;
        await native.onOpen?.();
        return { getSessionId: () => binding.sessionId,
          getBranch: (id) => entries.slice(0, entries.findIndex((entry) => entry.id === id) + 1)
            .map((entry, index) => ({ ...entry, parentId: entries[index - 1]?.id ?? null })),
          getEntry: (id) => entries.find((entry) => entry.id === id),
          appendMessageWithTranscriptAnchor(value, { beforeFreshMessageCommit }) {
            native.onBeforeFreshCommit?.();
            beforeFreshMessageCommit();
            calls.append++;
            entries.push({ type: "message", id: "final", message: value });
            return { entryId: "final", appended: true, message: value,
              anchor: { ...receipt, entryId: "final", rawSeq: 10 } };
          } };
      },
      async openModelContextAsync(_target, { through, limits }) {
        calls.hydration++;
        assert.deepEqual(limits, { maxBytes: MAX_TRANSCRIPT_HYDRATION_BYTES,
          maxEvents: MAX_TRANSCRIPT_HYDRATION_EVENTS - 2 });
        assert.equal(through.storePath, receipt.storePath);
        assert.equal(through.generation, receipt.generation);
        await native.onFinalVerify?.();
        return { getEntry: (id) => entries.find((entry) => entry.id === id) };
      },
    },
  };
  const controller = createConversationContextController({ ...native, binding,
    assertAuthorized(_binding, entry) {
      if (denied || deniedEntries.has(entry?.id)) throw new Error("access revoked");
      return native.onAuthorize?.(_binding, entry);
    },
    readWorkflowState: async () => {
      await native.onWorkflowRead?.(++calls.workflow);
      return state;
    } });
  const recorder = { isBlocked: () => false, waitForRuntimePersistence: async () => {},
    resolveMessage: async () => entries.find((entry) => entry.id === "current").message,
    getAdmissionReceipt: () => receipt,
    getPersistedMessage: () => entries.find((entry) => entry.id === "current").message };
  const reference = (entryId) => ({ entryId, conversationRef: binding.conversationRef,
    sessionId: binding.sessionId, generation: receipt.generation });
  const workflow = (references = [], metadata = {}) => ({ workflowId: "workflow-a", metadata,
    turnReferences: references.map(reference) });
  return { controller, entries, source, recorder, calls, binding, native, message, reference, workflow, deniedEntries,
    get state() { return state; }, set state(value) { state = value; },
    set registry(value) { registry = value; }, set denied(value) { denied = value; },
    set receipt(value) { receipt = value; }, get receipt() { return receipt; },
    adopt: () => controller.adoptCurrentTurn(source, recorder) };
}

test("exact current and five same-conversation messages, no older discovery or inference", async () => {
  const f = fixture();
  const adoption = await f.adopt();
  assert.equal(adoption.status, "available");
  const projection = await f.controller.projectRoutingContext(adoption);
  assert.equal(projection.status, "available");
  assert.equal(projection.context.current.text, f.source.request);
  assert.deepEqual(projection.context.previous.map((entry) => entry.entryId), ["m3", "m4", "m5", "m6", "m7"]);
  assert.equal(projection.context.previous[0].text, "  exact 3\t\n");
  assert.deepEqual(projection.context.older, []);
  assert.doesNotMatch(projection.serialized, /PRIVATE FUTURE|exact 1|exact 2|storePath|generation-a/u);
  assert.equal(projection.byteLength, Buffer.byteLength(projection.serialized, "utf8"));
  assert.ok(Object.isFrozen(projection.context.previous[0].sender));
  assert.equal((await f.controller.revalidateProjection(projection)).status, "available");
  assert.equal(f.calls.model, 0);
});

test("valid empty native window and workflow remain distinct from unavailable", async () => {
  const f = fixture();
  f.entries.splice(0, 7);
  f.entries[0].parentId = null;
  const adoption = await f.adopt();
  const projection = await f.controller.projectRoutingContext(adoption);
  assert.equal(projection.status, "available");
  assert.deepEqual(projection.context.previous, []);
  assert.deepEqual(projection.context.workflow.active, []);
  f.state = { status: "unavailable" };
  const unavailable = await f.controller.projectRoutingContext(adoption);
  assert.deepEqual(unavailable, { status: "unavailable", route: "main", reason: "workflow_context_unavailable" });
  assert.equal(Object.hasOwn(unavailable, "context"), false);
});

test("transcript bytes/events are checked before hydration, including both exact boundaries", async () => {
  for (const [stats, allowed] of [
    [{ sizeBytes: MAX_TRANSCRIPT_HYDRATION_BYTES - 1, eventCount: 10, maxSeq: 9 }, true],
    [{ sizeBytes: MAX_TRANSCRIPT_HYDRATION_BYTES, eventCount: 10, maxSeq: 9 }, false],
    [{ sizeBytes: 1000, eventCount: MAX_TRANSCRIPT_HYDRATION_EVENTS, maxSeq: 1023 }, true],
    [{ sizeBytes: 1000, eventCount: MAX_TRANSCRIPT_HYDRATION_EVENTS + 1, maxSeq: 1024 }, false],
  ]) {
    const f = fixture();
    f.native.onStats = () => stats;
    const projection = await f.controller.projectRoutingContext(await f.adopt());
    assert.equal(projection.status, allowed ? "available" : "unavailable");
    assert.equal(f.calls.hydration, allowed ? 1 : 0);
    if (!allowed) assert.deepEqual(projection,
      { status: "unavailable", route: "main", reason: "transcript_hydration_bounds" });
    assert.equal(f.calls.model, 0);
  }
  const f = fixture();
  f.entries[0].message.content = "x".repeat(MAX_TRANSCRIPT_HYDRATION_BYTES);
  assert.equal((await f.controller.projectRoutingContext(await f.adopt())).reason, "transcript_hydration_bounds");
  assert.equal(f.calls.hydration, 0);
});

test("unavailable, invalid or asynchronous native stats fail closed without hydration", async () => {
  for (const value of [null, undefined, {}, { sizeBytes: -1, eventCount: 1, maxSeq: 0 },
    { sizeBytes: 100, eventCount: 1.5, maxSeq: 0 },
    { sizeBytes: 100, eventCount: 1, maxSeq: Number.MAX_SAFE_INTEGER + 1 },
    { sizeBytes: "100", eventCount: 1, maxSeq: 0 }]) {
    const f = fixture();
    f.native.onStats = () => value;
    const projection = await f.controller.projectRoutingContext(await f.adopt());
    assert.equal(projection.reason, "transcript_stats_unavailable");
    assert.equal(projection.route, "main");
    assert.equal(f.calls.hydration, 0);
    assert.equal(f.calls.model, 0);
  }
  const f = fixture();
  f.native.onStats = async () => { throw new Error("stats must be synchronous"); };
  assert.equal((await f.controller.projectRoutingContext(await f.adopt())).reason, "transcript_stats_unavailable");
  await new Promise(setImmediate);
  assert.equal(f.calls.hydration, 0);
});

test("growth during bounded native hydration rejects the projection and preserves final custody", async () => {
  const f = fixture();
  const adoption = await f.adopt();
  f.native.onOpen = () => {
    f.native.onStats = () => ({ sizeBytes: MAX_TRANSCRIPT_HYDRATION_BYTES,
      eventCount: 10, maxSeq: 9 });
  };
  assert.equal((await f.controller.projectRoutingContext(adoption)).reason, "transcript_hydration_bounds");
  assert.equal(f.calls.hydration, 1);
  const final = await f.controller.appendFinal(adoption,
    { role: "assistant", content: "final", idempotencyKey: "bounded-final",
      __openclaw: { transport: { channel: f.binding.channel, conversationRef: f.binding.conversationRef } } }, () => {});
  assert.equal(final.status, "unavailable");
  assert.equal(final.recovery, "native_custody");
  assert.equal(Object.hasOwn(final, "route"), false);
  assert.equal(final.mayHaveAppended, false);
  assert.equal(f.calls.append, 0);
  assert.equal(f.calls.hydration, 1);
  const verification = await f.controller.verifyFinalReceipt(adoption,
    { ...f.receipt, entryId: "final", rawSeq: 10 }, () => {});
  assert.equal(verification.status, "unavailable");
  assert.equal(verification.reason, "transcript_hydration_bounds");
  assert.equal(verification.recovery, "native_custody");
  assert.equal(Object.hasOwn(verification, "route"), false);
  assert.equal(f.calls.hydration, 1);
  assert.equal(f.calls.model, 0);
});

test("zero through five available previous exact messages are valid, without retries on complete reads", async () => {
  for (const count of [0, 1, 2, 3, 4, 5]) {
    const f = fixture();
    f.entries.splice(0, 7 - count);
    f.entries[0].parentId = null;
    const adoption = await f.adopt();
    const projection = await f.controller.projectRoutingContext(adoption);
    assert.equal(projection.status, "available");
    assert.equal(projection.context.previous.length, count);
    assert.deepEqual(projection.context.history, { previousMessageCount: count, historyTruncated: false });
    assert.equal(f.calls.hydration, 1);
    assert.equal(f.calls.model, 0);
  }
});

test("deterministic tiers stop at complete reads or five safe previous messages, with at most three attempts", async () => {
  for (const reads of [
    [{ count: 3, truncated: true }, { count: 5, truncated: true }],
    [{ count: 1, truncated: true }, { count: 2, truncated: false }],
    [{ count: 1, truncated: true }, { count: 2, truncated: true }, { count: 4, truncated: false }],
    [{ count: 1, truncated: true }, { count: 2, truncated: true }, { count: 2, truncated: true }],
    [{ count: 3, truncated: true }, { count: 3, truncated: true }, { count: 3, truncated: true }],
    [{ count: 0, truncated: true }, { count: 0, truncated: true }, { count: 0, truncated: true }],
    [{ count: 5, truncated: true }],
  ]) {
    const f = fixture();
    f.native.onBounded = (attempt) => reads[attempt - 1];
    const adoption = await f.adopt();
    const projection = await f.controller.projectRoutingContext(adoption);
    assert.equal(projection.status, "available");
    assert.equal(f.calls.hydration, reads.length);
    const last = reads.at(-1);
    assert.deepEqual(projection.context.history,
      { previousMessageCount: last.count, historyTruncated: last.truncated });
    assert.deepEqual(projection.context.previous.map((entry) => entry.entryId),
      Array.from({ length: last.count }, (_, i) => `m${8 - last.count + i}`));
    for (const [i, read] of f.calls.reads.entries()) {
      assert.deepEqual(read.limits, { maxBytes: ROUTING_TRANSCRIPT_TIERS[i].maxBytes,
        maxEvents: ROUTING_TRANSCRIPT_TIERS[i].maxEvents - 2 });
      assert.deepEqual(read.admission, adoption.receipt);
    }
    assert.equal(f.calls.model, 0);
  }
});

test("an unproven suffix, native failure, binding, generation or provenance failure never enlarges the read", async () => {
  for (const change of [
    (f) => { f.native.onBounded = () => ({ count: 3, truncated: true, parentId: "future" }); },
    (f) => { f.native.onBounded = () => ({ truncated: true, unfenced: true }); },
    (f) => { f.native.onOpen = () => { throw new Error("native read failed"); }; },
    (f) => { f.native.onOpen = () => { f.denied = true; }; },
    (f) => { f.native.onBounded = () => ({ count: 0, truncated: true });
      f.native.onOpen = () => { f.deniedEntries.add("current"); }; },
    (f) => { f.native.onOpen = () => { f.registry = undefined; }; },
    (f) => { f.native.onOpen = () => { f.receipt = { ...f.receipt, generation: "new" }; }; },
    (f) => { f.native.onBounded = () => ({ count: 2, truncated: true });
      f.native.onOpen = () => { f.state = { ...f.state, revision: "changed" }; }; },
    (f) => { f.native.onBounded = () => ({ count: 2, truncated: true });
      f.entries[6].message.__openclaw.transport.conversationRef = "another"; },
  ]) {
    const f = fixture();
    const adoption = await f.adopt();
    change(f);
    const projection = await f.controller.projectRoutingContext(adoption);
    assert.equal(projection.status, "unavailable");
    assert.equal(projection.route, "main");
    assert.equal(Object.hasOwn(projection, "context"), false);
    assert.equal(f.calls.hydration, 1);
    assert.equal(f.calls.model, 0);
  }
});

test("malformed visible provenance never becomes a complete or truncated safe suffix", async () => {
  for (const provenance of [null, {}, { kind: "unknown" }, "external_user", ["external_user"]]) {
    for (const role of ["user", "assistant"]) {
      for (const truncated of [false, true]) {
        const f = fixture();
        f.entries.splice(0, 4);
        f.entries[0].parentId = null;
        f.entries[1].message.role = role;
        f.entries[1].message.provenance = provenance;
        f.native.onBounded = () => ({ count: 3, truncated });
        const projection = await f.controller.projectRoutingContext(await f.adopt());
        assert.equal(projection.status, "unavailable");
        assert.equal(projection.reason, "input_provenance_unavailable");
        assert.equal(projection.route, "main");
        assert.equal(Object.hasOwn(projection, "context"), false);
        assert.equal(f.calls.hydration, 1);
        assert.equal(f.calls.model, 0);
      }
    }
  }
});

test("recognized native internal provenance is omitted without treating it as malformed history", async () => {
  for (const kind of ["internal_system", "inter_session"]) {
    const f = fixture();
    f.entries.splice(0, 4);
    f.entries[0].parentId = null;
    f.entries[1].message.role = "user";
    f.entries[1].message.provenance = { kind };
    const projection = await f.controller.projectRoutingContext(await f.adopt());
    assert.equal(projection.status, "available");
    assert.deepEqual(projection.context.previous.map((entry) => entry.entryId), ["m5", "m7"]);
    assert.deepEqual(projection.context.history, { previousMessageCount: 2, historyTruncated: false });
    assert.doesNotMatch(projection.serialized, /exact 6/u);
    assert.equal(f.calls.hydration, 1);
    assert.equal(f.calls.model, 0);
  }
});

test("concurrent append between attempts never changes the admitted cutoff or exposes future turns", async () => {
  const f = fixture();
  const adoption = await f.adopt();
  f.native.onBounded = (attempt) => {
    if (attempt === 2) f.entries.push(f.message("another-future", "user", "SECRET LATER TURN"));
    return { count: attempt, truncated: attempt === 1 };
  };
  const projection = await f.controller.projectRoutingContext(adoption);
  assert.equal(projection.status, "available");
  assert.equal(f.calls.hydration, 2);
  assert.doesNotMatch(projection.serialized, /PRIVATE FUTURE|SECRET LATER TURN/u);
  assert.deepEqual(projection.context.previous.map((entry) => entry.entryId), ["m6", "m7"]);
  assert.ok(f.calls.reads.every((read) => JSON.stringify(read.admission) === JSON.stringify(adoption.receipt)));
  assert.equal(f.calls.model, 0);
});

test("only explicit trusted workflow IDs retrieve older exact turns, in native order", async () => {
  const f = fixture();
  f.state.pending = [f.workflow(["m2", "m1", "m2", "m4"], { intent: "change earlier request" })];
  const projection = await f.controller.projectRoutingContext(await f.adopt());
  assert.equal(projection.status, "available");
  assert.deepEqual(projection.context.older.map((entry) => entry.entryId), ["m1", "m2"]);
  assert.equal(f.calls.model, 0);
});

test("group window preserves each native sender without granting workflow steering", async () => {
  const f = fixture({ binding: { kind: "group", peerId: "group-a", threadId: "thread-a", requesterId: "sender-a" } });
  f.entries[2].message.__openclaw.senderId = "sender-b";
  f.entries[2].message.__openclaw.senderIdentity.id = "sender-b";
  f.entries[2].message.__openclaw.senderName = "B";
  const projection = await f.controller.projectRoutingContext(await f.adopt());
  assert.equal(projection.status, "available");
  assert.equal(projection.context.previous[0].sender.id, "sender-b");
  assert.equal(projection.context.previous[0].sender.identity.type, "observation");
  assert.equal(projection.context.previous[0].sender.name, "B");
  assert.equal(projection.context.current.sender.id, "sender-a");
  assert.deepEqual(projection.context.workflow.active, []);
});

test("cross-conversation/account/peer/thread or absent sender provenance fails closed", async () => {
  for (const mutate of [
    (f) => { f.entries[2].message.__openclaw.transport.conversationRef = "conv_other-peer"; },
    (f) => { f.entries[2].message.__openclaw.transport.channel = "telegram"; },
    (f) => { f.entries[2].message.__openclaw.transport.threadId = "thread-b"; },
    (f) => { f.entries[2].message.__openclaw.senderIdentity.accountId = "account-b"; },
    (f) => { delete f.entries[2].message.__openclaw.senderIdentity; },
    (f) => { f.registry = { sessionKey: "agent:main:other-account", sessionId: "other-session" }; },
  ]) {
    const f = fixture({ binding: { kind: "group", peerId: "group-a", threadId: "thread-a", requesterId: "sender-a" } });
    const adoption = await f.adopt();
    mutate(f);
    const result = await f.controller.projectRoutingContext(adoption);
    assert.equal(result.status, "unavailable");
    assert.equal(result.route, "main");
    assert.equal(Object.hasOwn(result, "context"), false);
    assert.equal(f.calls.model, 0);
  }
});

test("missing/future/off-branch/stale/cross-binding workflow references are unavailable", async () => {
  for (const reference of ["missing", "future", "off-branch", "stale", "other-thread"]) {
    const f = fixture();
    const record = f.workflow([reference]);
    if (reference === "stale") record.turnReferences[0].generation = "old-generation";
    if (reference === "other-thread") record.turnReferences[0].conversationRef = "other-conversation";
    f.state.active = [record];
    const result = await f.controller.projectRoutingContext(await f.adopt());
    assert.equal(result.status, "unavailable", reference);
    assert.equal(Object.hasOwn(result, "context"), false);
  }
});

test("transcript/registry/workflow/permission races reject projection and commit revalidation", async () => {
  for (const mutation of [
    (f) => { f.receipt = { ...f.receipt, generation: "replacement" }; },
    (f) => { f.registry = undefined; },
    (f) => { f.state = { ...f.state, revision: "new-revision" }; },
    (f) => { f.state.active = [f.workflow([], { changedWithoutRevision: true })]; },
    (f) => { f.denied = true; },
  ]) {
    const f = fixture();
    const adoption = await f.adopt();
    const projection = await f.controller.projectRoutingContext(adoption);
    f.native.onOpen = () => mutation(f);
    assert.equal((await f.controller.projectRoutingContext(adoption)).status, "unavailable");
    assert.equal((await f.controller.revalidateProjection(projection)).status, "unavailable");
  }
});

for (const phase of ["final projection read", "after projection", "commit revalidation read"]) {
  test(`message-level revocation during ${phase} fails closed with stable conversation authority`, async () => {
    for (const kind of ["direct", "group"]) {
      for (const entryId of ["current", "m3", "m4", "m1"]) {
        const f = fixture({ binding: kind === "group" ? {
          kind, peerId: "group-a", threadId: "thread-a", requesterId: "sender-a",
        } : {} });
        f.state.pending = [f.workflow(["m1"])];
        const adoption = await f.adopt();
        if (phase === "final projection read") {
          f.native.onWorkflowRead = (read) => { if (read === 2) f.deniedEntries.add(entryId); };
        }
        const projection = await f.controller.projectRoutingContext(adoption);
        if (phase === "final projection read") {
          assert.equal(projection.status, "unavailable", `${kind}:${entryId}`);
          assert.equal(projection.route, "main");
          assert.equal(Object.hasOwn(projection, "context"), false);
          assert.equal(Object.hasOwn(projection, "serialized"), false);
        } else {
          assert.equal(projection.status, "available");
          if (phase === "after projection") f.deniedEntries.add(entryId);
          else f.native.onWorkflowRead = () => { f.deniedEntries.add(entryId); };
          assert.equal((await f.controller.revalidateProjection(projection)).status, "unavailable", `${kind}:${entryId}`);
          assert.equal((await f.controller.projectRoutingContext(adoption)).status, "unavailable");
        }
        assert.equal(f.calls.model, 0);
      }
    }
  });
}

test("bounds never truncate required exact text or silently discard trusted dependencies", async () => {
  for (const mutate of [
    (f) => { f.entries[2].message.content = "😀".repeat(MAX_ROUTING_CONTEXT_BYTES / 4); },
    (f) => { f.state.active = [f.workflow([], { value: "x".repeat(MAX_ROUTING_WORKFLOW_BYTES) })]; },
    (f) => { f.state.pending = [f.workflow(Array(MAX_ROUTING_REFERENCES + 1).fill("m1"))]; },
    (f) => { f.entries[2].message.content = [{ type: "text", text: "one" }, { type: "text", text: "two" }]; },
  ]) {
    const f = fixture();
    mutate(f);
    const result = await f.controller.projectRoutingContext(await f.adopt());
    assert.equal(result.status, "unavailable");
    assert.equal(Object.hasOwn(result, "serialized"), false);
    assert.equal(f.calls.model, 0);
  }
});

test("projection byte ceiling accepts the exact boundary and rejects one more UTF-8 byte", async () => {
  const f = fixture();
  const adoption = await f.adopt();
  const before = await f.controller.projectRoutingContext(adoption);
  const oldBytes = Buffer.byteLength(f.entries[2].message.content, "utf8");
  f.entries[2].message.content = "x".repeat(MAX_ROUTING_CONTEXT_BYTES - before.byteLength + oldBytes - 2);
  // The old tab/newline were escaped in JSON; ASCII replacement removes those
  // two escape bytes. Account for the serialized representation, not characters.
  let projected = await f.controller.projectRoutingContext(adoption);
  assert.equal(projected.status, "available");
  f.entries[2].message.content += "x".repeat(MAX_ROUTING_CONTEXT_BYTES - projected.byteLength);
  projected = await f.controller.projectRoutingContext(adoption);
  assert.equal(projected.status, "available");
  assert.equal(projected.byteLength, MAX_ROUTING_CONTEXT_BYTES);
  f.entries[2].message.content += "x";
  assert.equal((await f.controller.projectRoutingContext(adoption)).reason, "routing_context_bounds");
});

test("compaction retains raw exact window; reset excludes earlier scope and references", async () => {
  const f = fixture();
  f.entries.splice(7, 0, { type: "compaction", id: "summary", parentId: "m7",
    summary: "LOSSY SUMMARY", firstKeptEntryId: "m7" });
  f.entries[8].parentId = "summary";
  const adoption = await f.adopt();
  assert.equal((await f.controller.projectRoutingContext(adoption)).context.previous.length, 5);
  f.entries.splice(7, 1, { type: "reset", id: "reset", parentId: "m7" });
  f.entries[8].parentId = "reset";
  const projection = await f.controller.projectRoutingContext(adoption);
  assert.equal(projection.status, "available");
  assert.deepEqual(projection.context.previous, []);
  assert.doesNotMatch(projection.serialized, /LOSSY SUMMARY/u);
  f.state.active = [f.workflow(["m1"])];
  assert.equal((await f.controller.projectRoutingContext(adoption)).status, "unavailable");
});

test("serialized authority, unadopted/blocked/mismatched input and aborted reads fail closed", async () => {
  const f = fixture();
  const adoption = await f.adopt();
  assert.equal((await f.controller.projectRoutingContext(JSON.parse(JSON.stringify(adoption)))).reason, "admission_not_issued");
  const projection = await f.controller.projectRoutingContext(adoption);
  assert.equal((await f.controller.revalidateProjection(JSON.parse(JSON.stringify(projection)))).reason, "projection_not_issued");
  const signal = AbortSignal.abort();
  assert.equal((await f.controller.projectRoutingContext(adoption, { signal })).status, "unavailable");
  f.source.sessionKey = "another-canonical-session";
  assert.equal((await f.adopt()).reason, "admission_binding_mismatch");
  f.source.sessionKey = f.binding.sessionKey;
  f.source.request = "normalized replacement";
  assert.equal((await f.adopt()).reason, "current_text_mismatch");
  f.source.request = "  now\t\n";
  f.recorder.isBlocked = () => true;
  assert.equal((await f.adopt()).reason, "admission_blocked");
  f.recorder.isBlocked = () => false;
  f.recorder.waitForRuntimePersistence = async () => { f.recorder.isBlocked = () => true; };
  assert.equal((await f.adopt()).reason, "admission_blocked");
});

test("P09 recorder uses native append receipt and refuses asynchronous/false authority", async () => {
  const f = fixture();
  const adoption = await f.adopt();
  const message = f.message("final", "assistant", "  final\t\n").message;
  message.idempotencyKey = "workflow-a:final";
  const result = await f.controller.appendFinal(adoption, message, () => {});
  assert.equal(result.status, "available");
  assert.equal(result.receipt.entryId, "final");
  const retained = await f.controller.verifyFinalReceipt(adoption, result.receipt, () => {});
  assert.equal(retained.status, "available");
  assert.deepEqual(retained.receipt, result.receipt);
  assert.equal(f.calls.append, 1);
  for (const authority of [undefined, async () => true, () => false]) {
    const rejected = await f.controller.appendFinal(adoption, message, authority);
    assert.equal(rejected.status, "unavailable");
    assert.equal(rejected.recovery, "native_custody");
    assert.equal(Object.hasOwn(rejected, "route"), false);
  }
  assert.equal(f.calls.append, 1);
  assert.equal(f.calls.model, 0);
});

test("final-message authorization revocation during hydration or fresh commit prevents append", async () => {
  for (const boundary of ["onOpen", "onBeforeFreshCommit"]) {
    const f = fixture();
    const adoption = await f.adopt();
    const message = f.message("final", "assistant", "  accepted final\t\n").message;
    message.idempotencyKey = "workflow-a:final";
    f.native[boundary] = () => {
      f.native.onAuthorize = (_binding, entry) => {
        if (entry?.message?.role === "assistant") throw new Error("final access revoked");
      };
    };
    const denied = await f.controller.appendFinal(adoption, message, () => {});
    assert.equal(denied.status, "unavailable", boundary);
    assert.equal(denied.recovery, "native_custody");
    assert.equal(Object.hasOwn(denied, "route"), false);
    assert.equal(f.calls.append, 0);
    assert.equal(f.entries.some((entry) => entry.id === "final"), false);
    assert.equal(f.calls.model, 0);
  }
});

test("rejected asynchronous authority fails closed without unhandled rejection", async () => {
  const unhandled = [];
  const observe = (error) => unhandled.push(error);
  process.on("unhandledRejection", observe);
  try {
    for (const reject of [
      async () => { throw new Error("asynchronous authority rejected"); },
      () => Promise.reject(new Error("returned authority promise rejected")),
      () => ({ then(_resolve, reject) { reject(new Error("authority thenable rejected")); } }),
    ]) {
      for (const boundary of ["conversation", "entry", "final"]) {
        const f = fixture();
        let result;
        if (boundary === "final") {
          const adoption = await f.adopt();
          const message = f.message("final", "assistant", "final").message;
          message.idempotencyKey = "workflow-a:final";
          result = await f.controller.appendFinal(adoption, message, reject);
        } else {
          f.native.onAuthorize = (_binding, entry) => {
            if (boundary === "conversation" || entry) return reject();
          };
          result = await f.adopt();
        }
        assert.equal(result.status, "unavailable", boundary);
        assert.equal(f.calls.append, 0);
        assert.equal(f.calls.model, 0);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(unhandled, [], boundary);
      }
    }
  } finally {
    process.removeListener("unhandledRejection", observe);
  }
});

test("final receipt verification rejects foreign/generation/role/permission evidence without appending", async () => {
  const f = fixture();
  const adoption = await f.adopt();
  const message = f.message("final", "assistant", "FINAL").message;
  message.idempotencyKey = "final-key";
  const final = await f.controller.appendFinal(adoption, message, () => {});
  for (const receipt of [
    { ...final.receipt, generation: "other-generation" },
    { ...final.receipt, storePath: "/other/account" },
    { ...final.receipt, sessionId: "other-session" },
    { ...final.receipt, entryId: "future" },
  ]) {
    const denied = await f.controller.verifyFinalReceipt(adoption, receipt, () => {});
    assert.equal(denied.status, "unavailable");
    assert.equal(denied.recovery, "native_custody");
    assert.equal(denied.mayHaveAppended, false);
    assert.equal(Object.hasOwn(denied, "route"), false);
  }
  f.native.onFinalVerify = () => { f.denied = true; };
  assert.equal((await f.controller.verifyFinalReceipt(adoption, final.receipt, () => {})).status, "unavailable");
  assert.equal(f.calls.append, 1);
  assert.equal(f.calls.model, 0);
});

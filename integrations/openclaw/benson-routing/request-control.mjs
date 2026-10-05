import { CONTROL_CONTRACT_VERSION, createTaskEnvelope } from "./envelope.mjs";

export const MAX_CLASSIFIER_REQUEST_BYTES = 8192;
export const ROUTING_PREVIOUS_MESSAGES = 5;
export const MAX_ROUTING_CONTEXT_BYTES = 32768;
export const MAX_ROUTING_WORKFLOW_BYTES = 8192;
export const MAX_ROUTING_REFERENCES = 16;
export const MAX_TRANSCRIPT_HYDRATION_BYTES = 1048576;
export const MAX_TRANSCRIPT_HYDRATION_EVENTS = 1024;
export const ROUTING_TRANSCRIPT_TIERS = Object.freeze([
  Object.freeze({ maxBytes: 262144, maxEvents: 256 }),
  Object.freeze({ maxBytes: 524288, maxEvents: 512 }),
  Object.freeze({ maxBytes: MAX_TRANSCRIPT_HYDRATION_BYTES, maxEvents: MAX_TRANSCRIPT_HYDRATION_EVENTS }),
]);
const TRANSCRIPT_LIMITS = Object.freeze({ maxBytes: MAX_TRANSCRIPT_HYDRATION_BYTES,
  // Native maxEvents excludes the header and an optionally injected boundary.
  maxEvents: MAX_TRANSCRIPT_HYDRATION_EVENTS - 2 });
const REASONS = new Set([
  "non_external", "command", "plugin_binding", "already_owned",
  "cancelled", "duplicate_or_recovery", "unsupported_input",
  "identity_unavailable", "non_main_owner", "empty_or_oversized",
]);
const FIELDS = ["schemaVersion", "kind", "reason", "requestId", "sessionKey", "request"];

function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

// This validator cannot authenticate its caller. The host admission owner must
// supply this record; model text and channel payloads are never accepted here.
export function projectRequestAdmission(nativeAdmission) {
  if (!plain(nativeAdmission) || Object.keys(nativeAdmission).length !== FIELDS.length ||
      !FIELDS.every((field) => Object.hasOwn(nativeAdmission, field)) ||
      nativeAdmission.schemaVersion !== CONTROL_CONTRACT_VERSION) {
    throw new TypeError("admission_shape_or_version");
  }
  const { kind, reason, requestId, sessionKey, request } = nativeAdmission;
  if (kind === "candidate") {
    if (reason !== null || !identifier(requestId) || !identifier(sessionKey) ||
        typeof request !== "string" || !request.trim() ||
        Buffer.byteLength(request, "utf8") > MAX_CLASSIFIER_REQUEST_BYTES) {
      throw new TypeError("candidate_admission_invalid");
    }
    return Object.freeze({
      kind: "candidate",
      trusted: Object.freeze({ requestId, sessionKey }),
      taskEnvelope: createTaskEnvelope(request),
    });
  }
  if (!["main_only", "bypass"].includes(kind) || !REASONS.has(reason) ||
      request !== null || (requestId !== null && !identifier(requestId)) ||
      (sessionKey !== null && !identifier(sessionKey))) {
    throw new TypeError("blocked_admission_invalid");
  }
  return Object.freeze({ kind, reason });
}

class ContextUnavailable extends Error {}
const unavailable = (reason) => Object.freeze({ status: "unavailable", route: "main", reason });
function requireContext(condition, reason) {
  if (!condition) throw new ContextUnavailable(reason);
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const part of Object.values(value)) freeze(part);
    Object.freeze(value);
  }
  return value;
}
function jsonCopy(value) {
  let nodes = 0;
  function check(part, depth) {
    requireContext(++nodes <= 2048 && depth <= 12, "metadata_bounds");
    if (part === null || typeof part === "string" || typeof part === "boolean") return;
    if (typeof part === "number") {
      requireContext(Number.isFinite(part), "metadata_invalid");
      return;
    }
    requireContext(Array.isArray(part) || plain(part), "metadata_invalid");
    for (const child of Object.values(part)) check(child, depth + 1);
  }
  check(value, 0);
  return JSON.parse(JSON.stringify(value));
}
function exactText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content) && message.content.length === 1 &&
      message.content[0]?.type === "text" && typeof message.content[0].text === "string") {
    return message.content[0].text;
  }
  throw new ContextUnavailable("exact_text_unavailable");
}

// Private O02/O03 adapter, supplied only by the trusted host. Dependencies are
// the public agent-sessions/session-store-runtime SDK methods, an authorization
// assertion and the O07 read-only workflow projection. No registration or store
// is created here. Serialized/model/channel records cannot recreate its handles.
export function createConversationContextController({
  SessionManager, getConversationSession, readTranscriptStatsSync, binding: suppliedBinding,
  assertAuthorized, readWorkflowState,
}) {
  const binding = freeze(jsonCopy(suppliedBinding));
  for (const field of ["agentId", "channel", "accountId", "peerId", "requesterId",
    "conversationRef", "sessionKey", "sessionId", "storePath"]) {
    requireContext(identifier(binding[field]), "conversation_identity_invalid");
  }
  requireContext(["direct", "group", "channel"].includes(binding.kind) &&
    (binding.threadId === null || identifier(binding.threadId)) &&
    typeof assertAuthorized === "function" && typeof readWorkflowState === "function",
  "conversation_authority_unavailable");
  const target = freeze(Object.fromEntries(["agentId", "sessionKey", "sessionId", "storePath"]
    .map((field) => [field, binding[field]])));
  const adopted = new WeakMap();
  const projections = new WeakMap();

  function checkTranscriptBudget() {
    requireContext(typeof readTranscriptStatsSync === "function", "transcript_stats_unavailable");
    const stats = readTranscriptStatsSync(target);
    if (stats && typeof stats.then === "function") Promise.resolve(stats).catch(() => {});
    requireContext(plain(stats) && [stats.sizeBytes, stats.eventCount, stats.maxSeq]
      .every((value) => Number.isSafeInteger(value) && value >= 0), "transcript_stats_unavailable");
    // Native stats omit the final newline; bounded hydration charges it too.
    requireContext(stats.sizeBytes + (stats.eventCount > 0 ? 1 : 0) <= TRANSCRIPT_LIMITS.maxBytes &&
      stats.eventCount <= MAX_TRANSCRIPT_HYDRATION_EVENTS, "transcript_hydration_bounds");
  }

  async function hydrate(read) {
    checkTranscriptBudget();
    const manager = await read();
    // Stats and hydration are separate snapshots. Native limits bound payload
    // reads during growth; the second preflight rejects a now-oversized target.
    checkTranscriptBudget();
    return manager;
  }

  function assertSync(assertion, ...args) {
    const result = assertion(...args);
    // Reject asynchronous authority while containing a rejected host Promise.
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
    requireContext(result === undefined || result === true, "synchronous_authority_unavailable");
  }

  function checkBinding() {
    assertSync(assertAuthorized, binding);
    const current = getConversationSession({ agentId: target.agentId, storePath: target.storePath, channel: binding.channel,
      accountId: binding.accountId, kind: binding.kind, peerId: binding.peerId,
      ...(binding.threadId === null ? {} : { threadId: binding.threadId }) });
    requireContext(current, "conversation_binding_unavailable");
    requireContext(current.sessionKey === target.sessionKey && current.sessionId === target.sessionId,
      "conversation_binding_changed");
  }
  function checkAnchor(anchor) {
    // SDK selection paths can differ from the SQLite path in a native receipt.
    // readSessionContext resolves the target and checks that database identity.
    requireContext(plain(anchor) && ["agentId", "sessionKey", "sessionId"].every((key) =>
      anchor[key] === target[key]) && identifier(anchor.storePath) && identifier(anchor.generation) && identifier(anchor.entryId) &&
      Number.isSafeInteger(anchor.rawSeq) && anchor.rawSeq > 0 &&
      Number.isSafeInteger(anchor.activeMessagePosition) && anchor.activeMessagePosition >= 0 &&
      (anchor.effectiveParentId === null || identifier(anchor.effectiveParentId)),
    "native_receipt_invalid");
  }
  function checkReceipt(receipt) {
    checkAnchor(receipt);
    requireContext(receipt.role === "user" && identifier(receipt.logicalTurnId), "native_receipt_invalid");
    SessionManager.readSessionContext(target, (_messages, header) => {
      requireContext(header?.id === target.sessionId, "native_context_unavailable");
    }, { admission: receipt });
  }
  function projectMessage(entry, current = false) {
    const message = entry?.message;
    requireContext(entry?.type === "message" && identifier(entry.id) &&
      ["user", "assistant"].includes(message?.role) && message.display !== false &&
      message.excludeFromContext !== true, "conversation_message_unavailable");
    const metadata = message.__openclaw;
    const transport = metadata?.transport;
    requireContext(transport?.conversationRef === binding.conversationRef &&
      transport.channel === binding.channel && (transport.threadId ?? null) === binding.threadId,
    "conversation_provenance_mismatch");
    let sender = null;
    if (message.role === "user") {
      requireContext(message.provenance === undefined || message.provenance?.kind === "external_user",
        "input_provenance_unavailable");
      const identity = metadata?.senderIdentity;
      if (identity !== undefined) {
        requireContext(["observation", "remote", "profile"].includes(identity.type) &&
          identifier(identity.id) && identity.id === metadata.senderId,
        "sender_provenance_unavailable");
        if (identity.type === "observation") {
          requireContext(identity.pluginId === binding.channel && identity.accountId === binding.accountId,
            "sender_provenance_mismatch");
        }
        sender = { source: "native_metadata", id: identity.id, identity: jsonCopy(identity),
          name: metadata.senderName ?? null, username: metadata.senderUsername ?? null };
      } else {
        requireContext(binding.kind === "direct" &&
          (metadata?.senderId === undefined || metadata.senderId === binding.peerId),
        "sender_provenance_unavailable");
        sender = { source: "canonical_peer_binding", id: binding.peerId,
          channel: binding.channel, accountId: binding.accountId };
      }
      requireContext(!current || sender.id === binding.requesterId, "requester_provenance_mismatch");
    }
    // Sender observations are attribution, never permission to steer a workflow.
    assertSync(assertAuthorized, binding, entry);
    return { entryId: entry.id, role: message.role, text: exactText(message), sender,
      inputProvenance: message.provenance === undefined ? null : jsonCopy(message.provenance) };
  }
  async function workflows(receipt) {
    const result = await readWorkflowState(binding, receipt);
    requireContext(result?.status === "available", "workflow_context_unavailable");
    requireContext(plain(result) && Object.keys(result).length === 4 &&
      identifier(result.revision) && Array.isArray(result.active) && Array.isArray(result.pending) &&
      result.active.length + result.pending.length <= MAX_ROUTING_REFERENCES, "workflow_context_invalid");
    const copy = jsonCopy(result);
    requireContext(Buffer.byteLength(JSON.stringify(copy), "utf8") <= MAX_ROUTING_WORKFLOW_BYTES,
      "workflow_context_bounds");
    const ids = new Set();
    let references = 0;
    for (const workflow of [...copy.active, ...copy.pending]) {
      requireContext(plain(workflow) && Object.keys(workflow).length === 3 &&
        identifier(workflow.workflowId) && !ids.has(workflow.workflowId) &&
        plain(workflow.metadata) && Array.isArray(workflow.turnReferences), "workflow_context_invalid");
      ids.add(workflow.workflowId);
      for (const reference of workflow.turnReferences) {
        requireContext(++references <= MAX_ROUTING_REFERENCES && plain(reference) && Object.keys(reference).length === 4 &&
          identifier(reference.entryId) && reference.conversationRef === binding.conversationRef &&
          reference.sessionId === target.sessionId && reference.generation === receipt.generation,
        "workflow_reference_unavailable");
      }
    }
    return copy;
  }
  async function guarded(run, failure = unavailable) {
    try { return await run(); }
    catch (error) {
      return failure(error instanceof ContextUnavailable ? error.message : "native_context_unavailable");
    }
  }
  function adoption(handle) {
    const record = adopted.get(handle);
    requireContext(record, "admission_not_issued");
    return record;
  }

  return Object.freeze({
    adoptCurrentTurn: (nativeAdmission, recorder, persistence = {}) => guarded(async () => {
      const admission = projectRequestAdmission(nativeAdmission);
      requireContext(admission.kind === "candidate", "admission_ineligible");
      requireContext(admission.trusted.sessionKey === target.sessionKey, "admission_binding_mismatch");
      checkBinding();
      requireContext(recorder && !recorder.isBlocked(), "admission_blocked");
      await recorder.waitForRuntimePersistence();
      checkBinding();
      requireContext(!recorder.isBlocked(), "admission_blocked");
      const message = await recorder.resolveMessage();
      checkBinding();
      requireContext(!recorder.isBlocked(), "admission_blocked");
      const proposed = projectMessage({ type: "message", id: "uncommitted", message }, true);
      requireContext(proposed.text === admission.taskEnvelope.request, "current_text_mismatch");
      const existing = recorder.getAdmissionReceipt();
      if (existing) checkReceipt(existing);
      else {
        // Atomic lifecycle expectations come from the native admission owner.
        requireContext(plain(persistence) && Object.keys(persistence).every((key) =>
          ["expectedSessionState", "sessionLifecyclePatch"].includes(key)) &&
          plain(persistence.expectedSessionState), "admission_state_unavailable");
        await recorder.persistApproved({ ...persistence, target, expectedSessionId: target.sessionId });
      }
      checkBinding();
      requireContext(!recorder.isBlocked(), "admission_blocked");
      const receipt = recorder.getAdmissionReceipt();
      checkReceipt(receipt);
      const currentEntry = freeze({ type: "message", id: receipt.entryId,
        message: jsonCopy(recorder.getPersistedMessage()) });
      requireContext(projectMessage(currentEntry, true).text === proposed.text, "current_text_mismatch");
      const handle = freeze({ status: "available", receipt: jsonCopy(receipt) });
      adopted.set(handle, { receipt: handle.receipt, request: proposed.text,
        requestId: admission.trusted.requestId, currentEntry });
      return handle;
    }),

    projectRoutingContext: (handle, { signal } = {}) => guarded(async () => {
      const record = adoption(handle);
      signal?.throwIfAborted();
      checkBinding();
      checkReceipt(record.receipt);
      const before = await workflows(record.receipt);
      signal?.throwIfAborted();
      checkBinding();
      checkReceipt(record.receipt);
      let manager, priorBranch, previousEntries, previous, truncated;
      for (const tier of ROUTING_TRANSCRIPT_TIERS) {
        signal?.throwIfAborted();
        checkBinding();
        checkReceipt(record.receipt);
        assertSync(assertAuthorized, binding, record.currentEntry);
        truncated = false;
        manager = await hydrate(() => {
          let reading;
          // Start synchronously inside the supported admission scope; the
          // native worker captures this same before-current fence each time.
          SessionManager.readSessionContext(target, (_messages, header) => {
            requireContext(header?.id === target.sessionId, "native_context_unavailable");
            reading = SessionManager.openBoundedAsync(target, { maxBytes: tier.maxBytes,
              maxEvents: tier.maxEvents - 2, signal, onTruncated: () => { truncated = true; } });
            // The synchronous transaction must not return a Promise. Contain
            // rejection even if its closing authority check subsequently fails.
            reading.catch(() => {});
          }, { admission: record.receipt });
          requireContext(reading, "native_cutoff_unavailable");
          return reading;
        });
        signal?.throwIfAborted();
        checkBinding();
        checkReceipt(record.receipt);
        assertSync(assertAuthorized, binding, record.currentEntry);
        requireContext(manager.getSessionId() === target.sessionId &&
          manager.getAppendParentId() === record.receipt.effectiveParentId, "native_cutoff_unavailable");
        const branch = manager.getBranch();
        requireContext(!branch.some((entry) => entry.id === record.receipt.entryId), "native_cutoff_unavailable");
        const reset = branch.findLastIndex((entry) => entry.type === "reset");
        priorBranch = branch.slice(reset + 1);
        // Native selection walks backwards and stops at the first budget
        // exclusion. Its active branch is a suffix, not a skip-and-fill sample.
        // Normalized parent links alone would not establish this guarantee.
        const conversationMessages = priorBranch.filter((entry) => entry.type === "message" &&
          ["user", "assistant"].includes(entry.message?.role) && entry.message.display !== false &&
          entry.message.excludeFromContext !== true &&
          (entry.message.provenance === undefined || entry.message.provenance?.kind === "external_user"));
        previousEntries = conversationMessages.slice(-ROUTING_PREVIOUS_MESSAGES);
        previous = previousEntries.map((entry) => projectMessage(entry));
        if (!truncated || previous.length === ROUTING_PREVIOUS_MESSAGES) break;
        if (tier !== ROUTING_TRANSCRIPT_TIERS.at(-1)) {
          requireContext(JSON.stringify(await workflows(record.receipt)) === JSON.stringify(before),
            "workflow_context_changed");
          signal?.throwIfAborted();
          checkBinding();
          checkReceipt(record.receipt);
          manager = priorBranch = previousEntries = previous = undefined;
        }
      }
      const currentEntry = record.currentEntry;
      const current = projectMessage(currentEntry, true);
      requireContext(current.text === record.request, "current_text_mismatch");
      const includedEntries = [currentEntry, ...previousEntries];
      const alreadyIncluded = new Set([current.entryId, ...previous.map((entry) => entry.entryId)]);
      const positions = new Map(priorBranch.map((entry, index) => [entry.id, index]));
      const referenced = new Map();
      for (const workflow of [...before.active, ...before.pending]) {
        for (const reference of workflow.turnReferences) {
          if (alreadyIncluded.has(reference.entryId) || referenced.has(reference.entryId)) continue;
          requireContext(positions.has(reference.entryId), "workflow_reference_unavailable");
          const entry = manager.getEntry(reference.entryId);
          referenced.set(reference.entryId, projectMessage(entry));
          includedEntries.push(entry);
        }
      }
      const older = [...referenced.values()].sort((a, b) => positions.get(a.entryId) - positions.get(b.entryId));
      const after = await workflows(record.receipt);
      signal?.throwIfAborted();
      checkBinding();
      checkReceipt(record.receipt);
      requireContext(JSON.stringify(before) === JSON.stringify(after), "workflow_context_changed");
      const context = { current, previous, older, workflow: before,
        history: { previousMessageCount: previous.length, historyTruncated: truncated },
        conversation: Object.fromEntries(["conversationRef", "channel", "accountId", "kind", "peerId",
          "threadId", "requesterId"].map((key) => [key, binding[key]])) };
      const serialized = JSON.stringify(context);
      const byteLength = Buffer.byteLength(serialized, "utf8");
      requireContext(byteLength <= MAX_ROUTING_CONTEXT_BYTES, "routing_context_bounds");
      for (const entry of includedEntries) assertSync(assertAuthorized, binding, entry);
      const projection = freeze({ status: "available", context, serialized, byteLength,
        cutoff: { admission: record.receipt, workflowRevision: before.revision } });
      projections.set(projection, { record, workflow: JSON.stringify(before), includedEntries });
      return projection;
    }),

    revalidateProjection: (projection) => guarded(async () => {
      const proof = projections.get(projection);
      requireContext(proof, "projection_not_issued");
      checkBinding();
      checkReceipt(proof.record.receipt);
      requireContext(JSON.stringify(await workflows(proof.record.receipt)) === proof.workflow,
        "workflow_context_changed");
      checkBinding();
      checkReceipt(proof.record.receipt);
      for (const entry of proof.includedEntries) assertSync(assertAuthorized, binding, entry);
      return Object.freeze({ status: "available" });
    }),

    // Recovery consumes a receipt already retained by P09's native owner. The
    // public through-anchor reader validates it without repeating the append.
    verifyFinalReceipt: (handle, retainedReceipt, assertCurrent) => guarded(async () => {
      const record = adoption(handle);
      const receipt = freeze(jsonCopy(retainedReceipt));
      checkAnchor(receipt);
      requireContext(receipt.storePath === record.receipt.storePath &&
        receipt.generation === record.receipt.generation && receipt.rawSeq > record.receipt.rawSeq &&
        typeof assertCurrent === "function", "native_final_receipt_invalid");
      checkBinding();
      checkReceipt(record.receipt);
      assertSync(assertCurrent);
      const manager = await hydrate(() => SessionManager.openModelContextAsync(target,
        { through: receipt, limits: TRANSCRIPT_LIMITS }));
      const entry = manager.getEntry(receipt.entryId);
      requireContext(entry?.message?.role === "assistant", "native_final_receipt_invalid");
      projectMessage(entry);
      checkBinding();
      checkReceipt(record.receipt);
      assertSync(assertCurrent);
      return freeze({ status: "available", entryId: receipt.entryId, receipt });
    }, (reason) => Object.freeze({ status: "unavailable", reason, recovery: "native_custody",
      mayHaveAppended: false })),

    // P09 supplies its accepted exact assistant message, durable idempotency key
    // and synchronous final-ownership assertion. O02 only records native custody.
    appendFinal: (handle, message, assertCurrent) => {
      let writeAttempted = false;
      return guarded(async () => {
        const record = adoption(handle);
        requireContext(message?.role === "assistant" && identifier(message.idempotencyKey) &&
          typeof assertCurrent === "function", "final_authority_unavailable");
        const copy = jsonCopy(message);
        const candidateEntry = { type: "message", id: "uncommitted-final", message: copy };
        const proposed = projectMessage(candidateEntry);
        const assertFinal = () => {
          checkBinding();
          checkReceipt(record.receipt);
          assertSync(assertAuthorized, binding, candidateEntry);
          assertSync(assertCurrent);
        };
        assertFinal();
        const manager = await hydrate(() => SessionManager.openAsync(target, undefined, TRANSCRIPT_LIMITS));
        assertFinal();
        writeAttempted = true;
        const result = manager.appendMessageWithTranscriptAnchor(copy, { beforeFreshMessageCommit: assertFinal });
        checkAnchor(result.anchor);
        requireContext(result.anchor.generation === record.receipt.generation &&
          result.anchor.storePath === record.receipt.storePath, "native_final_receipt_invalid");
        requireContext(exactText(result.message) === proposed.text, "native_final_text_mismatch");
        return freeze({ status: "available", entryId: result.entryId, appended: result.appended,
          receipt: jsonCopy(result.anchor) });
      }, (reason) => Object.freeze({ status: "unavailable", reason,
        recovery: "native_custody", mayHaveAppended: writeAttempted }));
    },
  });
}

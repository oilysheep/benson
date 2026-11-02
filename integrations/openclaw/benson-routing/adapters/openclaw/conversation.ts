import { isDeepStrictEqual } from 'node:util';
import { ConversationTurnSchema, type ConversationBinding, type ConversationTurn } from '../../core/conversation-context.js';
import { MAX_ROUTING_CONTEXT_BYTES, MAX_TRANSCRIPT_HYDRATION_BYTES, MAX_TRANSCRIPT_HYDRATION_EVENTS } from '../../core/request-control.js';
import { assertion, decode, fail, freeze, identifier, plain, synchronous } from '../../core/value.js';
import { validateDomainResultEnvelope, readDomainFactsData } from '../../core/domain-result.js';
import type { AnyDomainResult } from '../../core/contracts.js';
import { parseTaskEnvelope } from '../../core/task-envelope.js';

type Target = Readonly<{ agentId: 'main'; sessionKey: string; sessionId: string }>;
type Write = Readonly<{ id: string; message: Record<string, unknown> }>;
/** Private authorized-originals projection, not a complete conversation,
 * recorder admission, workflow state or grant. Positively identified foreign
 * sources are excluded; missing/contradictory metadata is unavailable.
 * Domain owners must separately acquire validated pending results and authorize
 * their use. No transcript cursor or SDK object crosses this adapter boundary.
 */
export interface NativeOriginalUserTurns {
  readonly turns: readonly Readonly<ConversationTurn>[];
  acquireTaskResults(currentCallId?: string): Promise<NativeOriginalTaskResults>;
  assertCurrent(): void;
}
/** Original Task results, not pending selection, absence of workflow,
 * execution evidence or continuation authority. Domain owners validate and
 * select pending from the full ordered collection, including clearing results.
 * Any transcript append retires this exact snapshot, including own appends.
 */
export interface NativeOriginalTaskResults {
  readonly results: readonly Readonly<{ input: ConversationTurn; requestId: string; entryId: string;
    callEntryId: string; toolCallId: string; toolName: 'reminder_task' | 'jessica_task'; arguments: unknown; result: AnyDomainResult }>[];
  assertCurrent(): void;
  /** Original-source read custody across own native appends and Task retirement;
   * grants no execution and still rejects a new user input or replaced source. */
  assertRetainedCurrent(): void;
}
type Readers = {
  visible(target: Target & { maxMessages: number; maxBytes: number }): Promise<unknown>;
  raw?(target: Target & { cursor?: string; maxEvents: number; maxBytes: number }): Promise<unknown>;
  context(target: Target, read: (messages: Iterable<unknown>, header: unknown, version: unknown) => unknown): unknown;
};
function requireSource(value: unknown): asserts value { if (!value) fail('native_original_context_unavailable'); }
function text(message: Record<string, unknown>): string {
  const content = message.content;
  const value = typeof content === 'string' ? content : Array.isArray(content) && content.length === 1 &&
    plain(content[0]) && content[0].type === 'text' ? content[0].text : undefined;
  requireSource(typeof value === 'string' && value.trim()); return value;
}
function original(message: Record<string, unknown>) {
  // Compare the exact original source fields, retaining absent provenance. A
  // hook observation is only a candidate until both persisted readers agree.
  return { content: message.content, provenance: message.provenance, metadata: message.__openclaw };
}
function metadata(message: Record<string, unknown>) {
  const meta = message.__openclaw;
  requireSource(plain(meta) && plain(meta.transport));
  const messageId = meta.transport.messageId;
  requireSource(message.role === 'user' && message.excludeFromContext !== true && meta.lateMedia !== true &&
    (!Object.hasOwn(message, 'provenance') || plain(message.provenance) && message.provenance.kind === 'external_user'));
  requireSource(plain(meta.senderIdentity) && meta.senderIdentity.type === 'observation' &&
    identifier(meta.senderId) && meta.senderIdentity.id === meta.senderId && identifier(meta.senderIdentity.pluginId) &&
    identifier(meta.senderIdentity.accountId) && meta.senderIdentity.pluginId === meta.transport.channel &&
    identifier(meta.transport.conversationRef) && identifier(messageId));
  return { meta, transport: meta.transport, identity: meta.senderIdentity, messageId };
}
export function retainOriginalUserWrite(message: unknown, source: {
  requestId: string; request: string; senderId: string; accountId: string;
}): Write {
  requireSource(plain(message) && identifier(message.idempotencyKey));
  const { transport, identity, meta } = metadata(message);
  requireSource(transport.channel === 'whatsapp' && identifier(transport.conversationRef) &&
    transport.messageId === source.requestId && meta.senderId === source.senderId &&
    identity.pluginId === 'whatsapp' && identity.accountId === source.accountId && text(message) === source.request);
  requireSource(Buffer.byteLength(JSON.stringify(message), 'utf8') <= MAX_TRANSCRIPT_HYDRATION_BYTES);
  return freeze({ id: message.idempotencyKey, message: structuredClone(message) });
}
// The installed public synchronous reader hydrates before applying our bounds.
// Keep native history unavailable until a supported same-snapshot bounded
// custody API is proven. Explicit readers are the existing isolated test port;
// production callers must never infer empty history from this rejection.
export async function acquireOriginalUserTurns(options: {
  target: Target; binding: Readonly<ConversationBinding>; request: string; write: Write;
  assertCurrent(): unknown;
}, readers?: Readers): Promise<NativeOriginalUserTurns> {
  const current = () => assertion(options.assertCurrent(), 'native_original_context_authority');
  current();
  const target = freeze({ ...options.target }), binding = freeze({ ...options.binding }), write = options.write, request = options.request;
  requireSource(target.agentId === 'main' && identifier(target.sessionId) && identifier(target.sessionKey) &&
    binding.channel === 'whatsapp' && binding.conversationRef === target.sessionKey);
  if (!readers) fail('native_original_history_resource_bounds_unavailable');
  const sdk = readers; current();
  const page: unknown = await sdk.visible({ ...target, maxMessages: MAX_TRANSCRIPT_HYDRATION_EVENTS - 2,
    maxBytes: MAX_TRANSCRIPT_HYDRATION_BYTES }); current();
  // One bounded active-path window, collected twice around the initial sync
  // generation snapshot. A partial projection is never empty history.
  requireSource(plain(page) && page.kind === 'page' && page.hasMore === false && Array.isArray(page.entries) &&
    page.entries.length <= MAX_TRANSCRIPT_HYDRATION_EVENTS - 2 && Number.isSafeInteger(page.serializedBytes) &&
    Number(page.serializedBytes) >= 0 && Number(page.serializedBytes) <= MAX_TRANSCRIPT_HYDRATION_BYTES);
  const entries = page.entries;
  const matches = entries.filter((entry: unknown) => plain(entry) && plain(entry.message) && entry.message.idempotencyKey === write.id);
  requireSource(matches.length === 1);
  const selected = matches[0]; requireSource(plain(selected) && plain(selected.message) && identifier(selected.entryId));
  requireSource(isDeepStrictEqual(original(selected.message), original(write.message)) && text(selected.message) === request);
  const position = entries.indexOf(selected), prefix = freeze(structuredClone(entries.slice(0, position + 1)));
  requireSource(prefix.every((entry: unknown) => plain(entry) && identifier(entry.entryId) && plain(entry.message)) &&
    new Set(prefix.map(entry => entry.entryId)).size === prefix.length);
  const anchor = metadata(write.message).transport;
  const turns: ConversationTurn[] = [];
  const userKeys = new Set<string>(), transportIds = new Set<string>();
  for (const entry of prefix) {
    const message = entry.message as Record<string, unknown>;
    if (message.role !== 'user') continue;
    const { meta, transport, identity, messageId } = metadata(message);
    if (transport.channel !== binding.channel || transport.conversationRef !== anchor.conversationRef ||
      (transport.threadId ?? null) !== binding.threadId || meta.senderId !== binding.requesterId ||
      identity.accountId !== binding.accountId) continue;
    requireSource(identifier(message.idempotencyKey) && !userKeys.has(message.idempotencyKey) && !transportIds.has(messageId));
    userKeys.add(message.idempotencyKey); transportIds.add(messageId);
    turns.push(decode(ConversationTurnSchema, { entryId: entry.entryId, role: 'user', text: text(message),
      sender: { source: 'native_metadata', id: binding.requesterId, identity: { ...identity },
        name: meta.senderName ?? null, username: meta.senderUsername ?? null },
      inputProvenance: Object.hasOwn(message, 'provenance') ? message.provenance : null }, 'native_original_context_unavailable'));
  }
  requireSource(turns.length > 0 && turns.at(-1)?.entryId === selected.entryId);
  requireSource(Buffer.byteLength(JSON.stringify(turns), 'utf8') <= MAX_ROUTING_CONTEXT_BYTES);
  // Keep the full native message prefix, including tool results, for custody.
  // Domain text projection never turns model reports into execution evidence.
  const expected = structuredClone(prefix.map(entry => entry.message));
  let generation: string | undefined;
  const revalidate = (strict?: { messages: readonly unknown[]; rawSeq: number }) => {
    current();
    let callbacks = 0;
    const checked = synchronous(sdk.context(target, (messages, header, version) => {
      requireSource(++callbacks === 1);
      requireSource(plain(header) && header.id === target.sessionId && plain(version) && identifier(version.generation));
      if (generation !== undefined) requireSource(version.generation === generation);
      if (strict) requireSource(version.rawSeq === strict.rawSeq);
      const retained = strict?.messages ?? expected;
      let count = 2, bytes = Buffer.byteLength(JSON.stringify(header), 'utf8') + 1, index = 0;
      for (const raw of messages) {
        requireSource(++count <= MAX_TRANSCRIPT_HYDRATION_EVENTS);
        bytes += Buffer.byteLength(JSON.stringify(raw), 'utf8') + 1;
        requireSource(bytes <= MAX_TRANSCRIPT_HYDRATION_BYTES && plain(raw));
        if (index < retained.length) requireSource(isDeepStrictEqual(raw, retained[index++]));
        else requireSource(!strict && raw.role !== 'user'); // Own appends retire Task snapshots; user custody permits them.
      }
      requireSource(index === retained.length);
      generation ??= version.generation;
      return true;
    }), 'native_original_context_must_be_synchronous');
    requireSource(checked === true && callbacks === 1 && generation !== undefined); current();
  };
  revalidate();
  const repeated: unknown = await sdk.visible({ ...target, maxMessages: MAX_TRANSCRIPT_HYDRATION_EVENTS - 2,
    maxBytes: MAX_TRANSCRIPT_HYDRATION_BYTES }); current();
  requireSource(plain(repeated) && repeated.kind === 'page' && repeated.hasMore === false && Array.isArray(repeated.entries) &&
    repeated.entries.length <= MAX_TRANSCRIPT_HYDRATION_EVENTS - 2 && Number.isSafeInteger(repeated.serializedBytes) &&
    Number(repeated.serializedBytes) >= 0 && Number(repeated.serializedBytes) <= MAX_TRANSCRIPT_HYDRATION_BYTES &&
    isDeepStrictEqual(repeated.entries.slice(0, prefix.length), prefix));
  // The second native identity read closes acquisition races. Later reads use
  // native generation plus the exact retained message prefix, never rawSeq.
  revalidate();
  return freeze({ turns, assertCurrent: () => revalidate(), async acquireTaskResults(currentCallId?: string): Promise<NativeOriginalTaskResults> {
    requireSource(currentCallId === undefined || identifier(currentCallId));
    revalidate(); requireSource(sdk.raw);
    const limits = { ...target, maxEvents: MAX_TRANSCRIPT_HYDRATION_EVENTS, maxBytes: MAX_TRANSCRIPT_HYDRATION_BYTES };
    const raw: unknown = await sdk.raw(limits); revalidate();
    requireSource(plain(raw) && raw.kind === 'page' && raw.hasMore === false && Array.isArray(raw.events) &&
      raw.events.length > 0 && raw.events.length <= limits.maxEvents && typeof raw.cursor === 'string' && raw.cursor.length > 0 &&
      Number.isSafeInteger(raw.serializedBytes) && Number(raw.serializedBytes) >= 0 && Number(raw.serializedBytes) <= limits.maxBytes);
    const rows: { entryId: string; message: Record<string, unknown> }[] = [];
    let lastSeq = -1, parent: string | null = null, bytes = 0;
    const ids = new Set<string>();
    for (const [index, item] of raw.events.entries()) {
      requireSource(plain(item) && Number.isSafeInteger(item.seq) && Number(item.seq) > lastSeq && plain(item.event));
      lastSeq = Number(item.seq); const event = item.event;
      bytes += Buffer.byteLength(JSON.stringify(event), 'utf8') + 1; requireSource(bytes <= limits.maxBytes);
      if (index === 0) { requireSource(event.type === 'session' && event.id === target.sessionId); continue; }
      // A complete linear native history only. Resets, branches, compaction,
      // custom messages and unknown control semantics are unavailable here.
      requireSource(['message', 'thinking_level_change', 'model_change', 'custom'].includes(String(event.type)) &&
        identifier(event.id) && !ids.has(event.id) && event.parentId === parent);
      ids.add(event.id); parent = event.id;
      if (event.type === 'message') {
        requireSource(plain(event.message)); rows.push({ entryId: event.id, message: structuredClone(event.message) });
      }
    }
    const cutoff = rows.findIndex(row => row.entryId === selected.entryId);
    requireSource(cutoff >= 0 && isDeepStrictEqual(rows.slice(0, cutoff + 1), prefix.map(entry => ({ entryId: entry.entryId, message: entry.message }))));
    const strict = freeze({ messages: rows.map(row => row.message), rawSeq: lastSeq });
    // rawSeq is a change detector within a native snapshot, never admission or
    // execution authority. The opaque cursor independently detects replacement.
    revalidate(strict);
    const resumed: unknown = await sdk.raw({ ...limits, cursor: raw.cursor });
    requireSource(plain(resumed) && resumed.kind === 'page' && resumed.hasMore === false &&
      Array.isArray(resumed.events) && resumed.events.length === 0 && resumed.cursor === raw.cursor);
    revalidate(strict);
    const authorized = new Map(turns.map(turn => [turn.entryId, turn]));
    const results: NativeOriginalTaskResults['results'][number][] = [];
    type Call = { entryId: string; name: string; args: unknown; inputId: string | undefined; requestId: string | undefined; settled: boolean };
    const calls = new Map<string, Call>();
    let inputId: string | undefined, requestId: string | undefined;
    for (const row of rows) {
      const message = row.message;
      if (message.role === 'user') {
        // Native call IDs can repeat across requests/Runs. A new original
        // input may start only after every preceding call has its result.
        requireSource([...calls.values()].every(call => call.settled)); calls.clear();
        inputId = row.entryId; requestId = metadata(message).messageId;
      } else if (message.role === 'assistant' && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!plain(block) || block.type !== 'toolCall') continue;
          requireSource(identifier(block.id) && identifier(block.name) && !calls.has(block.id));
          calls.set(block.id, { entryId: row.entryId, name: block.name, args: structuredClone(block.arguments), inputId, requestId, settled: false });
        }
      } else if (message.role === 'toolResult') {
        requireSource(identifier(message.toolCallId));
        const call = calls.get(message.toolCallId);
        requireSource(call && !call.settled && call.name === message.toolName); call.settled = true;
        if (call.name !== 'reminder_task' && call.name !== 'jessica_task') continue;
        requireSource(call.inputId === inputId && identifier(call.requestId) && message.isError === false &&
          Array.isArray(message.content) && message.content.length === 1 && plain(message.content[0]) &&
          message.content[0].type === 'text' && typeof message.content[0].text === 'string');
        const result = validateDomainResultEnvelope(message.details);
        requireSource(isDeepStrictEqual(validateDomainResultEnvelope(JSON.parse(message.content[0].text)), result) &&
          result.domain === (call.name === 'reminder_task' ? 'reminder' : 'jessica-vacuum'));
        const input = call.inputId ? authorized.get(call.inputId) : undefined;
        if (!input) continue; // Positively identified foreign source, not clearing for this requester.
        const consumed = readDomainFactsData(result.facts.data).consumedPending;
        if (result.pendingContext !== null || consumed !== null) {
          requireSource(result.executionMode === 'agentic' && plain(call.args) &&
            parseTaskEnvelope(JSON.stringify(call.args)).request === input.text);
          if (consumed !== null) {
            const envelope = parseTaskEnvelope(JSON.stringify(call.args));
            requireSource(envelope.version === 2 && isDeepStrictEqual(envelope.pending, consumed));
          }
        }
        results.push({ input, requestId: call.requestId, entryId: row.entryId, callEntryId: call.entryId, toolCallId: message.toolCallId,
          toolName: call.name, arguments: call.args, result });
      }
    }
    // The trusted native invocation may identify its own currently executing
    // Task. Every other call must be accounted for, including later results
    // under this same user input that can replace or clear earlier pending.
    if (currentCallId !== undefined) {
      const own = calls.get(currentCallId);
      requireSource(own && !own.settled && own.inputId === selected.entryId &&
        (own.name === 'reminder_task' || own.name === 'jessica_task'));
    }
    requireSource([...calls].every(([id, call]) => call.settled || id === currentCallId));
    const snapshot = freeze(structuredClone(results));
    return freeze({ results: snapshot, assertCurrent() { revalidate(strict); }, assertRetainedCurrent() { revalidate(); } });
  } });
}

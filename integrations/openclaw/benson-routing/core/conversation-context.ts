import Type, { type Static } from 'typebox';
import { isDeepStrictEqual } from 'node:util';
import { object, nullable, IdentifierSchema as Id, ContextJsonSchema, decode, exact, freeze,
  identifier, plain, assertion, synchronous } from './value.js';
import { ROUTING_PREVIOUS_MESSAGES, MAX_ROUTING_CONTEXT_BYTES, MAX_ROUTING_WORKFLOW_BYTES,
  MAX_ROUTING_REFERENCES, ROUTING_TRANSCRIPT_TIERS } from './request-control.js';

export const ConversationBindingSchema = object({ conversationRef: Id, channel: Id, accountId: Id,
  kind: Type.Enum(['direct', 'group', 'channel']), peerId: Id, threadId: nullable(Id), requesterId: Id });
export const ConversationCutoffSchema = object({ sessionId: Id, generation: Id, entryId: Id, effectiveParentId: nullable(Id) });
const SenderIdentitySchema = Type.Intersect([
  Type.Object({ type: Type.Enum(['observation', 'remote', 'profile']), id: Id }),
  Type.Record(Type.String(), ContextJsonSchema),
]);
const SenderSchema = Type.Union([
  object({ source: Type.Literal('native_metadata'), id: Id, identity: SenderIdentitySchema,
    name: ContextJsonSchema, username: ContextJsonSchema }),
  object({ source: Type.Literal('canonical_peer_binding'), id: Id, channel: Id, accountId: Id }),
]);
export const ConversationTurnSchema = object({ entryId: Id, role: Type.Enum(['user', 'assistant']), text: Type.String(),
  sender: nullable(SenderSchema), inputProvenance: nullable(Type.Intersect([
    Type.Object({ kind: Type.Literal('external_user') }), Type.Record(Type.String(), ContextJsonSchema),
  ])) });
const ReferenceSchema = object({ entryId: Id, conversationRef: Id, sessionId: Id, generation: Id });
const WorkflowEntrySchema = object({ workflowId: Id, metadata: Type.Record(Type.String(), ContextJsonSchema),
  turnReferences: Type.Array(ReferenceSchema, { maxItems: MAX_ROUTING_REFERENCES }) });
const WorkflowSchema = object({ status: Type.Literal('available'), revision: Id,
  active: Type.Array(WorkflowEntrySchema, { maxItems: MAX_ROUTING_REFERENCES }),
  pending: Type.Array(WorkflowEntrySchema, { maxItems: MAX_ROUTING_REFERENCES }) });
const SnapshotSchema = Type.Union([
  object({ status: Type.Literal('unavailable'), reason: Id }),
  object({ status: Type.Literal('available'), cutoff: ConversationCutoffSchema,
    beforeCurrent: Type.Literal(true), branchSuffix: Type.Literal(true), historyTruncated: Type.Boolean(),
    entries: Type.Array(Type.Union([ConversationTurnSchema, object({ kind: Type.Literal('reset') })]), { maxItems: 1024 }) }),
]);
export type ConversationBinding = Static<typeof ConversationBindingSchema>;
export type ConversationCutoff = Static<typeof ConversationCutoffSchema>;
export type ConversationTurn = Static<typeof ConversationTurnSchema>;
type Workflow = Static<typeof WorkflowSchema>;
type Tier = typeof ROUTING_TRANSCRIPT_TIERS[number];
/** Adapter-private custody normalizes exact authorized external conversation turns.
 * No raw session, recorder, store path, persistence or SDK object crosses this Port.
 * beforeCurrent/branchSuffix require native proof; parent links alone do not suffice.
 */
export interface ConversationEvidence {
  readonly request: string;
  readonly binding: ConversationBinding;
  readonly cutoff: ConversationCutoff;
  currentTurn(): unknown;
  assertCurrent(): unknown;
  assertAuthorized(turn: Readonly<ConversationTurn>): unknown;
  readBefore(tier: Tier, signal?: AbortSignal): Promise<unknown>;
  readWorkflow(): Promise<unknown>;
}
class ContextUnavailable extends Error {}
function requireContext(value: unknown, reason: string): asserts value { if (!value) throw new ContextUnavailable(reason); }
/** Preserve the distinct conversation metadata budget, without JSON coercion. */
function metadataCopy(value: unknown): unknown {
  let nodes = 0;
  function copy(part: unknown, depth: number): unknown {
    requireContext(++nodes <= 2048 && depth <= 12, 'metadata_bounds');
    if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
    if (typeof part === 'number') { requireContext(Number.isFinite(part), 'metadata_invalid'); return part; }
    requireContext(Array.isArray(part) || plain(part), 'metadata_invalid');
    const keys = Object.keys(part);
    requireContext(Reflect.ownKeys(part).length === keys.length + (Array.isArray(part) ? 1 : 0) &&
      keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(part, key) ?? {}, 'value')), 'metadata_invalid');
    if (Array.isArray(part)) { requireContext(keys.length === part.length, 'metadata_invalid'); return part.map((child: unknown) => copy(child, depth + 1)); }
    const result: Record<string, unknown> = {}; Object.setPrototypeOf(result, null);
    for (const [key, child] of Object.entries(part)) result[key] = copy(child, depth + 1);
    return result;
  }
  return copy(value, 0);
}
function assertSync(value: unknown): void {
  assertion(value, 'synchronous_authority_unavailable');
}
function turn(value: unknown): ConversationTurn {
  // A turn's exact text has only the final context byte bound, never truncation.
  exact(value, Object.keys(ConversationTurnSchema.properties), 'conversation_message_unavailable');
  const decoded = decode(ConversationTurnSchema, { ...value, sender: metadataCopy(value.sender),
    inputProvenance: metadataCopy(value.inputProvenance) }, 'conversation_message_unavailable');
  requireContext(identifier(decoded.entryId), 'conversation_message_unavailable');
  return freeze(decoded);
}
export interface ContextProjection {
  readonly status: 'available';
  readonly context: Readonly<{ current: ConversationTurn; previous: ConversationTurn[]; older: ConversationTurn[];
    workflow: Workflow; history: { previousMessageCount: number; historyTruncated: boolean }; conversation: ConversationBinding }>;
  readonly serialized: string;
  readonly byteLength: number;
  readonly cutoff: Readonly<{ admission: ConversationCutoff; workflowRevision: string }>;
}
export interface UnavailableContext { readonly status: 'unavailable'; readonly route: 'main'; readonly reason: string }
export function createRoutingContextController(evidence: ConversationEvidence) {
  const binding = freeze({ ...decode(ConversationBindingSchema, metadataCopy(evidence.binding), 'conversation_identity_invalid') });
  const cutoff = freeze({ ...decode(ConversationCutoffSchema, metadataCopy(evidence.cutoff), 'native_receipt_invalid') });
  for (const value of [...Object.values(binding).filter(part => part !== null), ...Object.values(cutoff).filter(part => part !== null)]) {
    requireContext(identifier(value), 'conversation_identity_invalid');
  }
  const issued = new WeakMap<ContextProjection, { workflow: string; included: ConversationTurn[] }>();
  function current(): void { assertSync(evidence.assertCurrent()); }
  function authorized(entry: ConversationTurn): void {
    if (entry.role === 'assistant') requireContext(entry.sender === null, 'sender_provenance_unavailable');
    else {
      const sender = entry.sender; requireContext(sender && identifier(sender.id), 'sender_provenance_unavailable');
      if (sender.source === 'native_metadata') {
        requireContext(identifier(sender.identity.id) && sender.id === sender.identity.id, 'sender_provenance_unavailable');
        if (sender.identity.type === 'observation') requireContext(sender.identity.pluginId === binding.channel &&
          sender.identity.accountId === binding.accountId, 'sender_provenance_mismatch');
      } else requireContext(binding.kind === 'direct' && sender.id === binding.peerId && sender.channel === binding.channel &&
        sender.accountId === binding.accountId, 'sender_provenance_mismatch');
    }
    assertSync(evidence.assertAuthorized(entry));
  }
  async function workflow(): Promise<Workflow> {
    current(); const raw = await evidence.readWorkflow(); current();
    const copy = metadataCopy(raw);
    requireContext(plain(copy) && copy.status === 'available', 'workflow_context_unavailable');
    const w = decode(WorkflowSchema, copy, 'workflow_context_invalid');
    requireContext(identifier(w.revision) && w.active.length + w.pending.length <= MAX_ROUTING_REFERENCES, 'workflow_context_invalid');
    requireContext(Buffer.byteLength(JSON.stringify(w), 'utf8') <= MAX_ROUTING_WORKFLOW_BYTES, 'workflow_context_bounds');
    let references = 0; const ids = new Set<string>();
    for (const item of [...w.active, ...w.pending]) {
      requireContext(identifier(item.workflowId) && !ids.has(item.workflowId), 'workflow_context_invalid'); ids.add(item.workflowId);
      for (const reference of item.turnReferences) {
        requireContext(++references <= MAX_ROUTING_REFERENCES && identifier(reference.entryId) &&
          reference.conversationRef === binding.conversationRef && reference.sessionId === cutoff.sessionId &&
          reference.generation === cutoff.generation, 'workflow_reference_unavailable');
      }
    }
    return freeze(w);
  }
  async function guarded<T>(run: () => Promise<T>): Promise<T | UnavailableContext> {
    try { return await run(); } catch (error) {
      return freeze({ status: 'unavailable', route: 'main', reason: error instanceof ContextUnavailable ? error.message : 'native_context_unavailable' } satisfies UnavailableContext);
    }
  }
  return freeze({
    projectRoutingContext({ signal }: { signal?: AbortSignal } = {}): Promise<ContextProjection | UnavailableContext> {
      return guarded(async () => {
        signal?.throwIfAborted(); current();
        requireContext(typeof evidence.request === 'string' && evidence.request.trim() && Buffer.byteLength(evidence.request, 'utf8') <= 8192, 'current_text_mismatch');
        const currentTurn = turn(synchronous(evidence.currentTurn(), 'synchronous_authority_unavailable'));
        requireContext(currentTurn.text === evidence.request, 'current_text_mismatch');
        requireContext(currentTurn.entryId === cutoff.entryId && currentTurn.role === 'user' && currentTurn.sender !== null &&
          currentTurn.sender.id === binding.requesterId, 'requester_provenance_mismatch'); authorized(currentTurn);
        const before = await workflow();
        let selected: { branch: ConversationTurn[]; previous: ConversationTurn[]; truncated: boolean } | undefined;
        for (const tier of ROUTING_TRANSCRIPT_TIERS) {
          signal?.throwIfAborted(); current(); authorized(currentTurn);
          const raw = await evidence.readBefore(tier, signal); signal?.throwIfAborted(); current(); authorized(currentTurn);
          const snapshot = decode(SnapshotSchema, raw, 'native_cutoff_unavailable');
          requireContext(snapshot.status === 'available', 'native_context_unavailable');
          requireContext(isDeepStrictEqual(metadataCopy(snapshot.cutoff), metadataCopy(cutoff)), 'native_cutoff_unavailable');
          // The native adapter owns payload/event accounting including header/newline.
          requireContext(snapshot.entries.length <= tier.maxEvents - 2, 'transcript_hydration_bounds');
          const reset = snapshot.entries.findLastIndex(entry => 'kind' in entry);
          const branch = snapshot.entries.slice(reset + 1).map(turn);
          requireContext(!branch.some(entry => entry.entryId === cutoff.entryId), 'native_cutoff_unavailable');
          requireContext(new Set(branch.map(entry => entry.entryId)).size === branch.length, 'native_cutoff_unavailable');
          const previous = branch.slice(-ROUTING_PREVIOUS_MESSAGES);
          selected = { branch, previous, truncated: snapshot.historyTruncated };
          if (!selected.truncated || previous.length === ROUTING_PREVIOUS_MESSAGES) break;
          if (tier !== ROUTING_TRANSCRIPT_TIERS.at(-1)) {
            requireContext(JSON.stringify(await workflow()) === JSON.stringify(before), 'workflow_context_changed');
          }
        }
        requireContext(selected, 'native_context_unavailable');
        const positions = new Map(selected.branch.map((entry, index) => [entry.entryId, index]));
        const includedIds = new Set([currentTurn.entryId, ...selected.previous.map(entry => entry.entryId)]);
        const references = new Set([...before.active, ...before.pending].flatMap(item => item.turnReferences.map(ref => ref.entryId)));
        const older: ConversationTurn[] = [];
        for (const id of references) {
          if (includedIds.has(id)) continue;
          const position = positions.get(id); requireContext(position !== undefined, 'workflow_reference_unavailable');
          const entry = selected.branch[position]; requireContext(entry, 'workflow_reference_unavailable'); older.push(entry);
        }
        older.sort((a, b) => (positions.get(a.entryId) ?? -1) - (positions.get(b.entryId) ?? -1));
        requireContext(JSON.stringify(before) === JSON.stringify(await workflow()), 'workflow_context_changed');
        signal?.throwIfAborted(); current();
        const context = { current: currentTurn, previous: selected.previous, older, workflow: before,
          history: { previousMessageCount: selected.previous.length, historyTruncated: selected.truncated }, conversation: binding };
        const serialized = JSON.stringify(context), byteLength = Buffer.byteLength(serialized, 'utf8');
        requireContext(byteLength <= MAX_ROUTING_CONTEXT_BYTES, 'routing_context_bounds');
        const included = [currentTurn, ...selected.previous, ...older]; for (const entry of included) authorized(entry); current();
        const projection: ContextProjection = freeze({ status: 'available', context: freeze(context), serialized, byteLength,
          cutoff: freeze({ admission: cutoff, workflowRevision: before.revision }) });
        issued.set(projection, { workflow: JSON.stringify(before), included }); return projection;
      });
    },
    revalidateProjection(projection: ContextProjection): Promise<Readonly<{ status: 'available' }> | UnavailableContext> {
      return guarded(async () => {
        const proof = issued.get(projection); requireContext(proof, 'projection_not_issued'); current();
        requireContext(JSON.stringify(await workflow()) === proof.workflow, 'workflow_context_changed');
        current(); for (const entry of proof.included) authorized(entry); current(); return freeze({ status: 'available' });
      });
    },
  });
}

import Type, { type Static } from 'typebox';
import { isDeepStrictEqual } from 'node:util';
import { object, nullable, decode } from '../../../integrations/openclaw/benson-routing/core/value.js';
import { ConversationBindingSchema, ConversationCutoffSchema, IngressOriginSchema, ingressInputId } from '../../../integrations/openclaw/benson-routing/core/conversation-context.js';
import { PlanSchema, Nonempty, SettingsSchema } from './schemas.js';
import { ObservationSchema, ResultSchema, type Result } from './results.js';
import { TaskSignalSchema, ChargingSignalSchema, NumericSignalSchema, SettingSourcesSchema,
  TaskDeviceSchema, HomeGeometrySchema, type AtomicKeyedState } from './ports.js';

const Counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const IdentityFields = { requestKey: Nonempty, operationId: Nonempty, requestEpoch: Nonempty, requesterId: Nonempty };
export const OwnerSchema = object({ ...IdentityFields, generation: Counter });
export type Owner = Static<typeof OwnerSchema>;
export const BeforeSchema = object({ ...ObservationSchema.properties, taskId: nullable(Nonempty), taskScope: nullable(Nonempty),
  taskStatus: nullable(TaskSignalSchema), progress: Type.Optional(nullable(object({ ...NumericSignalSchema.properties, name: Type.Enum(['area', 'time']) }))),
  chargingStatus: Type.Optional(nullable(ChargingSignalSchema)), settings: SettingsSchema, settingSources: nullable(SettingSourcesSchema),
  taskDevice: Type.Optional(nullable(TaskDeviceSchema)), homeGeometry: Type.Optional(nullable(HomeGeometrySchema)) });
export const IntentSchema = object({ version: Type.Literal('1'), ...IdentityFields,
  requestHash: Nonempty, planHash: Nonempty, plan: PlanSchema,
  phase: Type.Enum(['prepared', 'dispatching', 'verifying', 'uncertain', 'terminal']), stepIndex: Counter,
  before: BeforeSchema, suctionAlreadySet: Type.Boolean(), appliedSettings: SettingsSchema,
  lastObservation: nullable(ObservationSchema), createdAt: Nonempty,
  dispatch: Type.Optional(Type.Enum(['accepted', 'unknown'])), dispatchStartedAt: Type.Optional(Nonempty), result: Type.Optional(ResultSchema) });
export type Intent = Static<typeof IntentSchema>;
export const ActiveSchema = object({ ...IntentSchema.properties, resourceGeneration: Counter, revision: Counter });
export type Active = Static<typeof ActiveSchema>;
const InFlightSchema = object({ requestKey: Nonempty, operationId: Nonempty, generation: Counter, stepIndex: Counter });
const ResourceSchema = object({ generation: Counter, owner: nullable(OwnerSchema), inFlight: nullable(InFlightSchema), uncertain: Type.Boolean() });
// Host-proven original input/return route, never a model-supplied execution or
// delivery grant. Response Controller must independently authorize any response.
const CutoffOriginSchema = object({ binding: ConversationBindingSchema, cutoff: ConversationCutoffSchema });
export const OperationOriginSchema = Type.Union([CutoffOriginSchema, IngressOriginSchema]);
export type OperationOrigin = Static<typeof OperationOriginSchema>;
export function operationInputId(origin: OperationOrigin): string {
  if (!('cutoff' in origin) && ingressInputId(origin.binding, origin.messageId) !== origin.inputId)
    throw new Error('Jessica ingress identity invalid');
  return 'cutoff' in origin ? origin.cutoff.entryId : origin.inputId;
}
const CorrelationV1Schema = object({ version: Type.Literal('1'), origin: CutoffOriginSchema, owner: OwnerSchema,
  requestHash: Nonempty, planHash: Nonempty, plan: PlanSchema, createdAt: Nonempty });
const CorrelationV2Schema = object({ ...CorrelationV1Schema.properties, version: Type.Literal('2'), origin: IngressOriginSchema });
const CorrelationSchema = Type.Union([CorrelationV1Schema, CorrelationV2Schema]);
export type OperationCorrelation = Static<typeof CorrelationSchema>;
const DeviceV2Schema = object({ version: Type.Literal('2'), active: nullable(ActiveSchema), resource: ResourceSchema });
const DeviceV3Schema = object({ version: Type.Literal('3'), active: nullable(ActiveSchema), resource: ResourceSchema,
  correlation: nullable(CorrelationV1Schema) });
const CompletionClaimSchema = object({ evidenceRef: Nonempty, observedAt: Nonempty, sourceRef: Nonempty });
export type CompletionClaim = Static<typeof CompletionClaimSchema>;
// v4 only records preparation custody. It never releases physical ownership.
const DeviceV4Schema = object({ ...DeviceV3Schema.properties, version: Type.Literal('4'),
  completion: nullable(CompletionClaimSchema) });
// Old readers reject v5 rather than silently interpreting ingress as a cutoff.
const DeviceV5Schema = object({ ...DeviceV4Schema.properties, version: Type.Literal('5'), correlation: nullable(CorrelationSchema) });
const DeviceSchema = Type.Union([DeviceV2Schema, DeviceV3Schema, DeviceV4Schema, DeviceV5Schema]);
type Device = Static<typeof DeviceSchema>;
export const HistorySchema = object({ version: Type.Literal('1'), requestHash: Nonempty, planHash: Nonempty, result: ResultSchema });
type History = Static<typeof HistorySchema>;
const IndexSchema = Type.Union([
  object({ version: Type.Literal('1'), operationId: Nonempty, result: ResultSchema }),
  object({ version: Type.Literal('2'), operationId: Nonempty, result: ResultSchema, correlation: CorrelationV1Schema }),
  object({ version: Type.Literal('3'), operationId: Nonempty, result: ResultSchema, correlation: CorrelationV2Schema }),
]);
const CanaryClaimSchema = object({ version: Type.Literal('1'), requestKey: Nonempty, operationId: Nonempty, claimedAt: Nonempty });
export interface StateRecords {
  'device:jessica-vacuum': Device;
  [key: `request:${string}`]: History;
  [key: `operation:${string}`]: Static<typeof IndexSchema>;
  [key: `under-test:${string}`]: Static<typeof CanaryClaimSchema>;
}
const DEVICE_KEY = 'device:jessica-vacuum';
export const JESSICA_STATE_OPTIONS = Object.freeze({ namespace: 'jessica-operations-v1', maxEntries: 10_000, overflowPolicy: 'reject-new' });
export function matchesOperation(a: Active, b: Active | null): boolean {
  return b !== null && a.requestKey === b.requestKey && a.operationId === b.operationId && a.requestEpoch === b.requestEpoch &&
    a.requesterId === b.requesterId && a.resourceGeneration === b.resourceGeneration && a.requestHash === b.requestHash && a.planHash === b.planHash;
}
export const matchesSnapshot = (a: Active, b: Active | null): boolean => matchesOperation(a, b) && b !== null &&
  a.revision === b.revision && a.stepIndex === b.stepIndex && a.phase === b.phase;
function owns(resource: Device['resource'], active: Active): boolean {
  const owner = resource.owner;
  return owner !== null && owner.requestKey === active.requestKey && owner.operationId === active.operationId &&
    owner.requestEpoch === active.requestEpoch && owner.requesterId === active.requesterId && resource.generation === active.resourceGeneration;
}
function sameMutation(token: Device['resource']['inFlight'], active: Active): boolean {
  return token !== null && token.requestKey === active.requestKey && token.operationId === active.operationId &&
    token.generation === active.resourceGeneration && token.stepIndex === active.stepIndex;
}
function device(raw: unknown): Device {
  if (raw === undefined) return { version: '2', active: null, resource: { generation: 0, owner: null, inFlight: null, uncertain: false } };
  const value = decode(DeviceSchema, raw, 'jessica_state_invalid');
  const { resource, active } = value;
  if ((value.version === '4' || value.version === '5') && value.completion !== null && resource.owner === null) throw new Error('Jessica completion custody invalid');
  if (value.version !== '2' && (resource.owner === null) !== (value.correlation === null)) throw new Error('Jessica correlation custody invalid');
  if (resource.owner === null ? active !== null || resource.inFlight !== null || resource.uncertain :
    resource.owner.generation !== resource.generation || resource.generation < 1 ||
    active !== null && (!owns(resource, active) || active.phase === 'terminal' && !active.result) ||
    resource.inFlight !== null && (active === null || !sameMutation(resource.inFlight, active))) throw new Error('Jessica resource state is invalid');
  if (value.version !== '2' && value.correlation !== null) {
    const correlation = value.correlation;
    validateCorrelation(correlation);
    if (!isDeepStrictEqual(correlation.owner, resource.owner) || active !== null &&
      (active.requestHash !== correlation.requestHash || active.planHash !== correlation.planHash ||
        active.createdAt !== correlation.createdAt || !isDeepStrictEqual(active.plan, correlation.plan))) {
      throw new Error('Jessica operation correlation changed');
    }
  }
  return structuredClone(value);
}
function validateCorrelation(value: OperationCorrelation): void {
  validateOrigin(value.origin, value.owner.requestEpoch, value.owner.requesterId, value.plan);
}
function validateOrigin(origin: OperationOrigin, requestEpoch: string, requesterId: string, plan: OperationCorrelation['plan']): void {
  if (operationInputId(origin) !== requestEpoch || origin.binding.channel !== 'whatsapp' || origin.binding.kind !== 'direct' ||
    origin.binding.requesterId.length === 0 ||
    plan.requesterSubject !== requesterId || plan.operation !== 'clean' || plan.targetKind !== 'rooms' ||
    plan.rooms.length !== 1 || plan.settings !== null || plan.mapFingerprint === null || plan.mapGeneration === null) {
    throw new Error('Jessica operation correlation scope invalid');
  }
}
export interface Transition { readonly changed: boolean; readonly active: Active | null }
export type Reservation =
  | { readonly kind: 'reserved' | 'duplicate'; readonly active: Active; readonly completed: null }
  | { readonly kind: 'conflict'; readonly active: Active | null; readonly completed: null }
  | { readonly kind: 'busy'; readonly active: null; readonly completed: null }
  | { readonly kind: 'completed'; readonly active: null; readonly completed: History };
export function createOperationState(store: AtomicKeyedState<StateRecords>, { verifyRelease = (_owner: Owner, _evidence: unknown): boolean => false } = {}) {
  const read = async () => device(await store.lookup(DEVICE_KEY));
  const active = async () => (await read()).active;
  const resource = async () => (await read()).resource;
  async function history(key: string): Promise<History | null> {
    const raw = await store.lookup(`request:${key}`);
    return raw === undefined ? null : decode(HistorySchema, raw, 'jessica_history_invalid');
  }
  async function operation(id: string): Promise<{ kind: 'active'; value: Active } | { kind: 'terminal'; value: Result } | null> {
    const current = await active();
    if (current?.operationId === id) return current.phase === 'terminal' && current.result ?
      { kind: 'terminal', value: current.result } : { kind: 'active', value: current };
    const raw = await store.lookup(`operation:${id}`);
    if (raw === undefined) return null;
    const value = decode(IndexSchema, raw, 'jessica_index_invalid');
    if (value.operationId !== id || !value.result.data || !('operationId' in value.result.data) || value.result.data.operationId !== id) throw new Error('Jessica operation index is invalid');
    if (value.version !== '1') {
      validateCorrelation(value.correlation);
      if (value.correlation.owner.operationId !== id) throw new Error('Jessica operation index correlation invalid');
    }
    return { kind: 'terminal', value: value.result };
  }
  async function correlation(id: string): Promise<OperationCorrelation | null> {
    const current = await read();
    if (current.version !== '2' && current.correlation?.owner.operationId === id) return structuredClone(current.correlation);
    const raw = await store.lookup(`operation:${id}`);
    if (raw === undefined) return null;
    const index = decode(IndexSchema, raw, 'jessica_index_invalid');
    if (index.operationId !== id || !index.result.data || !('operationId' in index.result.data) || index.result.data.operationId !== id) throw new Error('Jessica operation index is invalid');
    if (index.version === '1') return null; // Never invent origin for legacy history.
    validateCorrelation(index.correlation);
    if (index.correlation.owner.operationId !== id) throw new Error('Jessica operation index correlation invalid');
    return structuredClone(index.correlation);
  }
  /** One canonical owned operation, never the most recent requester/history row.
   * A verified start is necessary but does not itself prove physical completion. */
  async function completionCandidate() {
    const current = await read();
    if (current.version === '2' || !current.correlation || current.active || current.resource.inFlight || current.resource.uncertain) return null;
    const binding = current.correlation;
    const raw = await store.lookup(`operation:${binding.owner.operationId}`);
    if (raw === undefined) return null;
    const index = decode(IndexSchema, raw, 'jessica_index_invalid');
    if (index.version === '1' || !isDeepStrictEqual(index.correlation, binding) || index.operationId !== binding.owner.operationId ||
      index.result.status !== 'success' || !index.result.verified || index.result.operation !== 'clean' ||
      !index.result.data || !('appliedSettings' in index.result.data) || index.result.data.outcome !== 'started' ||
      index.result.data.operationId !== binding.owner.operationId ||
      !isDeepStrictEqual(index.result.data.rooms, binding.plan.rooms.map(room => room.slug)) ||
      Object.keys(index.result.data.appliedSettings).length !== 0) return null;
    const latest = await read();
    if (latest.version === '2' || !isDeepStrictEqual(latest.correlation, binding) || latest.active ||
      latest.resource.inFlight || latest.resource.uncertain) return null;
    return { correlation: structuredClone(binding), start: index.result,
      claimed: (latest.version === '4' || latest.version === '5') && latest.completion !== null };
  }
  async function claimCompletion(binding: OperationCorrelation, raw: CompletionClaim): Promise<'claimed' | 'duplicate' | 'changed'> {
    const claim = decode(CompletionClaimSchema, raw, 'jessica_completion_claim_invalid');
    const observed = await store.observe(DEVICE_KEY), current = device(observed.value);
    if (current.version === '2' || !isDeepStrictEqual(current.correlation, binding) || current.active ||
      current.resource.inFlight || current.resource.uncertain) return 'changed';
    if ((current.version === '4' || current.version === '5') && current.completion !== null) return 'duplicate';
    return await store.compareAndSet(DEVICE_KEY, observed, device({ ...current, version: binding.version === '2' || current.version === '5' ? '5' : '4', completion: claim })) === 'applied' ? 'claimed' : 'changed';
  }
  async function completionCurrent(binding: OperationCorrelation, claim: CompletionClaim): Promise<boolean> {
    const current = await read();
    return (current.version === '4' || current.version === '5') && isDeepStrictEqual(current.correlation, binding) &&
      isDeepStrictEqual(current.completion, claim) && !current.active && !current.resource.inFlight && !current.resource.uncertain;
  }
  async function claimUnderTest(id: string, key: string, operationId: string, now: Date): Promise<boolean> {
    const entry: Static<typeof CanaryClaimSchema> = { version: '1', requestKey: key, operationId, claimedAt: now.toISOString() };
    if (await store.registerIfAbsent(`under-test:${id}`, entry)) return true;
    const existing = decode(CanaryClaimSchema, await store.lookup(`under-test:${id}`), 'jessica_canary_claim_invalid');
    return existing.requestKey === key && existing.operationId === operationId;
  }
  async function reserve(raw: Intent, rawOrigin?: OperationOrigin): Promise<Reservation> {
    const intent = decode(IntentSchema, raw, 'jessica_intent_invalid');
    const origin = rawOrigin === undefined ? undefined : structuredClone(decode(OperationOriginSchema, rawOrigin, 'jessica_origin_invalid'));
    if (origin) validateOrigin(origin, intent.requestEpoch, intent.requesterId, intent.plan);
    // Observe before history: finalization that creates history must invalidate this CAS.
    const observed = await store.observe(DEVICE_KEY);
    const current = device(observed.value);
    const completed = await history(intent.requestKey);
    if (completed) return { kind: 'completed', active: null, completed };
    if (current.active) return { kind: current.active.requestKey === intent.requestKey ? 'duplicate' : 'conflict', active: current.active, completed: null };
    if (current.resource.owner) return { kind: 'busy', active: null, completed: null };
    if (current.version !== '2' && origin === undefined) throw new Error('Jessica operation origin required after correlated-state activation');
    if (current.resource.generation === Number.MAX_SAFE_INTEGER) throw new Error('Jessica resource generation exhausted');
    const generation = current.resource.generation + 1;
    const next = { ...intent, resourceGeneration: generation, revision: 0 };
    const owner = { requestKey: intent.requestKey, operationId: intent.operationId, requestEpoch: intent.requestEpoch, requesterId: intent.requesterId, generation };
    const binding: OperationCorrelation | null = origin === undefined ? null : decode(CorrelationSchema, { version: 'cutoff' in origin ? '1' : '2', origin, owner: structuredClone(owner),
      requestHash: intent.requestHash, planHash: intent.planHash, plan: structuredClone(intent.plan), createdAt: intent.createdAt }, 'jessica_correlation_invalid');
    if (binding) validateCorrelation(binding);
    const updated = { ...current, active: next, resource: { generation, owner, inFlight: null, uncertain: false } };
    const candidate: Device = current.version === '5' || binding?.version === '2' ? { ...updated, version: '5', correlation: binding, completion: null } : current.version === '4' ? { ...updated, version: '4', correlation: binding, completion: null } :
      binding || current.version !== '2' ? { ...updated, version: '3', correlation: binding } : updated;
    device(candidate);
    const write = await store.compareAndSet(DEVICE_KEY, observed, candidate);
    return write === 'applied' ? { kind: 'reserved', active: next, completed: null } : { kind: 'conflict', active: null, completed: null };
  }
  async function change(expected: Active, transform: (current: Device, found: Active) => Device | null): Promise<Transition> {
    const observed = await store.observe(DEVICE_KEY);
    const current = device(observed.value);
    const found = current.active;
    if (!found || !owns(current.resource, expected) || !matchesSnapshot(expected, found) || found.revision === Number.MAX_SAFE_INTEGER) return { changed: false, active: found };
    const next = transform(current, found);
    if (next === null) return { changed: false, active: found };
    device(next);
    const write = await store.compareAndSet(DEVICE_KEY, observed, next);
    return write === 'applied' ? { changed: true, active: next.active } : { changed: false, active: await active() };
  }
  async function transition(expected: Active, phases: readonly Active['phase'][], update: (value: Active) => Active | null): Promise<Transition> {
    return change(expected, (current, found) => {
      if (!phases.includes(found.phase) || found.phase === 'dispatching' && current.resource.inFlight !== null) return null;
      const next = update(structuredClone(found));
      if (current.resource.inFlight !== null && (next === null || ['prepared', 'terminal'].includes(next.phase) || next.stepIndex !== found.stepIndex)) return null;
      if (next !== null && !matchesOperation(found, next)) throw new Error('Jessica operation owner cannot change');
      return { ...current, active: next === null ? null : { ...next, revision: found.revision + 1 },
        resource: { ...current.resource, uncertain: current.resource.uncertain || next?.phase === 'uncertain' } };
    });
  }
  async function claimMutation(expected: Active, now: Date): Promise<Transition> {
    return change(expected, (current, found) => found.phase !== 'prepared' || current.resource.inFlight !== null || current.resource.uncertain ? null :
      { ...current, active: { ...found, revision: found.revision + 1, phase: 'dispatching', dispatch: 'unknown', dispatchStartedAt: now.toISOString() },
        resource: { ...current.resource, inFlight: { requestKey: found.requestKey, operationId: found.operationId, generation: found.resourceGeneration, stepIndex: found.stepIndex } } });
  }
  async function mutationCurrent(expected: Active): Promise<boolean> {
    const current = await read();
    return owns(current.resource, expected) && matchesSnapshot(expected, current.active) && current.active?.phase === 'dispatching' &&
      sameMutation(current.resource.inFlight, expected) && !current.resource.uncertain;
  }
  async function settleMutation(expected: Active, accepted: boolean): Promise<Transition> {
    return change(expected, (current, found) => found.phase !== 'dispatching' || !sameMutation(current.resource.inFlight, expected) ? null :
      { ...current, active: { ...found, revision: found.revision + 1, phase: 'verifying', dispatch: accepted ? 'accepted' : 'unknown' },
        resource: { ...current.resource, inFlight: accepted ? null : current.resource.inFlight, uncertain: current.resource.uncertain || !accepted } });
  }
  async function releaseResource(owner: Owner, evidence: unknown): Promise<boolean> {
    const observed = await store.observe(DEVICE_KEY);
    const current = device(observed.value);
    const retained = current.resource.owner;
    if (!retained || current.active || current.resource.inFlight || retained.requestKey !== owner.requestKey ||
      retained.operationId !== owner.operationId || retained.requestEpoch !== owner.requestEpoch || retained.requesterId !== owner.requesterId || retained.generation !== owner.generation ||
      verifyRelease(structuredClone(owner), structuredClone(evidence)) !== true) return false;
    // This source slice does not define physical release or completion delivery.
    if ((current.version === '4' || current.version === '5') && current.completion !== null) return false;
    // Archive must precede custody release. A release predicate cannot discard
    // the original operation/notification correlation.
    if (current.version !== '2' && current.correlation !== null) {
      const index = decode(IndexSchema, await store.lookup(`operation:${owner.operationId}`), 'jessica_index_invalid');
      if (index.version === '1' || index.operationId !== owner.operationId || !isDeepStrictEqual(index.correlation, current.correlation)) return false;
    }
    const released = { ...current, resource: { ...current.resource, owner: null, uncertain: false } };
    return await store.compareAndSet(DEVICE_KEY, observed, current.version === '5' ? { ...released, version: '5', correlation: null, completion: null } : current.version === '4' ? { ...released, version: '4', correlation: null, completion: null } :
      current.version !== '2' ? { ...released, version: '3', correlation: null } : released) === 'applied';
  }
  async function finish(expected: Active, result: Result): Promise<Result> {
    const retained = await history(expected.requestKey);
    let current = await active();
    if (retained) {
      if (retained.requestHash !== expected.requestHash || retained.planHash !== expected.planHash) throw new Error('Jessica request epoch outcome conflict');
      if (!matchesOperation(expected, current) || current?.phase !== 'terminal') return retained.result;
    }
    if (!current || !matchesOperation(expected, current)) throw new Error('Jessica ownership changed before finalization');
    if ((await resource()).inFlight !== null) throw new Error('Jessica dispatch requires reconciliation');
    if (current.phase !== 'terminal') {
      decode(ResultSchema, result, 'jessica_terminal_result_invalid');
      const moved = await transition(expected, ['prepared', 'dispatching', 'verifying', 'uncertain'], value => ({ ...value, phase: 'terminal', result }));
      current = moved.active;
    }
    if (!current || current.phase !== 'terminal' || !current.result || !matchesOperation(expected, current)) throw new Error('Jessica terminal state is invalid');
    const retainedDevice = await read();
    if (!matchesSnapshot(current, retainedDevice.active)) throw new Error('Jessica ownership changed before correlation archival');
    const binding = retainedDevice.version !== '2' ? retainedDevice.correlation : null;
    const index: Static<typeof IndexSchema> = binding === null ? { version: '1', operationId: current.operationId, result: current.result } :
      decode(IndexSchema, { version: binding.version === '2' ? '3' : '2', operationId: current.operationId, result: current.result, correlation: binding }, 'jessica_index_invalid');
    if (!await store.registerIfAbsent(`operation:${current.operationId}`, index) &&
      JSON.stringify(await store.lookup(`operation:${current.operationId}`)) !== JSON.stringify(index)) throw new Error('Jessica operation index conflict');
    const record: History = { version: '1', requestHash: expected.requestHash, planHash: expected.planHash, result: current.result };
    if (!await store.registerIfAbsent(`request:${expected.requestKey}`, record)) {
      const existing = await history(expected.requestKey);
      if (!existing || existing.requestHash !== record.requestHash || existing.planHash !== record.planHash || JSON.stringify(existing.result) !== JSON.stringify(record.result)) throw new Error('Jessica request history conflict');
    }
    await transition(current, ['terminal'], () => null);
    return record.result;
  }
  return Object.freeze({ active, resource, history, operation, correlation, reserve, transition, finish, claimUnderTest,
    completionCandidate, claimCompletion, completionCurrent, matchesSnapshot, matchesOperation, claimMutation, mutationCurrent, settleMutation, releaseResource });
}
export type OperationState = ReturnType<typeof createOperationState>;

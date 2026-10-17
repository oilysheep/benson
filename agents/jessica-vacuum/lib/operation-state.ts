import Type, { type Static } from 'typebox';
import { object, nullable, decode } from '../../../integrations/openclaw/benson-routing/core/value.js';
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
const DeviceSchema = object({ version: Type.Literal('2'), active: nullable(ActiveSchema), resource: ResourceSchema });
type Device = Static<typeof DeviceSchema>;
export const HistorySchema = object({ version: Type.Literal('1'), requestHash: Nonempty, planHash: Nonempty, result: ResultSchema });
type History = Static<typeof HistorySchema>;
const IndexSchema = object({ version: Type.Literal('1'), operationId: Nonempty, result: ResultSchema });
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
  if (resource.owner === null ? active !== null || resource.inFlight !== null || resource.uncertain :
    resource.owner.generation !== resource.generation || resource.generation < 1 ||
    active !== null && (!owns(resource, active) || active.phase === 'terminal' && !active.result) ||
    resource.inFlight !== null && (active === null || !sameMutation(resource.inFlight, active))) throw new Error('Jessica resource state is invalid');
  return structuredClone(value);
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
    return { kind: 'terminal', value: value.result };
  }
  async function claimUnderTest(id: string, key: string, operationId: string, now: Date): Promise<boolean> {
    const entry: Static<typeof CanaryClaimSchema> = { version: '1', requestKey: key, operationId, claimedAt: now.toISOString() };
    if (await store.registerIfAbsent(`under-test:${id}`, entry)) return true;
    const existing = decode(CanaryClaimSchema, await store.lookup(`under-test:${id}`), 'jessica_canary_claim_invalid');
    return existing.requestKey === key && existing.operationId === operationId;
  }
  async function reserve(raw: Intent): Promise<Reservation> {
    const intent = decode(IntentSchema, raw, 'jessica_intent_invalid');
    // Observe before history: finalization that creates history must invalidate this CAS.
    const observed = await store.observe(DEVICE_KEY);
    const current = device(observed.value);
    const completed = await history(intent.requestKey);
    if (completed) return { kind: 'completed', active: null, completed };
    if (current.active) return { kind: current.active.requestKey === intent.requestKey ? 'duplicate' : 'conflict', active: current.active, completed: null };
    if (current.resource.owner) return { kind: 'busy', active: null, completed: null };
    if (current.resource.generation === Number.MAX_SAFE_INTEGER) throw new Error('Jessica resource generation exhausted');
    const generation = current.resource.generation + 1;
    const next = { ...intent, resourceGeneration: generation, revision: 0 };
    const write = await store.compareAndSet(DEVICE_KEY, observed, { ...current, active: next, resource: {
      generation, owner: { requestKey: intent.requestKey, operationId: intent.operationId, requestEpoch: intent.requestEpoch, requesterId: intent.requesterId, generation }, inFlight: null, uncertain: false } });
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
    return await store.compareAndSet(DEVICE_KEY, observed, { ...current, resource: { ...current.resource, owner: null, uncertain: false } }) === 'applied';
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
    const index: Static<typeof IndexSchema> = { version: '1', operationId: current.operationId, result: current.result };
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
  return Object.freeze({ active, resource, history, operation, reserve, transition, finish, claimUnderTest,
    matchesSnapshot, matchesOperation, claimMutation, mutationCurrent, settleMutation, releaseResource });
}
export type OperationState = ReturnType<typeof createOperationState>;

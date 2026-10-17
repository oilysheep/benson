import { assertInvocationCurrent } from '../../../integrations/openclaw/benson-routing/core/invocation.js';
import { createHash } from 'node:crypto';
import { createDomainCore } from './domain-core.js';
import { DomainError } from './errors.js';
import { authorize, loadPolicy } from './policy.js';
import { assertFreshMap, loadRegistry } from './registry.js';
import { validateResult, type Result, type Observation } from './results.js';
import { parseExecuteRequest, EXECUTE_OPERATIONS, type ExecuteRequest } from './schemas.js';
import { createOperationState, type Active, type StateRecords, type OperationState } from './operation-state.js';
import type { AtomicKeyedState, JessicaDevice, InvocationAuthority, DeviceStep } from './ports.js';
import { observation, preconditions, requireHomeBefore, stepsFor, baselineMatches, verifyStep, type Verdict } from './verification.js';
import { plain } from '../../../integrations/openclaw/benson-routing/core/value.js';

type Operation = ExecuteRequest['operation'];
type ErrorInfo = NonNullable<Result['error']>;
export interface ExecutionContext { readonly identity: unknown; readonly requestEpoch: string; readonly authority: InvocationAuthority }
interface Dependencies {
  registryConfig: unknown; policyConfig: unknown; store: AtomicKeyedState<StateRecords>; driver: JessicaDevice;
  clock?: () => Date; wait?: (ms: number) => Promise<void>;
  pollCounts?: Partial<Record<Operation | 'setting', number>>;
  hooks?: Partial<Record<'afterIntent' | 'afterDispatchMarker' | 'afterPost' | 'afterAcceptedState', (value: Active) => void>>;
}
const TIMEOUT: Record<Operation, number> = { clean: 240_000, pause: 30_000, resume: 240_000, stop: 15_000, dock: 240_000 };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => ordered(item));
  return plain(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, ordered(v)])) : value;
}
function rawOperation(raw: unknown): Operation | null {
  return plain(raw) ? EXECUTE_OPERATIONS.find(operation => operation === raw.operation) ?? null : null;
}
function failure(operation: Operation | null, code: string, stage: ErrorInfo['stage'], message: string, now: Date,
  { active = null, sideEffects = Object.keys(active?.appliedSettings ?? {}).length ? 'observed' : 'none', retryMode = 'none' }:
  { active?: Active | null; sideEffects?: ErrorInfo['sideEffects']; retryMode?: ErrorInfo['retryMode'] } = {}): Result {
  return validateResult({ schemaVersion: '1', status: 'failure', domain: 'jessica-vacuum', operation, verified: false,
    data: active ? { operationId: active.operationId, rooms: active.plan.rooms.map(room => room.slug),
      outcome: sideEffects === 'none' ? 'not_sent' : 'unknown', dispatch: sideEffects === 'none' ? 'not_attempted' : 'unknown',
      observation: active.lastObservation, appliedSettings: active.appliedSettings } : null,
    warnings: [], error: { code, stage, message, retryMode, retryable: retryMode !== 'none', sideEffects }, pendingContext: null }, null, now);
}
function success(active: Active, outcome: string | null, observed: Observation, now: Date): Result {
  return validateResult({ schemaVersion: '1', status: 'success', domain: 'jessica-vacuum', operation: active.plan.operation, verified: true,
    data: { operationId: active.operationId, rooms: active.plan.rooms.map(room => room.slug), outcome, dispatch: 'accepted', observation: observed,
      appliedSettings: { ...active.appliedSettings, ...(active.suctionAlreadySet && active.plan.settings?.suction ? { suction: active.plan.settings.suction } : {}) } },
    warnings: [], error: null, pendingContext: null }, active.plan, now);
}
export function createJessicaExecutor({ registryConfig, policyConfig, store, driver, clock = () => new Date(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), pollCounts = {}, hooks = {} }: Dependencies) {
  const core = createDomainCore(registryConfig, policyConfig), registry = loadRegistry(registryConfig), policy = loadPolicy(policyConfig);
  const state = createOperationState(store);
  const unavailable = (op: Operation | null, active: Active | null = null) => failure(op, 'RESOURCE_STATE_UNAVAILABLE', 'verification',
    'Jessica ownership cannot be verified; retain known effects and reconcile read-only', clock(),
    { active, sideEffects: Object.keys(active?.appliedSettings ?? {}).length ? 'observed' : 'possible', retryMode: 'reconcile' });
  function identity(raw: unknown, context: ExecutionContext) {
    assertInvocationCurrent(context.authority); context.authority.signal.throwIfAborted();
    const request = parseExecuteRequest(raw), auth = authorize(policy, context.identity, 'control'), epoch = context.requestEpoch;
    if (!epoch || epoch.length > 160) throw new DomainError('EPOCH_UNTRUSTED', 'identity', 'Trusted external request epoch is unavailable');
    return { request, key: digest(['jessica-vacuum', auth.subject, epoch]), requestHash: digest(ordered(request)), requesterId: auth.subject, requestEpoch: epoch };
  }
  function belongsToRequest(active: Active, request: ReturnType<typeof identity>): boolean {
    return active.requestKey === request.key && active.requestHash === request.requestHash &&
      active.requestEpoch === request.requestEpoch && active.requesterId === request.requesterId;
  }
  async function read(authority: InvocationAuthority) {
    assertInvocationCurrent(authority); authority.signal.throwIfAborted();
    const value = await driver.read(authority);
    authority.signal.throwIfAborted(); assertInvocationCurrent(authority);
    return value;
  }
  async function pending(state: OperationState, known: Active, code = 'OPERATION_PENDING'): Promise<Result> {
    let active = known;
    try {
      const canonical = await state.operation(active.operationId);
      if (canonical?.kind === 'terminal') return canonical.value;
      if (canonical?.kind === 'active') {
        if (!state.matchesOperation(active, canonical.value)) return unavailable(active.plan.operation, active);
        active = { ...canonical.value, lastObservation: canonical.value.lastObservation ?? active.lastObservation,
          appliedSettings: { ...active.appliedSettings, ...canonical.value.appliedSettings } };
      }
    } catch { return unavailable(active.plan.operation, active); }
    return failure(active.plan.operation, code, 'verification', 'Operation needs read-only reconciliation', clock(),
      { active, sideEffects: Object.keys(active.appliedSettings).length ? 'observed' : 'possible', retryMode: 'reconcile' });
  }
  async function recover(state: OperationState, key: string, hash: string, op: Operation | null, expected: Active | null = null): Promise<Result | null> {
    const active = await state.active(), prior = await state.history(key);
    if (prior) return prior.requestHash === hash ? prior.result : failure(op, 'EPOCH_CONFLICT', 'precondition', 'Request epoch belongs to a different operation', clock());
    if (!active || active.requestKey !== key) return null;
    if (active.requestHash !== hash) return failure(op, 'EPOCH_CONFLICT', 'precondition', 'Request epoch belongs to a different operation', clock());
    if (active.phase === 'terminal' && active.result) return state.finish(active, active.result);
    if (expected && active.phase === 'prepared' && state.matchesSnapshot(expected, active)) return null;
    return pending(state, expected && state.matchesOperation(expected, active) ? expected : active);
  }
  async function poll(active: Active, step: DeviceStep, authority: InvocationAuthority): Promise<Verdict> {
    const count = pollCounts[step.kind === 'setting' ? 'setting' : active.plan.operation] ?? Math.ceil((step.kind === 'setting' ? 15_000 : TIMEOUT[active.plan.operation]) / 2_000);
    if (!Number.isSafeInteger(count) || count < 0 || count > 120) throw new Error('Invalid bounded observation budget');
    for (let i = 0; i < count; i++) {
      assertInvocationCurrent(authority); authority.signal.throwIfAborted();
      try { const verdict = verifyStep(active, step, await read(authority), clock(), registry); if (verdict.kind !== 'pending') return verdict; }
      catch { authority.signal.throwIfAborted(); assertInvocationCurrent(authority); }
      if (i + 1 < count) await wait(2_000);
    }
    return { kind: 'pending' };
  }
  function observed(active: Active, step: DeviceStep, verdict: Extract<Verdict, { kind: 'verified' }>): Active {
    return { ...active, lastObservation: verdict.observation, appliedSettings: step.kind === 'setting' ? { ...active.appliedSettings, [step.name]: step.value } : active.appliedSettings };
  }
  async function advance(state: OperationState, initial: Active, context: ExecutionContext, remember: (value: Active) => void): Promise<Result> {
    let active = initial;
    const steps = stepsFor(active);
    while (active.stepIndex < steps.length) {
      const step = steps[active.stepIndex];
      if (!step) throw new Error('Jessica command step is unavailable');
      let evidence;
      try {
        evidence = await read(context.authority); observation(evidence, clock());
        if (active.plan.mapFingerprint) assertFreshMap(registry, evidence.map, clock());
        if (active.plan.targetKind === 'home') requireHomeBefore(active.plan, evidence, clock(), registry);
      } catch (error) {
        if (error instanceof DomainError && ['MAP_CHANGED', 'MAP_STALE', 'ROOM_MAP_MISMATCH', 'WORKFLOW_CHANGED'].includes(error.code)) return state.finish(active,
          failure(active.plan.operation, error.code, error.stage, error.message, clock(), { active }));
        return await recover(state, active.requestKey, active.requestHash, active.plan.operation, active) ??
          failure(active.plan.operation, 'READ_UNAVAILABLE', 'precondition', 'Fresh pre-dispatch state is unavailable', clock(), { active, retryMode: 'read_only' });
      }
      if (!baselineMatches(active, evidence)) return state.finish(active,
        failure(active.plan.operation, 'PRECONDITION_CHANGED', 'precondition', 'Vacuum changed before dispatch', clock(), { active }));
      if (active.plan.underTestId) {
        if (registry.underTest?.id !== active.plan.underTestId || clock().getTime() >= Date.parse(registry.underTest.expiresAt)) return state.finish(active,
          failure(active.plan.operation, 'CANARY_SCOPE_EXPIRED', 'precondition', 'Under-test scope expired before dispatch', clock(), { active }));
        if (!await state.claimUnderTest(active.plan.underTestId, active.requestKey, active.operationId, clock())) return state.finish(active,
          failure(active.plan.operation, 'CANARY_ALREADY_USED', 'precondition', 'Under-test dispatch has already been claimed', clock(), { active }));
      }
      assertInvocationCurrent(context.authority); context.authority.signal.throwIfAborted();
      const claimed = await state.claimMutation(active, clock());
      if (!claimed.changed || !claimed.active) return pending(state, active);
      active = claimed.active; remember(active); hooks.afterDispatchMarker?.(structuredClone(active));
      // The adapter repeats this after credentials and immediately before POST.
      const snapshot = active;
      const guard = { ...context.authority, signal: context.authority.signal, assertCurrent: () => assertInvocationCurrent(context.authority),
        assertMutationCurrent: async () => {
          context.authority.signal.throwIfAborted(); assertInvocationCurrent(context.authority);
          if (!await state.mutationCurrent(snapshot)) throw new DomainError('RESOURCE_OWNER_STALE', 'dispatch', 'Jessica mutation authority is stale');
          context.authority.signal.throwIfAborted(); assertInvocationCurrent(context.authority);
        } };
      let accepted = false;
      try { await guard.assertMutationCurrent(); accepted = (await driver.dispatch(step, guard)).accepted === true; }
      catch { /* Once marked, transport failure or cancellation cannot prove no effect. */ }
      hooks.afterPost?.(structuredClone(active));
      const moved = await state.settleMutation(active, accepted);
      if (!moved.changed || !moved.active) return pending(state, active);
      active = moved.active; remember(active); hooks.afterAcceptedState?.(structuredClone(active));
      const verdict = await poll(active, step, context.authority);
      if (verdict.kind !== 'verified') {
        await state.transition(active, ['verifying'], value => ({ ...value, phase: 'uncertain', lastObservation: verdict.observation ?? null }));
        return pending(state, active, verdict.kind === 'mismatch' ? 'TARGET_MISMATCH' : 'VERIFICATION_TIMEOUT');
      }
      const known = observed(active, step, verdict); remember(known);
      if (active.dispatch !== 'accepted') {
        await state.transition(active, ['verifying'], value => ({ ...value, phase: 'uncertain', lastObservation: verdict.observation, appliedSettings: known.appliedSettings }));
        return pending(state, known, 'DISPATCH_UNCERTAIN');
      }
      if (step.kind === 'setting') {
        const updated = await state.transition(active, ['verifying'], value => ({ ...value, phase: 'prepared', stepIndex: value.stepIndex + 1,
          before: { observedAt: verdict.observation.observedAt, sourceUpdatedAt: verdict.observation.sourceUpdatedAt,
            state: verdict.observation.state, activeSegments: verdict.observation.activeSegments, currentSegment: verdict.observation.currentSegment,
            taskId: evidence.taskId ?? null, taskScope: evidence.taskScope ?? null,
            taskStatus: active.plan.roomTaskSignal ? evidence.taskStatus ?? null : null,
            settings: verdict.settings, settingSources: verdict.settingSources ?? null }, appliedSettings: known.appliedSettings }));
        if (!updated.changed || !updated.active) return pending(state, known);
        active = updated.active; remember(active); continue;
      }
      let result;
      try { result = success(active, verdict.outcome, verdict.observation, clock()); }
      catch {
        await state.transition(active, ['verifying'], value => ({ ...value, phase: 'uncertain', lastObservation: verdict.observation }));
        return pending(state, known, 'INTEGRITY_UNVERIFIED');
      }
      return state.finish(active, result);
    }
    throw new Error('Jessica execution plan has no command step');
  }
  function invocationState(authority: InvocationAuthority): OperationState {
    async function checked<T>(access: () => Promise<T>): Promise<T> {
      assertInvocationCurrent(authority);
      const value = await access();
      assertInvocationCurrent(authority);
      return value;
    }
    // Domain fences bracket awaits; the native adapter must additionally fence the atomic write itself.
    const guarded: AtomicKeyedState<StateRecords> = {
      observe: key => checked(() => store.observe(key)),
      lookup: key => checked(() => store.lookup(key)),
      compareAndSet: (key, observed, value) => checked(() => store.compareAndSet(key, observed, value)),
      registerIfAbsent: (key, value) => checked(() => store.registerIfAbsent(key, value)),
    };
    return createOperationState(guarded);
  }
  async function run(raw: unknown, context: ExecutionContext, reconcile: boolean): Promise<Result> {
    const state = invocationState(context.authority);
    let op = rawOperation(raw), key: string | undefined, hash: string | undefined, last: Active | null = null;
    try {
      const derived = identity(raw, context); key = derived.key; hash = derived.requestHash; op = derived.request.operation;
      const prior = await state.history(key);
      if (prior) return prior.requestHash === hash ? prior.result : failure(op, 'EPOCH_CONFLICT', 'precondition', 'Request epoch belongs to a different operation', clock());
      let active = await state.active();
      if (active?.requestKey === key && !belongsToRequest(active, derived)) return failure(op, 'EPOCH_CONFLICT', 'precondition', 'Request epoch belongs to a different operation', clock());
      if (active?.requestKey === key) last = active;
      if (active?.requestKey === key && active.phase === 'terminal' && active.result) return state.finish(active, active.result);
      if (reconcile) {
        if (!active || active.requestKey !== key || active.requestHash !== hash) return await recover(state, key, hash, op) ?? failure(op, 'OPERATION_NOT_FOUND', 'precondition', 'No matching Jessica intent exists', clock());
        if (active.phase === 'prepared') return await recover(state, key, hash, op, active) ?? failure(op, 'NOT_DISPATCHED', 'verification', 'Intent exists but dispatch was not marked', clock(), { active, retryMode: 'read_only' });
        const step = stepsFor(active)[active.stepIndex];
        if (!step) throw new Error('Jessica reconciliation step is invalid');
        let verdict: Verdict;
        try { verdict = verifyStep(active, step, await read(context.authority), clock(), registry); } catch { verdict = { kind: 'pending' }; }
        if (verdict.kind !== 'verified') {
          await state.transition(active, ['dispatching', 'verifying', 'uncertain'], value => ({ ...value, phase: 'uncertain', lastObservation: verdict.observation ?? value.lastObservation }));
          return pending(state, active, verdict.kind === 'mismatch' ? 'TARGET_MISMATCH' : 'RECONCILIATION_UNRESOLVED');
        }
        last = observed(active, step, verdict);
        if (step.kind === 'setting') {
          const updated = await state.transition(active, ['dispatching', 'verifying', 'uncertain'], () => last);
          if (!updated.changed || !updated.active) return pending(state, last);
          return state.finish(updated.active, failure(op, 'PARTIAL_SETTING_APPLIED', 'verification', 'A setting changed; the cleaning command was not sent', clock(), { active: last, sideEffects: 'observed' }));
        }
        if (active.dispatch !== 'accepted') return pending(state, last, 'DISPATCH_UNCERTAIN');
        let result;
        try { result = success(active, verdict.outcome, verdict.observation, clock()); } catch { return pending(state, active, 'INTEGRITY_UNVERIFIED'); }
        return state.finish(active, result);
      }
      if (active?.requestKey === key && active.phase !== 'prepared') return pending(state, active);
      if (active && active.requestKey !== key) return await recover(state, key, hash, op) ?? failure(op, 'CONFLICT_UNRESOLVED', 'precondition', 'Another Jessica operation is unresolved', clock());
      if (!active && (await state.resource()).owner) return await recover(state, key, hash, op) ?? failure(op, 'RESOURCE_BUSY', 'precondition', 'Jessica physical ownership has not been verifiably released; try later', clock());
      const evidence = await read(context.authority), plan = core.prepareExecute(derived.request, context.identity, evidence, clock());
      const before = preconditions(plan, evidence, clock(), registry), planHash = digest(ordered(plan));
      if (active && active.planHash !== planHash) return failure(op, 'PRECONDITION_CHANGED', 'precondition', 'Prepared operation no longer matches current evidence', clock(), { active });
      if (!active) {
        const reservation = await state.reserve({ version: '1', requestKey: key, requestHash: hash, planHash,
          requesterId: derived.requesterId, requestEpoch: derived.requestEpoch, operationId: `j4-${digest([key, hash]).slice(0, 32)}`, plan,
          phase: 'prepared', stepIndex: 0, before, suctionAlreadySet: plan.settings?.suction !== undefined && before.settings.suction === plan.settings.suction,
          appliedSettings: {}, lastObservation: null, createdAt: clock().toISOString() });
        switch (reservation.kind) {
          case 'completed': return reservation.completed.requestHash === hash ? reservation.completed.result :
            failure(op, 'EPOCH_CONFLICT', 'precondition', 'Request epoch belongs to a different operation', clock());
          case 'busy': case 'conflict': return await recover(state, key, hash, op) ??
            failure(op, reservation.kind === 'busy' ? 'RESOURCE_BUSY' : 'CONFLICT_UNRESOLVED', 'precondition', 'Jessica ownership is unavailable', clock());
          case 'reserved': case 'duplicate': {
            const raced = await state.history(key);
            if (raced) return raced.requestHash === hash ? raced.result : failure(op, 'EPOCH_CONFLICT', 'precondition', 'Request epoch belongs to a different operation', clock());
            if (!belongsToRequest(reservation.active, derived) || reservation.active.planHash !== planHash) return failure(op, 'EPOCH_CONFLICT', 'precondition', 'Request epoch belongs to a different operation', clock());
            active = reservation.active; last = active;
            break;
          }
          default: { const unreachable: never = reservation; throw new Error(`Invalid reservation: ${String(unreachable)}`); }
        }
        if (active.phase === 'terminal' && active.result) return state.finish(active, active.result);
        if (active.phase !== 'prepared') return pending(state, active);
      }
      hooks.afterIntent?.(structuredClone(active));
      return await advance(state, active, context, value => { last = value; });
    } catch (error) {
      try { const recovered = key && hash ? await recover(state, key, hash, op, last) : null; if (recovered) return recovered; }
      catch { return unavailable(op, last); }
      const known = error instanceof DomainError;
      return failure(op, known ? error.code : reconcile ? 'RECONCILIATION_UNAVAILABLE' : 'EXECUTION_UNAVAILABLE', known ? error.stage : 'verification',
        known ? error.message : 'Jessica execution is unavailable', clock(), { active: last,
          sideEffects: Object.keys(last?.appliedSettings ?? {}).length ? 'observed' : last || reconcile && !known ? 'possible' : 'none',
          retryMode: last ? reconcile ? 'reconcile' : 'read_only' : 'none' });
    }
  }
  async function currentResult(raw: unknown, context: ExecutionContext, reconcile: boolean): Promise<Result> {
    const result = await run(raw, context, reconcile);
    try { assertInvocationCurrent(context.authority); }
    catch {
      // Retain canonical effects/history, but disclose no stored facts to a retired invocation.
      const sideEffects = result.status === 'success' ? 'observed' : result.error?.sideEffects ?? 'possible';
      return failure(rawOperation(raw), 'INVOCATION_NOT_CURRENT', 'identity', 'Invocation is no longer current', clock(),
        { sideEffects, retryMode: sideEffects === 'none' ? 'none' : 'reconcile' });
    }
    return result;
  }
  return Object.freeze({ execute: (raw: unknown, context: ExecutionContext) => currentResult(raw, context, false),
    reconcile: (raw: unknown, context: ExecutionContext) => currentResult(raw, context, true), state });
}

// Stage 4 execution state. The caller supplies OpenClaw's sync plugin-state store;
// no separate database, scheduler, or production write tool is created here.
const DEVICE_KEY = 'device:jessica-vacuum';
const requestKey = (key) => `request:${key}`;
const operationKey = (id) => `operation:${id}`;
const underTestKey = (id) => `under-test:${id}`;
export const JESSICA_STATE_OPTIONS = Object.freeze({
  namespace: 'jessica-operations-v1', maxEntries: 10_000, overflowPolicy: 'reject-new',
});

function deviceRecord(value) {
  if (value === undefined) return { version: '1', active: null };
  if (value?.version !== '1' || !Object.hasOwn(value, 'active')) {
    throw new Error('Jessica operation state is invalid');
  }
  return value;
}

export function createOperationState(store) {
  if (!store || typeof store.lookup !== 'function' || typeof store.update !== 'function' ||
      typeof store.registerIfAbsent !== 'function') {
    throw new Error('OpenClaw sync plugin-state store is required');
  }

  const active = () => deviceRecord(store.lookup(DEVICE_KEY)).active;
  const history = (key) => store.lookup(requestKey(key));

  function operation(id) {
    const current = active();
    if (current?.operationId === id) {
      return current.phase === 'terminal' && current.result ?
        { kind: 'terminal', value: current.result } : { kind: 'active', value: current };
    }
    const record = store.lookup(operationKey(id));
    if (record === undefined) return null;
    if (record?.version !== '1' || record.operationId !== id ||
        typeof record.result !== 'object' || record.result === null ||
        record.result.schemaVersion !== '1' || record.result.domain !== 'jessica-vacuum' ||
        record.result.data?.operationId !== id) {
      throw new Error('Jessica operation index is invalid');
    }
    return { kind: 'terminal', value: record.result };
  }

  function claimUnderTest(id, key, operationId, now) {
    const entryKey = underTestKey(id);
    if (store.registerIfAbsent(entryKey, { version: '1', requestKey: key,
      operationId, claimedAt: now.toISOString() })) return true;
    const existing = store.lookup(entryKey);
    return existing?.version === '1' && existing.requestKey === key && existing.operationId === operationId;
  }

  function reserve(intent) {
    let kind = 'conflict';
    let found = null;
    store.update(DEVICE_KEY, (raw) => {
      const current = deviceRecord(raw);
      if (current.active) {
        found = current.active;
        kind = found.requestKey === intent.requestKey ? 'duplicate' : 'conflict';
        return undefined;
      }
      kind = 'reserved';
      found = intent;
      return { version: '1', active: intent };
    });
    return { kind, active: found };
  }

  function transition(key, phases, change) {
    let changed = false;
    let found = null;
    store.update(DEVICE_KEY, (raw) => {
      const current = deviceRecord(raw);
      found = current.active;
      if (!found || found.requestKey !== key || !phases.includes(found.phase)) return undefined;
      const next = change(structuredClone(found));
      if (next === undefined) return undefined;
      changed = true;
      found = next;
      return { version: '1', active: next };
    });
    return { changed, active: found };
  }

  function finish(key, requestHash, planHash, result) {
    const current = active();
    if (!current || current.requestKey !== key || current.requestHash !== requestHash || current.planHash !== planHash) {
      throw new Error('Jessica operation ownership changed before finalization');
    }
    if (current.phase !== 'terminal') {
      if (!transition(key, ['prepared', 'dispatching', 'verifying', 'uncertain'],
        (value) => ({ ...value, phase: 'terminal', result })).changed) {
        throw new Error('Jessica operation could not be finalized');
      }
    }
    const terminal = active();
    if (terminal?.phase !== 'terminal' || terminal.requestKey !== key || terminal.requestHash !== requestHash || terminal.planHash !== planHash) {
      throw new Error('Jessica terminal operation state is invalid');
    }
    const index = { version: '1', operationId: terminal.operationId, result: terminal.result };
    if (!store.registerIfAbsent(operationKey(terminal.operationId), index)) {
      const existing = store.lookup(operationKey(terminal.operationId));
      if (JSON.stringify(existing) !== JSON.stringify(index)) {
        throw new Error('Jessica operation index conflicts with terminal result');
      }
    }
    const record = { version: '1', requestHash, planHash, result: terminal.result };
    if (!store.registerIfAbsent(requestKey(key), record)) {
      const existing = history(key);
      if (existing?.version !== '1' || existing.requestHash !== requestHash || existing.planHash !== planHash ||
          JSON.stringify(existing.result) !== JSON.stringify(record.result)) {
        throw new Error('Jessica request epoch already has a different outcome');
      }
    }
    if (!transition(key, ['terminal'], () => null).changed) {
      throw new Error('Jessica terminal operation could not release device state');
    }
    return record.result;
  }

  return Object.freeze({ active, history, operation, reserve, transition, finish, claimUnderTest });
}

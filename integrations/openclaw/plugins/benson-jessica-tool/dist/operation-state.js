// Operation settlement and physical ownership share one native transaction owner.
// Version 1 needs a reviewed migration: it cannot prove retained robot ownership.
const DEVICE_KEY = 'device:jessica-vacuum';
const requestKey = (key) => `request:${key}`;
const operationKey = (id) => `operation:${id}`;
const underTestKey = (id) => `under-test:${id}`;
export const JESSICA_STATE_OPTIONS = Object.freeze({
  namespace: 'jessica-operations-v1', maxEntries: 10_000, overflowPolicy: 'reject-new',
});

function deviceRecord(value) {
  if (value === undefined) return { version: '2', active: null,
    resource: { generation: 0, owner: null, inFlight: null, uncertain: false } };
  const resource = value?.resource;
  if (value?.version !== '2' || !Object.hasOwn(value, 'active') || !resource ||
      !Number.isSafeInteger(resource.generation) || resource.generation < 0 ||
      !Object.hasOwn(resource, 'owner') || !Object.hasOwn(resource, 'inFlight') ||
      typeof resource.uncertain !== 'boolean') {
    throw new Error('Jessica operation state is invalid');
  }
  const owner = resource.owner;
  if (owner === null) {
    if (value.active !== null || resource.inFlight !== null || resource.uncertain) {
      throw new Error('Jessica resource state is invalid');
    }
  } else {
    if (!owner || owner.generation !== resource.generation || owner.generation < 1 ||
        !['requestKey', 'operationId', 'requestEpoch', 'requesterId'].every((key) =>
          typeof owner[key] === 'string' && owner[key].length > 0)) {
      throw new Error('Jessica resource owner is invalid');
    }
    if (value.active !== null && (!owns(resource, value.active) ||
        !['prepared', 'dispatching', 'verifying', 'uncertain', 'terminal'].includes(value.active.phase) ||
        !Number.isSafeInteger(value.active.revision) || value.active.revision < 0 ||
        !Number.isSafeInteger(value.active.stepIndex) || value.active.stepIndex < 0)) {
      throw new Error('Jessica operation does not own the resource');
    }
    if (resource.inFlight !== null && (!value.active ||
        !sameMutation(resource.inFlight, value.active))) {
      throw new Error('Jessica in-flight mutation is invalid');
    }
  }
  return value;
}

function owns(resource, operation) {
  return operation && resource.owner?.requestKey === operation.requestKey &&
    resource.owner.operationId === operation.operationId &&
    resource.owner.requestEpoch === operation.requestEpoch &&
    resource.owner.requesterId === operation.requesterId &&
    resource.generation === operation.resourceGeneration;
}

function sameMutation(token, operation) {
  return token && token.requestKey === operation.requestKey &&
    token.operationId === operation.operationId && token.generation === operation.resourceGeneration &&
    token.stepIndex === operation.stepIndex;
}

function sameOperation(expected, current) {
  return expected && current && expected.requestKey === current.requestKey &&
    expected.operationId === current.operationId && expected.requestEpoch === current.requestEpoch &&
    expected.requesterId === current.requesterId && expected.resourceGeneration === current.resourceGeneration &&
    expected.requestHash === current.requestHash && expected.planHash === current.planHash;
}

function sameRevision(expected, current) {
  return sameOperation(expected, current) && expected.revision === current.revision &&
    expected.stepIndex === current.stepIndex && expected.phase === current.phase;
}

export function createOperationState(store, { verifyRelease = () => false } = {}) {
  if (!store || typeof store.lookup !== 'function' || typeof store.update !== 'function' ||
      typeof store.registerIfAbsent !== 'function') {
    throw new Error('OpenClaw sync plugin-state store is required');
  }
  if (typeof verifyRelease !== 'function') throw new Error('A deterministic domain release predicate is required');

  const active = () => deviceRecord(store.lookup(DEVICE_KEY)).active;
  const resource = () => deviceRecord(store.lookup(DEVICE_KEY)).resource;
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
    let completed = null;
    store.update(DEVICE_KEY, (raw) => {
      const current = deviceRecord(raw);
      // The native write transaction excludes concurrent finalization/release.
      // History is committed before active state can clear or ownership release.
      completed = history(intent.requestKey) ?? null;
      if (completed) {
        kind = 'completed';
        return undefined;
      }
      if (current.active) {
        found = current.active;
        kind = found.requestKey === intent.requestKey ? 'duplicate' : 'conflict';
        return undefined;
      }
      if (current.resource.owner) {
        kind = 'busy';
        return undefined;
      }
      if (!['requestKey', 'operationId', 'requestEpoch', 'requesterId'].every((key) =>
          typeof intent[key] === 'string' && intent[key].length > 0) ||
          current.resource.generation === Number.MAX_SAFE_INTEGER) {
        throw new Error('Trusted Jessica resource authority is unavailable');
      }
      const generation = current.resource.generation + 1;
      kind = 'reserved';
      found = { ...intent, resourceGeneration: generation, revision: 0 };
      return { ...current, active: found, resource: { generation,
        owner: { requestKey: intent.requestKey, operationId: intent.operationId,
          requestEpoch: intent.requestEpoch, requesterId: intent.requesterId, generation },
        inFlight: null, uncertain: false } };
    });
    return { kind, active: found, completed };
  }

  function transition(expected, phases, change) {
    let changed = false;
    let found = null;
    store.update(DEVICE_KEY, (raw) => {
      const current = deviceRecord(raw);
      found = current.active;
      if (!sameRevision(expected, found) || !phases.includes(found.phase) ||
          !owns(current.resource, found)) return undefined;
      // Observations cannot revoke a POST's exact settlement authority.
      // A lost actor remains pinned until the reviewed recovery boundary.
      if (found.phase === 'dispatching' && current.resource.inFlight !== null) return undefined;
      const next = change(structuredClone(found));
      if (next === undefined) return undefined;
      if (current.resource.inFlight !== null && (next === null ||
          ['prepared', 'terminal'].includes(next.phase) || next.stepIndex !== found.stepIndex)) return undefined;
      if (next !== null && !sameOperation(found, next)) throw new Error('Jessica owner cannot change in an operation transition');
      if (next !== null && found.revision === Number.MAX_SAFE_INTEGER) throw new Error('Jessica operation revision exhausted');
      changed = true;
      found = next === null ? null : { ...next, revision: found.revision + 1 };
      return { ...current, active: found, resource: { ...current.resource,
        uncertain: current.resource.uncertain || next?.phase === 'uncertain' } };
    });
    return { changed, active: found };
  }

  // Pin ownership across the asynchronous POST. A delayed marked dispatch
  // prevents release/reassignment, including after process loss.
  function claimMutation(expected, now) {
    let changed = false;
    let found = null;
    store.update(DEVICE_KEY, (raw) => {
      const current = deviceRecord(raw);
      found = current.active;
      if (!owns(current.resource, expected) || !sameRevision(expected, found) || found.phase !== 'prepared' ||
          current.resource.inFlight !== null || found.revision === Number.MAX_SAFE_INTEGER ||
          current.resource.uncertain) return undefined;
      found = { ...found, revision: found.revision + 1, phase: 'dispatching', dispatch: 'unknown',
        dispatchStartedAt: now.toISOString() };
      changed = true;
      return { ...current, active: found, resource: { ...current.resource,
        inFlight: { requestKey: found.requestKey, operationId: found.operationId,
          generation: found.resourceGeneration, stepIndex: found.stepIndex } } };
    });
    return { changed, active: found };
  }

  function mutationCurrent(expected) {
    const current = deviceRecord(store.lookup(DEVICE_KEY));
    return owns(current.resource, expected) && sameRevision(expected, current.active) && current.active.phase === 'dispatching' &&
      sameMutation(current.resource.inFlight, expected) && !current.resource.uncertain;
  }

  function settleMutation(expected, accepted) {
    let changed = false;
    let found = null;
    store.update(DEVICE_KEY, (raw) => {
      const current = deviceRecord(raw);
      found = current.active;
      if (!owns(current.resource, expected) || !sameRevision(expected, found) || found.phase !== 'dispatching' ||
          found.revision === Number.MAX_SAFE_INTEGER ||
          !sameMutation(current.resource.inFlight, expected)) return undefined;
      found = { ...found, revision: found.revision + 1, phase: 'verifying', dispatch: accepted === true ? 'accepted' : 'unknown' };
      changed = true;
      return { ...current, active: found, resource: { ...current.resource,
        inFlight: accepted === true ? null : current.resource.inFlight,
        uncertain: current.resource.uncertain || accepted !== true } };
    });
    return { changed, active: found };
  }

  // Domain evidence, not run termination or model claims, authorizes release.
  // Until FC1 supplies its reviewed physical predicate, release is disabled.
  function releaseResource(expectedOwner, evidence) {
    let released = false;
    store.update(DEVICE_KEY, (raw) => {
      const current = deviceRecord(raw);
      const owner = current.resource.owner;
      if (!owner || current.active !== null || current.resource.inFlight !== null ||
          !['requestKey', 'operationId', 'requestEpoch', 'requesterId', 'generation'].every((key) =>
            owner[key] === expectedOwner?.[key]) ||
          verifyRelease(structuredClone(owner), structuredClone(evidence)) !== true) return undefined;
      released = true;
      return { ...current, resource: { ...current.resource, owner: null, uncertain: false } };
    });
    return released;
  }

  function finish(expected, result) {
    const { requestKey: key, requestHash, planHash } = expected;
    const retained = history(key);
    const current = active();
    if (retained) {
      if (retained.version !== '1' || retained.requestHash !== requestHash || retained.planHash !== planHash) {
        throw new Error('Jessica request epoch already has a different outcome');
      }
      if (!sameOperation(expected, current) || current.phase !== 'terminal') return retained.result;
    }
    if (!sameOperation(expected, current)) {
      throw new Error('Jessica operation ownership changed before finalization');
    }
    if (resource().inFlight !== null) throw new Error('Jessica dispatch must be reconciled before settlement');
    let terminal = current;
    if (terminal.phase !== 'terminal') {
      const moved = transition(expected, ['prepared', 'dispatching', 'verifying', 'uncertain'],
        (value) => ({ ...value, phase: 'terminal', result }));
      terminal = moved.active;
      if (!moved.changed && terminal?.phase !== 'terminal') {
        throw new Error('Jessica operation could not be finalized');
      }
    }
    if (terminal?.phase !== 'terminal' || !sameOperation(expected, terminal)) {
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
    // Another finisher may already have cleared this exact terminal snapshot.
    // Never clear a later generation or replace its canonical outcome.
    transition(terminal, ['terminal'], () => null);
    return record.result;
  }

  return Object.freeze({ active, resource, history, operation, reserve, transition, finish, claimUnderTest,
    matchesSnapshot: sameRevision,
    matchesOperation: sameOperation,
    claimMutation, mutationCurrent, settleMutation, releaseResource });
}

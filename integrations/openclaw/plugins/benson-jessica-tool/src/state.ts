import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { assertInvocationCurrent } from '../../../benson-routing/core/invocation.js';
import type { InvocationAuthority } from '../../../benson-routing/core/invocation.js';
import { JESSICA_STATE_OPTIONS, type StateRecords } from '../../../../../agents/jessica-vacuum/lib/operation-state.js';
import type { AtomicKeyedState, StateObservation } from '../../../../../agents/jessica-vacuum/lib/ports.js';

type NativeState = Pick<OpenClawPluginApi['runtime']['state'], 'openKeyedStore'>;

/** One invocation-scoped view of the existing host-owned Jessica namespace. */
export function createNativeJessicaState(native: NativeState, authority: InvocationAuthority): AtomicKeyedState<StateRecords> {
  const assertCurrent = () => assertInvocationCurrent(authority);
  assertCurrent();
  const store = native.openKeyedStore<unknown>(JESSICA_STATE_OPTIONS);
  if (typeof store.withCurrent !== 'function') throw new Error('Native action-bound state is unavailable');
  const action = store.withCurrent({ assertCurrent });
  for (const method of ['observe', 'lookup', 'compareAndApply', 'registerIfAbsent'] as const) {
    if (typeof action[method] !== 'function') throw new Error(`Native state ${method} is unavailable`);
  }
  const observations = new WeakMap<object, { readonly key: string; readonly comparison: string }>();
  return {
    async lookup(key) {
      assertCurrent();
      const value = await action.lookup(key);
      assertCurrent();
      return value;
    },
    async observe(key) {
      assertCurrent();
      const observed = await action.observe(key);
      assertCurrent();
      const token = Object.freeze({});
      observations.set(token, { key, comparison: observed.comparison });
      return { value: observed.value, token };
    },
    async compareAndSet(key, observed: StateObservation<unknown>, value) {
      assertCurrent();
      const comparison = observations.get(observed.token);
      if (!comparison || comparison.key !== key) throw new Error('Foreign native state observation');
      const result = await action.compareAndApply(key, comparison.comparison, { operation: 'update', action: 'set', value });
      // Revocation after commit cannot undo it. Reject disclosure; the existing
      // operation owner must read back/reconcile rather than retry a mutation.
      assertCurrent();
      switch (result.status) {
        case 'applied': case 'unchanged': case 'conflict': return result.status;
        default: { const unsupported: never = result; throw new Error(`Unsupported native state result: ${String(unsupported)}`); }
      }
    },
    async registerIfAbsent(key, value) {
      assertCurrent();
      const claimed = await action.registerIfAbsent(key, value);
      assertCurrent();
      return claimed;
    },
  };
}

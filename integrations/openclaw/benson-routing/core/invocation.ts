import { assertion } from './value.js';
/** Live native custody is injected; serialized DTOs and CAS tokens cannot supply it. */
export interface InvocationAuthority { readonly signal: AbortSignal; assertCurrent(): unknown }
export function assertInvocationCurrent(authority: InvocationAuthority): void {
  authority.signal.throwIfAborted();
  assertion(authority.assertCurrent(), 'invocation_authority_must_be_synchronous');
  authority.signal.throwIfAborted();
}

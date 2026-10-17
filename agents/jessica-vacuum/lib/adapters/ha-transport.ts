import { assertInvocationCurrent } from '../../../../integrations/openclaw/benson-routing/core/invocation.js';
import { readFile } from 'node:fs/promises';
import { decode } from '../../../../integrations/openclaw/benson-routing/core/value.js';
import { HaEntitySchema, VACUUM_ENTITY, selectSensors } from '../ha-read.js';
import { deny } from '../errors.js';
import type { InvocationAuthority, MutationGuard } from '../ports.js';

const HA_URL = 'http://127.0.0.1:8123';
const TOKEN_FILE = '/home/oa/.openclaw/secrets/homeassistant-token';
export interface HaTransport {
  get(path: string, authority: InvocationAuthority): Promise<unknown>;
  post(path: string, body: unknown, guard: MutationGuard): Promise<{ accepted: boolean }>;
}
/** Credential acquisition and HTTP are the only responsibilities of this adapter. */
export function createHaTransport({ fetchImpl = fetch, readCredential = () => readFile(TOKEN_FILE, 'utf8') }:
  { fetchImpl?: typeof fetch; readCredential?: () => Promise<string> } = {}): HaTransport {
  async function request(path: string, body: unknown, authority: InvocationAuthority, mutation?: MutationGuard) {
    if (!path.startsWith('/api/') || path.includes('..') || path.includes('?') || path.includes('#')) throw new TypeError('ha_path_invalid');
    authority.signal.throwIfAborted(); assertInvocationCurrent(authority);
    const credential = (await readCredential()).trim();
    if (!credential) deny('READ_UNAVAILABLE', 'verification', 'Home Assistant credential is unavailable');
    authority.signal.throwIfAborted(); assertInvocationCurrent(authority);
    if (mutation) await mutation.assertMutationCurrent();
    // No await is allowed between this live check and initiating the request.
    authority.signal.throwIfAborted(); assertInvocationCurrent(authority);
    return fetchImpl(`${HA_URL}${path}`, { method: mutation ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json', ...(mutation ? { 'Content-Type': 'application/json' } : {}) },
      ...(mutation ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([authority.signal, AbortSignal.timeout(8_000)]) });
  }
  return { async get(path, authority) {
    const response = await request(path, undefined, authority);
    if (!response.ok) deny('READ_UNAVAILABLE', 'verification', 'Home Assistant read is unavailable');
    const value: unknown = await response.json();
    authority.signal.throwIfAborted(); assertInvocationCurrent(authority);
    return value;
  }, async post(path, body, guard) { return { accepted: (await request(path, body, guard, guard)).ok }; } };
}
export function createHaReader(transport: HaTransport, clock = () => new Date()) {
  return { async readState(authority: InvocationAuthority) {
    const state = decode(HaEntitySchema, await transport.get(`/api/states/${VACUUM_ENTITY}`, authority), 'ha_entity_invalid');
    if (state.entity_id !== VACUUM_ENTITY) deny('READ_INVALID', 'verification', 'Home Assistant vacuum identity is invalid');
    return { state, observedAt: clock().toISOString() };
  }, async readSensors(authority: InvocationAuthority) { return selectSensors(await transport.get('/api/states', authority)); } };
}

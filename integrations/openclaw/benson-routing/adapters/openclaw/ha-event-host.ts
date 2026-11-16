import Type, { type Static } from 'typebox';
import type { WebSocket as NativeSocket } from 'openclaw/plugin-sdk/websocket-runtime';
import { HA_URL, readHaCredential } from '../../../../../agents/jessica-vacuum/lib/adapters/ha-transport.js';
import { GrantSchema } from '../../core/contracts.js';
import { fail, freeze, identifier, read, synchronous } from '../../core/value.js';
import { createHaEventConnector, type HaEventSocket } from './ha-event-connection.js';
import { MAX_HA_EVENT_BYTES, type HaEventConnection } from './ha-event-service.js';

// Same canonical grant; inputId is supplied only by the actual admitted event.
const MonitoringGrantSchema = Type.Omit(GrantSchema, ['inputId']);
type MonitoringGrant = Static<typeof MonitoringGrantSchema>;
const ENDPOINT = `${HA_URL.replace(/^http:/, 'ws:')}/api/websocket`;

/** SDK socket ownership stays here. In particular, terminate() while connecting
 * may emit a later error; retain a private sink after intake is detached. */
function adaptSocket(socket: NativeSocket): HaEventSocket {
  let handlers: Parameters<HaEventSocket['listen']>[0] | undefined, closed = false;
  const fault = () => handlers?.error();
  const message = (data: unknown, binary: boolean) => {
    if (binary || !Buffer.isBuffer(data) || data.byteLength > MAX_HA_EVENT_BYTES) { fault(); return; }
    handlers?.message(data.toString('utf8'));
  };
  socket.binaryType = 'nodebuffer';
  socket.on('error', fault);
  socket.on('close', () => handlers?.close());
  socket.on('message', message);
  return {
    listen(value) {
      if (closed || handlers) fail('ha_host_socket_retired');
      handlers = value;
      return () => { handlers = undefined; socket.off('message', message); };
    },
    send(frame) {
      if (closed || !handlers || Buffer.byteLength(frame, 'utf8') > MAX_HA_EVENT_BYTES) fail('ha_host_socket_retired');
      socket.send(frame, error => { if (error) fault(); });
    },
    close() {
      if (closed) return;
      closed = true; handlers = undefined; socket.off('message', message);
      socket.terminate();
    },
  };
}

/** Unregistered host assembly, one explicit monitoring grant / connection
 * lifetime. Source construction performs no credential, SDK or network I/O.
 * Default callbacks are production-capable and require separate live approval. */
export function createHaEventHostBinding(deps: {
  endpoint: string; grant: MonitoringGrant; revoked: AbortSignal; now(): number;
  subscriptionId: number; handshakeTimeoutMs: number;
  loadSocket?: () => Promise<typeof NativeSocket>;
  readCredential?: (signal: AbortSignal) => Promise<string>;
}) {
  const { endpoint, revoked, now, subscriptionId, handshakeTimeoutMs,
    loadSocket = async () => (await import('openclaw/plugin-sdk/websocket-runtime')).WebSocket,
    readCredential = readHaCredential } = deps;
  const grant = freeze(read(MonitoringGrantSchema, deps.grant, 'ha_host_grant_invalid'));
  if (endpoint !== ENDPOINT || grant.sourceType !== 'ha' || grant.scopes.length !== 1 || grant.scopes[0] !== 'read' ||
      ![grant.sourceRef, grant.subject, grant.authorityRef, grant.authorityRevision].every(identifier)) fail('ha_host_binding_invalid');
  const clock = () => {
    const value = synchronous(now(), 'ha_host_clock_invalid');
    if (!Number.isSafeInteger(value) || value < 0) fail('ha_host_clock_invalid');
    return value;
  };
  const lifetime = new AbortController();
  let used = false, timer: ReturnType<typeof setTimeout> | undefined, startup: ReturnType<typeof setTimeout> | undefined;
  let caller: AbortSignal | undefined;
  let Socket: typeof NativeSocket | undefined;
  const retire = () => {
    if (lifetime.signal.aborted) return;
    clearTimeout(timer); clearTimeout(startup);
    caller?.removeEventListener('abort', retire); revoked.removeEventListener('abort', retire);
    lifetime.abort();
  };
  const current = () => {
    if (lifetime.signal.aborted || revoked.aborted || caller?.aborted || clock() >= grant.expiresAt) {
      retire(); fail('ha_host_authority_retired');
    }
  };
  const connector = createHaEventConnector({ sourceRef: grant.sourceRef, domain: grant.domain, subscriptionId, handshakeTimeoutMs,
    createSocket(signal) {
      current();
      if (!Socket) fail('ha_host_socket_unavailable');
      signal.addEventListener('abort', retire, { once: true });
      return adaptSocket(new Socket(endpoint, { maxPayload: MAX_HA_EVENT_BYTES, perMessageDeflate: false,
        followRedirects: false, handshakeTimeout: handshakeTimeoutMs }));
    },
    async readCredential(signal) {
      current(); signal.throwIfAborted();
      const credential = await readCredential(signal);
      current(); signal.throwIfAborted();
      return credential;
    },
    readAuthority(input) { current(); return { ...grant, inputId: input.source.inputId }; },
  });
  return Object.freeze({
    readAuthority: connector.readAuthority,
    async connect(signal: AbortSignal): Promise<HaEventConnection> {
      if (used) fail('ha_host_already_used');
      used = true; caller = signal;
      try {
        current();
        const remaining = grant.expiresAt - clock();
        if (remaining < 1 || remaining > 2_147_483_647) fail('ha_host_lifetime_invalid');
        caller.addEventListener('abort', retire, { once: true }); revoked.addEventListener('abort', retire, { once: true });
        timer = setTimeout(retire, remaining);
        startup = setTimeout(retire, handshakeTimeoutMs);
        let rejectLoad!: () => void;
        const stopped = new Promise<never>((_, reject) => { rejectLoad = () => reject(new Error('ha_host_retired')); });
        lifetime.signal.addEventListener('abort', rejectLoad, { once: true });
        try { Socket = await Promise.race([Promise.resolve().then(loadSocket), stopped]); }
        finally { lifetime.signal.removeEventListener('abort', rejectLoad); }
        current();
        const connection = await connector.connect(lifetime.signal);
        return Object.freeze({ ...connection,
          async subscribe(...args: Parameters<HaEventConnection['subscribe']>) {
            const unsubscribe = await connection.subscribe(...args);
            clearTimeout(startup);
            return unsubscribe;
          },
        });
      } catch { retire(); throw new Error('ha_host_unavailable'); }
    },
  });
}

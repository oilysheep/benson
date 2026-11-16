import type { SourceInput } from '../../core/contracts.js';
import type { GrantedSourceDependencies } from '../../core/request-control.js';
import { boundedCopy, fail, identifier, plain, synchronous } from '../../core/value.js';
import { MAX_HA_EVENT_BYTES, type HaEventConnection } from './ha-event-service.js';

/** Fresh socket; install listeners synchronously before delivering protocol
 * traffic. The host owns endpoint/TLS selection; this module never opens one. */
export interface HaEventSocket {
  listen(handlers: { message(data: unknown): void; close(): void; error(): void }): () => void;
  send(frame: string): void;
  close(): void;
}
type Custody = { current(): void; subscribed(): void; close(): void };

/** Unregistered, single-subscription protocol adapter. All I/O and authority
 * acquisition are injected; authentication never manufactures a Benson grant. */
export function createHaEventConnector(deps: {
  sourceRef: string; domain: SourceInput['domain']; subscriptionId: number; handshakeTimeoutMs: number;
  createSocket(signal: AbortSignal): HaEventSocket;
  readCredential(signal: AbortSignal): Promise<string>;
  readAuthority: GrantedSourceDependencies['readAuthority'];
}) {
  const { sourceRef, domain, subscriptionId, handshakeTimeoutMs, createSocket, readCredential, readAuthority } = deps;
  if (!identifier(sourceRef) || !Number.isSafeInteger(subscriptionId) || subscriptionId < 1 ||
      !Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1 || handshakeTimeoutMs > 2_147_483_647) fail('ha_connection_binding_invalid');
  let active: Custody | undefined;
  return Object.freeze({
    readAuthority(input: Parameters<GrantedSourceDependencies['readAuthority']>[0]) {
      try {
        if (!active) fail('ha_connection_retired');
        active.subscribed();
        if (input.schemaVersion !== 1 || input.source.type !== 'ha' || input.source.ref !== sourceRef ||
            input.domain !== domain || input.scope !== 'read') fail('ha_connection_grant_binding_invalid');
        // The existing Request Controller validates the returned GrantSchema,
        // input ID, scope, identity/revision, expiry and live revocation state.
        return synchronous(readAuthority(input), 'source_authority_must_be_synchronous');
      } catch { active?.close(); throw new Error('ha_connection_grant_unavailable'); }
    },
    connect(signal: AbortSignal): Promise<HaEventConnection> {
      if (active) fail('ha_connection_already_open');
      let phase: 'greeting' | 'credential' | 'auth' | 'authenticated' | 'subscribing' | 'subscribed' | 'retired' = 'greeting';
      const abort = new AbortController();
      let socket: HaEventSocket | undefined, detach: (() => void) | undefined;
      let receive: ((frame: string) => void) | undefined, gap: (() => void) | undefined;
      let resolveReady!: (connection: HaEventConnection) => void, rejectReady!: (error: Error) => void;
      let resolveSubscription: ((unsubscribe: () => void) => void) | undefined, rejectSubscription: ((error: Error) => void) | undefined;
      const ready = new Promise<HaEventConnection>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      const custody: Custody = {
        current() {
          if (active !== custody || abort.signal.aborted || signal.aborted || phase === 'retired') fail('ha_connection_retired');
        },
        subscribed() { custody.current(); if (phase !== 'subscribed') fail('ha_subscription_unavailable'); },
        close() { retire(false); },
      };
      active = custody;
      function retire(notify: boolean) {
        if (phase === 'retired') return;
        phase = 'retired';
        if (active === custody) active = undefined;
        clearTimeout(timer); signal.removeEventListener('abort', onAbort); abort.abort();
        try { detach?.(); } catch { /* Retired custody remains authoritative. */ }
        try { socket?.close(); } catch { /* No replay or second close attempt. */ }
        rejectReady(new Error('ha_connection_unavailable'));
        rejectSubscription?.(new Error('ha_subscription_unavailable'));
        if (notify) { try { gap?.(); } catch { /* Already retired and closed. */ } }
      }
      const onAbort = () => retire(true);
      const timer = setTimeout(() => retire(true), handshakeTimeoutMs);
      const connection = Object.freeze<HaEventConnection>({
        sourceRef: sourceRef, subscriptionId: subscriptionId,
        assertCurrent: custody.current,
        subscribe(eventType, onEvent, onGap) {
          custody.current();
          if (eventType !== 'state_changed' || phase !== 'authenticated') { retire(true); return Promise.reject(new Error('ha_subscription_unavailable')); }
          receive = onEvent; gap = onGap; phase = 'subscribing';
          const pending = new Promise<() => void>((resolve, reject) => { resolveSubscription = resolve; rejectSubscription = reject; });
          try { socket!.send(JSON.stringify({ id: subscriptionId, type: 'subscribe_events', event_type: eventType })); }
          catch { retire(true); }
          return pending;
        },
        close: custody.close,
      });
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        custody.current();
        socket = synchronous(createSocket(abort.signal), 'ha_socket_must_be_synchronous');
        const remove = socket.listen({ close: () => retire(true), error: () => retire(true), message(data) {
          try {
            custody.current();
            if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_HA_EVENT_BYTES) fail('ha_protocol_frame_invalid');
            const frame = boundedCopy(JSON.parse(data));
            if (!plain(frame)) fail('ha_protocol_frame_invalid');
            if (phase === 'greeting' && frame.type === 'auth_required') {
              phase = 'credential';
              Promise.resolve().then(() => { custody.current(); return readCredential(abort.signal); }).then(credential => {
                custody.current();
                if (phase !== 'credential' || typeof credential !== 'string' || !credential.trim()) fail('ha_auth_unavailable');
                phase = 'auth'; socket!.send(JSON.stringify({ type: 'auth', access_token: credential.trim() }));
              }).catch(() => retire(true));
            } else if (phase === 'auth' && frame.type === 'auth_ok') {
              phase = 'authenticated'; resolveReady(connection);
            } else if (phase === 'subscribing' && frame.type === 'result' && frame.id === subscriptionId && frame.success === true && frame.result === null) {
              phase = 'subscribed'; clearTimeout(timer); resolveSubscription!(custody.close);
            } else if (phase === 'subscribed' && frame.type === 'event' && frame.id === subscriptionId) {
              receive!(data);
            } else fail('ha_protocol_sequence_invalid');
          } catch { retire(true); }
        } });
        if (abort.signal.aborted) remove(); else detach = remove;
      } catch { retire(true); }
      return ready;
    },
  });
}

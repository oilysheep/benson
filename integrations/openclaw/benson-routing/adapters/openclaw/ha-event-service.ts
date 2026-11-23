import { createHash } from 'node:crypto';
import type { OpenClawPluginService } from 'openclaw/plugin-sdk/plugin-entry';
import type { DomainResult, SourceInput } from '../../core/contracts.js';
import { assertion, boundedCopy, fail, freeze, identifier, MAX_BYTES, plain, synchronous } from '../../core/value.js';

// Raw transport budget, independent of the Controller's 8KiB request budget.
export const MAX_HA_EVENT_BYTES = MAX_BYTES;
/** Closed, payload-free categories. Diagnostics never confer custody or alter
 * retirement; callers may retain elapsed time alongside these codes. */
export type HaEventDiagnosticCode =
  | 'host_socket_error' | 'host_payload_limit' | 'host_socket_close' | 'host_send_failed'
  | 'host_binary_frame' | 'host_frame_type' | 'host_frame_bytes'
  | 'host_grant_expired' | 'host_startup_timeout' | 'host_revoked' | 'host_caller_abort' | 'host_connect_failed'
  | 'connector_grant_rejected' | 'connector_closed' | 'connector_signal_abort' | 'connector_handshake_timeout'
  | 'connector_socket_close' | 'connector_socket_error' | 'connector_subscribe_rejected' | 'connector_send_failed'
  | 'connector_current_failed' | 'connector_frame_bytes' | 'connector_frame_json' | 'connector_frame_bounds'
  | 'connector_sequence' | 'connector_receive_failed' | 'connector_credential_failed' | 'connector_open_failed'
  | 'connector_authenticated' | 'connector_subscribed'
  | 'service_transport_gap' | 'service_current_failed' | 'service_frame_bytes' | 'service_frame_json'
  | 'service_frame_bounds' | 'service_frame_shape' | 'service_domain_failed' | 'service_observer_failed'
  | 'service_start_failed' | 'service_stop';
export type HaEventDiagnostics = (code: HaEventDiagnosticCode) => void;
export function reportHaEventDiagnostic(report: HaEventDiagnostics | undefined, code: HaEventDiagnosticCode): void {
  if (!report) return;
  // Finish the synchronous lifecycle transition before an observer can reenter.
  queueMicrotask(() => {
    try { void Promise.resolve(report(code)).catch(() => {}); }
    catch { /* Diagnostic failure must not change admission or cleanup. */ }
  });
}
/** Retained transport custody, supplied by a future approved authenticated
 * adapter. A payload field cannot supply this capability. No adapter is wired. */
export interface HaEventConnection {
  readonly sourceRef: string;
  readonly subscriptionId: number;
  assertCurrent(): void;
  subscribe(eventType: 'state_changed', receive: (frame: string) => void, gap: () => void): Promise<() => void>;
  close(): void;
}
interface EventEntry {
  domain: SourceInput['domain'];
  entityIds: readonly string[];
  /** Domain-owned, versioned request projection. No raw-frame fallback. */
  prepareRequest(frame: unknown): string;
  execute(input: SourceInput, assertCurrent: () => void): DomainResult | Promise<DomainResult>;
}
interface ServiceState { abort: AbortController; connection?: HaEventConnection; unsubscribe?: () => void; accepting: boolean; closed: boolean; pending: boolean }
/** Unregistered native service boundary. Synchronous intake has no queue or
 * coalescing. A gap/error latches admission closed; no reconnect/replay occurs. */
export function createHaEventService(deps: {
  sourceRef: string; entries: readonly EventEntry[];
  connect(signal: AbortSignal): Promise<HaEventConnection>;
  observe(result: DomainResult): void;
  diagnose?: HaEventDiagnostics;
}): OpenClawPluginService {
  if (!identifier(deps.sourceRef)) fail('ha_source_binding_invalid');
  const routes = new Map<string, EventEntry>();
  for (const entry of deps.entries) for (const entity of entry.entityIds) {
    if (!identifier(entity) || routes.has(entity)) fail('ha_route_binding_invalid');
    routes.set(entity, Object.freeze({ ...entry, entityIds: Object.freeze([...entry.entityIds]) }));
  }
  let active: ServiceState | undefined;
  const close = (state: ServiceState) => {
    if (state.connection && !state.closed) { state.closed = true; state.connection.close(); }
  };
  return {
    id: 'benson-ha-event-ingress',
    async start(context) {
      if (active) fail('ha_service_already_started');
      const state: ServiceState = { abort: new AbortController(), accepting: false, closed: false, pending: false };
      active = state;
      const current = () => {
        state.abort.signal.throwIfAborted();
        if (active !== state || !state.accepting || !state.connection || state.connection.sourceRef !== deps.sourceRef) fail('ha_source_retired');
        assertion(state.connection.assertCurrent(), 'ha_source_custody_must_be_synchronous');
      };
      const gap = (code: HaEventDiagnosticCode = 'service_transport_gap') => {
        if (state.abort.signal.aborted) return;
        state.accepting = false;
        reportHaEventDiagnostic(deps.diagnose, code);
        state.abort.abort(); close(state);
        if (active === state) context.serviceHealth?.reportFailure(new Error('ha_event_gap_reconciliation_required'));
      };
      try {
        const connection = await deps.connect(state.abort.signal);
        if (active !== state || state.abort.signal.aborted) { connection.close(); return; }
        state.connection = connection;
        if (connection.sourceRef !== deps.sourceRef || !Number.isSafeInteger(connection.subscriptionId) || connection.subscriptionId < 1) fail('ha_source_binding_invalid');
        state.accepting = true; current();
        const unsubscribe = await connection.subscribe('state_changed', frame => {
          let failure: HaEventDiagnosticCode = 'service_current_failed';
          try {
            current();
            failure = 'service_frame_bytes';
            if (typeof frame !== 'string' || Buffer.byteLength(frame, 'utf8') > MAX_HA_EVENT_BYTES) fail('ha_event_bytes_exceeded');
            failure = 'service_frame_json';
            const parsed: unknown = JSON.parse(frame);
            failure = 'service_frame_bounds';
            const raw = boundedCopy(parsed);
            failure = 'service_frame_shape';
            if (!plain(raw) || raw.type !== 'event' || raw.id !== connection.subscriptionId || !plain(raw.event) ||
                raw.event.event_type !== 'state_changed' || !plain(raw.event.data) || typeof raw.event.data.entity_id !== 'string') fail('ha_event_frame_invalid');
            const entry = routes.get(raw.event.data.entity_id);
            if (!entry) return; // Unsubscribed domain/entity: never guess a route.
            // No queue/coalescing: overlapping async intake retires this source.
            if (state.pending) fail('ha_event_overlap_reconciliation_required');
            failure = 'service_domain_failed';
            const request = synchronous(entry.prepareRequest(freeze(raw)), 'ha_event_projection_must_be_synchronous');
            failure = 'service_current_failed'; current();
            const input: SourceInput = { schemaVersion: 1, kind: 'benson.source-input', domain: entry.domain, scope: 'read',
              source: { type: 'ha', ref: deps.sourceRef, inputId: `ha-${createHash('sha256').update(frame).digest('hex')}` }, request };
            failure = 'service_domain_failed';
            const result = entry.execute(input, current);
            const observe = (value: DomainResult) => {
              failure = 'service_current_failed'; current();
              failure = 'service_observer_failed'; deps.observe(value);
            };
            if (result instanceof Promise) {
              state.pending = true;
              void result.then(value => { observe(value); state.pending = false; }).catch(() => gap(failure));
            } else observe(result);
          } catch { gap(failure); }
        }, () => gap());
        if (active !== state || state.abort.signal.aborted) unsubscribe();
        else state.unsubscribe = unsubscribe;
      } catch {
        gap('service_start_failed'); state.abort.abort();
        close(state);
        if (active === state) active = undefined;
        throw new Error('ha_event_service_start_failed');
      }
    },
    stop() {
      const state = active; if (!state) return;
      reportHaEventDiagnostic(deps.diagnose, 'service_stop');
      active = undefined; state.accepting = false; state.abort.abort();
      try { state.unsubscribe?.(); } finally { close(state); }
    },
  };
}

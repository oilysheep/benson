import { createHash } from 'node:crypto';
import type { OpenClawPluginService } from 'openclaw/plugin-sdk/plugin-entry';
import type { DomainResult, SourceInput } from '../../core/contracts.js';
import { assertion, boundedCopy, fail, identifier, plain } from '../../core/value.js';

export const MAX_HA_EVENT_BYTES = 8192;
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
  execute(input: SourceInput, assertCurrent: () => void): DomainResult;
}
interface ServiceState { abort: AbortController; connection?: HaEventConnection; unsubscribe?: () => void; accepting: boolean; closed: boolean }
/** Unregistered native service boundary. Synchronous intake has no queue or
 * coalescing. A gap/error latches admission closed; no reconnect/replay occurs. */
export function createHaEventService(deps: {
  sourceRef: string; entries: readonly EventEntry[];
  connect(signal: AbortSignal): Promise<HaEventConnection>;
  observe(result: DomainResult): void;
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
      const state: ServiceState = { abort: new AbortController(), accepting: false, closed: false };
      active = state;
      const current = () => {
        state.abort.signal.throwIfAborted();
        if (active !== state || !state.accepting || !state.connection || state.connection.sourceRef !== deps.sourceRef) fail('ha_source_retired');
        assertion(state.connection.assertCurrent(), 'ha_source_custody_must_be_synchronous');
      };
      const gap = () => {
        state.accepting = false;
        if (active === state) context.serviceHealth?.reportFailure(new Error('ha_event_gap_reconciliation_required'));
      };
      try {
        const connection = await deps.connect(state.abort.signal);
        if (active !== state || state.abort.signal.aborted) { connection.close(); return; }
        state.connection = connection;
        if (connection.sourceRef !== deps.sourceRef || !Number.isSafeInteger(connection.subscriptionId) || connection.subscriptionId < 1) fail('ha_source_binding_invalid');
        state.accepting = true; current();
        const unsubscribe = await connection.subscribe('state_changed', frame => {
          try {
            current();
            if (typeof frame !== 'string' || Buffer.byteLength(frame, 'utf8') > MAX_HA_EVENT_BYTES) fail('ha_event_bytes_exceeded');
            const raw = boundedCopy(JSON.parse(frame));
            if (!plain(raw) || raw.type !== 'event' || raw.id !== connection.subscriptionId || !plain(raw.event) ||
                raw.event.event_type !== 'state_changed' || !plain(raw.event.data) || typeof raw.event.data.entity_id !== 'string') fail('ha_event_frame_invalid');
            const entry = routes.get(raw.event.data.entity_id);
            if (!entry) return; // Unsubscribed domain/entity: never guess a route.
            const input: SourceInput = { schemaVersion: 1, kind: 'benson.source-input', domain: entry.domain, scope: 'read',
              source: { type: 'ha', ref: deps.sourceRef, inputId: `ha-${createHash('sha256').update(frame).digest('hex')}` }, request: frame };
            const result = entry.execute(input, current);
            current(); deps.observe(result);
          } catch { gap(); }
        }, gap);
        if (active !== state || state.abort.signal.aborted) unsubscribe();
        else state.unsubscribe = unsubscribe;
      } catch {
        gap(); state.abort.abort();
        close(state);
        if (active === state) active = undefined;
        throw new Error('ha_event_service_start_failed');
      }
    },
    stop() {
      const state = active; if (!state) return;
      active = undefined; state.accepting = false; state.abort.abort();
      try { state.unsubscribe?.(); } finally { close(state); }
    },
  };
}

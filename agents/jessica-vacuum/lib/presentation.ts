import { freeze, plain, boundedCopy } from '../../../integrations/openclaw/benson-routing/core/value.js';
import type { Presentation } from '../../../integrations/openclaw/benson-routing/core/response-control.js';
const unsupported = (reason = 'semantic_rendering_required'): Presentation => freeze({ kind: 'unsupported', reason });
const rendered = (text: string, pending: unknown = null): Presentation => freeze({ kind: 'rendered', text, pendingContext: structuredClone(boundedCopy(pending)) });
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export function renderJessicaPresentation(raw: unknown, language: 'en' | 'he'): Presentation {
  if (!plain(raw) || Object.keys(raw).sort().join(',') !== 'data,domain,error,operation,pendingContext,schemaVersion,status,verified,warnings') return unsupported('unsupported_result_shape');
  if (raw.schemaVersion !== '1') return unsupported('unsupported_schema');
  const data = raw.data;
  if (raw.status === 'clarification_required') {
    if (language !== 'he' || raw.verified !== false || raw.error !== null || !plain(data) || Object.keys(data).sort().join(',') !== 'candidates,question' || !text(data.question) || !Array.isArray(data.candidates) || !plain(raw.pendingContext)) return unsupported();
    return rendered(data.question, raw.pendingContext);
  }
  if (raw.status === 'failure') return language === 'en' && raw.operation === 'clean' && raw.verified === false && data === null && plain(raw.error) && raw.error.sideEffects === 'possible' && raw.error.retryMode === 'reconcile' ?
    rendered("I couldn't verify whether Jessica started cleaning. The command may have had an effect, so I won't retry it before checking the current state.") : unsupported();
  if (raw.status !== 'success' || raw.verified !== true || !plain(data)) return unsupported('unverified_result');
  const clean = Array.isArray(raw.warnings) && !raw.warnings.length && raw.error === null && raw.pendingContext === null;
  if (raw.operation === 'status' && language === 'en' && clean && data.kind === 'status' && data.state === 'docked' && typeof data.batteryLevel === 'number' && Number.isSafeInteger(data.batteryLevel) && data.batteryLevel >= 0 && data.batteryLevel <= 100) return rendered(`Jessica is docked with ${data.batteryLevel}% battery.`);
  if (raw.operation === 'rooms' && language === 'he' && clean && data.kind === 'rooms' && Array.isArray(data.rooms) && data.rooms.length > 0) {
    const labels: string[] = [];
    for (const room of data.rooms) { if (!plain(room) || !text(room.label) || typeof room.enabled !== 'boolean') return unsupported(); labels.push(`${room.label.trim()} (${room.enabled ? 'פעיל' : 'לא פעיל'})`); }
    return rendered(`החדרים במפה: ${labels.join(', ')}.`);
  }
  if (raw.operation === 'clean' && language === 'he' && clean && data.outcome === 'started' && data.dispatch === 'accepted' && Array.isArray(data.rooms) && data.rooms.length === 1 && text(data.rooms[0])) return rendered('הניקוי בחדר שביקשת התחיל.');
  if (raw.operation === 'maintenance' && language === 'en' && data.kind === 'maintenance' && Array.isArray(data.items) && data.items.length === 1 &&
    plain(data.items[0]) && data.items[0].name === 'main_brush_remaining' && typeof data.items[0].value === 'number' && Number.isFinite(data.items[0].value) && data.items[0].unit === '%' &&
    Array.isArray(raw.warnings) && raw.warnings.length === 1 && plain(raw.warnings[0]) && raw.warnings[0].code === 'PARTIAL_HEALTH_DATA' && raw.warnings[0].message === 'Dustbin sensor data is unavailable' && raw.error === null && raw.pendingContext === null) return rendered(`The main brush has ${data.items[0].value}% remaining. Warning: dustbin sensor data is unavailable.`);
  return unsupported();
}

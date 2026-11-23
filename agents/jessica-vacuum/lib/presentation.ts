import { freeze, plain, boundedCopy, decode } from '../../../integrations/openclaw/benson-routing/core/value.js';
import type { Presentation } from '../../../integrations/openclaw/benson-routing/core/response-control.js';
import type { AnyDomainResult } from '../../../integrations/openclaw/benson-routing/core/contracts.js';
import { validateDomainResultEnvelope, readDomainFactsData } from '../../../integrations/openclaw/benson-routing/core/domain-result.js';
import { validateResult, ResultSchema } from './results.js';
import { formatUserDatetime } from '../../../shared/benson-datetime.js';
/** Shared status wording derives only from validated domain facts, never model prose. */
export function renderJessicaStatusText(raw: unknown, now: Date): string {
  const facts = validateResult(raw, null, now);
  if (facts.operation !== 'status') throw new Error('jessica_status_presentation_operation');
  const data = facts.data && 'kind' in facts.data && facts.data.kind === 'status' ? facts.data : null;
  return data && facts.status === 'success' ?
    `מצב Jessica: ${data.state}; סוללה: ${data.batteryLevel === null ? 'לא ידוע' : `${data.batteryLevel}%`}. לפי נתוני Home Assistant שנקראו ${formatUserDatetime(data.observedAt, 'Asia/Jerusalem', { now })}.` :
    'לא ניתן לאמת כעת את מצב Jessica. לא בוצעה פעולה במכשיר.';
}
/** Live custody establishes provenance; domain facts establish response claims. */
export function renderJessicaDomainResult(raw: AnyDomainResult, options: { language: 'en' | 'he'; now?: string }): Presentation {
  const value = validateDomainResultEnvelope(raw);
  // Native Response preparation re-renders the action entry's start facts;
  // neither Main wording nor docked/completed observations prove completion.
  if (value.domain === 'jessica-vacuum' && value.executionMode === 'deterministic' && value.operation === 'clean' &&
    options.language === 'he' && value.pendingContext === null && !value.warnings.length && !value.evidence.gaps.length) {
    try {
      // The retained action witness owns Plan-dependent semantic validation.
      // Presentation decodes its validated facts without inventing a second Plan.
      const facts = decode(ResultSchema, { schemaVersion: value.domainSchemaVersion, domain: value.domain, operation: value.operation,
        status: value.outcome.status, verified: value.facts.verified, data: readDomainFactsData(value.facts.data).value,
        warnings: value.warnings, error: value.failures.domain, pendingContext: null }, 'start_presentation_invalid');
      if (facts.status === 'success') {
        const data = facts.data;
        if (!data || !('appliedSettings' in data) || data.outcome !== 'started' || data.rooms.length !== 1 ||
          Object.keys(data.appliedSettings).length || value.facts.verificationScope.length !== 1 ||
          value.facts.verificationScope[0] !== 'room_cleaning_start' || value.effects.status !== 'known' ||
          value.effects.refs.length !== 1 || value.effects.refs[0] !== data.operationId ||
          value.effects.reconciliation.required || value.uncertainty.length || value.failures.handling !== null) return unsupported('unsupported_start_facts');
      } else if (facts.status !== 'failure' || facts.verified !== false || !facts.error || value.facts.verificationScope.length ||
        value.effects.status !== (facts.error.sideEffects === 'possible' ? 'possible' : facts.error.sideEffects === 'observed' ? 'known' : 'none') ||
        !value.failures.handling || value.failures.handling.code !== facts.error.code ||
        value.failures.handling.message !== facts.error.message || value.failures.handling.retryable !== false) return unsupported('unsupported_start_failure');
      return rendered(renderJessicaStartText(facts));
    } catch { return unsupported('unsupported_start_facts'); }
  }
  if (value.domain === 'jessica-vacuum' && value.executionMode === 'agentic' && value.outcome.status === 'unknown' &&
    value.outcome.disposition === 'unresolved' && (value.uncertainty.length > 0 || value.evidence.gaps.length > 0) && !value.warnings.length && value.pendingContext === null) {
    return rendered(options.language === 'he'
      ? 'לא ניתן לאמת את השלמת בקשת Jessica. תיעוד ההשפעות נשמר; יש לבדוק את המצב לפני ניסיון נוסף. לא אבצע את הפעולה שוב אוטומטית.'
      : 'The Jessica request has no verified final outcome. Effect evidence is retained; check the current state before retrying. I will not repeat the operation automatically.');
  }
  if (value.domain === 'jessica-vacuum' && value.executionMode === 'agentic' && value.operation !== 'status' &&
    value.effects.status === 'known' && value.effects.refs.length > 0 && !value.effects.reconciliation.required &&
    !value.warnings.length && !value.uncertainty.length && !value.evidence.gaps.length && value.pendingContext === null &&
    value.outcome.status === 'success' && value.facts.verified && value.failures.domain === null && value.failures.handling === null) {
    return renderJessicaPresentation({ schemaVersion: value.domainSchemaVersion, domain: value.domain, operation: value.operation,
      status: value.outcome.status, verified: value.facts.verified, data: readDomainFactsData(value.facts.data).value, warnings: value.warnings,
      error: null, pendingContext: null }, options.language);
  }
  if (value.domain !== 'jessica-vacuum' || value.operation !== 'status' ||
    value.effects.status !== 'none' || value.warnings.length || value.uncertainty.length || value.evidence.gaps.length ||
    value.pendingContext !== null || value.content?.state !== 'usable' || value.content.language !== options.language ||
    !['success', 'failure'].includes(value.outcome.status)) return unsupported('unsupported_domain_presentation');
  try {
    if (!options.now || !Number.isFinite(Date.parse(options.now))) return unsupported('status_presentation_clock_required');
    const facts = validateResult({ schemaVersion: value.domainSchemaVersion, domain: value.domain, operation: value.operation,
      status: value.outcome.status, verified: value.facts.verified, data: readDomainFactsData(value.facts.data).value, warnings: value.warnings,
      error: value.failures.domain, pendingContext: value.pendingContext }, null, new Date(options.now));
    if (options.language === 'en') return renderJessicaPresentation(facts, 'en');
    return rendered(renderJessicaStatusText(facts, new Date(options.now)));
  } catch { return unsupported('unsupported_status_facts'); }
}
const unsupported = (reason = 'semantic_rendering_required'): Presentation => freeze({ kind: 'unsupported', reason });
const rendered = (text: string, pending: unknown = null): Presentation => freeze({ kind: 'rendered', text, pendingContext: structuredClone(boundedCopy(pending)) });
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
/** The deterministic action entry supplies domain-validated start facts only. */
export function renderJessicaStartText(value: import('./results.js').Result): string {
  if (value.status === 'success') {
    const presentation = renderJessicaPresentation(value, 'he');
    if (presentation.kind !== 'rendered') throw new Error('jessica_start_presentation_unsupported');
    return presentation.text;
  }
  return value.error?.sideEffects === 'none'
    ? 'לא אומתה תחילת ניקוי. לא אבצע ניסיון נוסף אוטומטית.'
    : 'לא הצלחתי לאמת את תחילת הניקוי. ייתכן שהפעולה בוצעה; לא אבצע אותה שוב אוטומטית.';
}
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

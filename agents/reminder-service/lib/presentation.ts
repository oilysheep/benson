import { formatUserDatetime } from '../../../shared/benson-datetime.js';
import type { ListResult } from './results.js';
import { plain, freeze } from '../../../integrations/openclaw/benson-routing/core/value.js';
import type { Presentation } from '../../../integrations/openclaw/benson-routing/core/response-control.js';
import type { AnyDomainResult } from '../../../integrations/openclaw/benson-routing/core/contracts.js';
import { validateDomainResultEnvelope } from '../../../integrations/openclaw/benson-routing/core/domain-result.js';
/** Full-list prepared content stays domain-owned; unsupported qualifications block. */
export function renderReminderDomainResult(raw: AnyDomainResult, options: { language: 'en' | 'he'; timezone?: string; now?: string }): Presentation {
  const value = validateDomainResultEnvelope(raw);
  if (value.domain === 'reminder' && value.executionMode === 'agentic' && value.outcome.status === 'unknown' &&
    value.outcome.disposition === 'unresolved' && (value.uncertainty.length > 0 || value.evidence.gaps.length > 0) && !value.warnings.length && value.pendingContext === null) {
    return rendered(options.language === 'he'
      ? 'לא ניתן לאמת את השלמת בקשת התזכורת. תיעוד ההשפעות נשמר; יש לבדוק את המצב לפני ניסיון נוסף. לא אבצע את הפעולה שוב אוטומטית.'
      : 'The Reminder request has no verified final outcome. Effect evidence is retained; check the current state before retrying. I will not repeat the operation automatically.');
  }
  if (value.domain === 'reminder' && value.executionMode === 'agentic' && ['create', 'delete'].includes(value.operation ?? '') &&
    value.outcome.status === 'success' && value.facts.verified === true && value.effects.status === 'known' &&
    value.effects.refs.length > 0 && !value.effects.reconciliation.required && !value.evidence.gaps.length &&
    !value.uncertainty.length && !value.warnings.length && value.pendingContext === null &&
    value.failures.domain === null && value.failures.handling === null) {
    return renderReminderPresentation({ status: value.outcome.status, domain: value.domain, operation: value.operation,
      verified: value.facts.verified, data: value.facts.data, warnings: value.warnings, error: null, pendingContext: null },
    options.language, options.timezone, options.now);
  }
  if (value.domain !== 'reminder' || value.executionMode !== 'deterministic' || value.operation !== 'list' ||
    value.effects.status !== 'none' || value.warnings.length || value.uncertainty.length || value.evidence.gaps.length ||
    value.pendingContext !== null || value.content?.state !== 'usable' || value.content.language !== options.language ||
    !['success', 'failure'].includes(value.outcome.status)) return unsupported('unsupported_domain_presentation');
  return rendered(value.content.text);
}
export function renderReminderList(result: ListResult, now: Date): string {
  if (result.status === 'failure') return 'לא ניתן לאמת כעת את רשימת התזכורות. לא בוצע שינוי.';
  return result.matchCount === 0 ? 'לא נמצאו תזכורות הנגישות לך.' : result.matches.map((item, i) =>
    `${i + 1}. ${item.content} (${item.status === 'active' ? 'פעילה' : 'מושהית'}); ${item.schedules.map(schedule =>
      schedule.type === 'one-shot' ? formatUserDatetime(schedule.resolvedTime, schedule.timezone, { now }) : 'לפי לוח זמנים חוזר').join('; ')}`).join('\n');
}
const unsupported = (reason = 'semantic_rendering_required'): Presentation => freeze({ kind: 'unsupported', reason });
const rendered = (text: string): Presentation => freeze({ kind: 'rendered', text, pendingContext: null });
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
export function renderReminderPresentation(raw: unknown, language: 'en' | 'he', timezone?: string, now?: string): Presentation {
  if (!plain(raw) || Object.keys(raw).sort().join(',') !== 'data,domain,error,operation,pendingContext,status,verified,warnings') return unsupported('unsupported_result_shape');
  if (raw.status === 'success' && raw.verified !== true) return unsupported('unverified_result');
  const data = raw.data;
  const transport = plain(data) && plain(data.transport) ? data.transport : null;
  if (transport && Array.isArray(transport.deliveries) && transport.deliveries.length) return unsupported('native_delivery_required');
  if (raw.status === 'failure' || raw.status === 'clarification_required') return unsupported();
  if (raw.status !== 'success' || !plain(data) || !Array.isArray(raw.warnings) || raw.warnings.length || raw.error !== null || raw.pendingContext !== null) return unsupported('unsupported_result_shape');
  if (raw.operation === 'find' && language === 'he' && data.matchCount === 0 && Array.isArray(data.matches) && data.matches.length === 0) return rendered('לא נמצאו תזכורות תואמות.');
  // Service normalization preserves the complete transaction envelope, whose
  // business record is nested under data. Legacy presentation input is flat.
  if (plain(data.data) && plain(data.record)) return unsupported('ambiguous_record_shape');
  const recordData = plain(data.data) ? data.data : data;
  const transaction = plain(data.transaction) ? data.transaction : null, record = plain(recordData.record) ? recordData.record : null;
  if (transaction?.status !== 'success' || transaction.verified !== true || !record || !text(record.content)) return unsupported();
  if (raw.operation === 'delete' && language === 'en' && record.status === 'deleted') return rendered(`The “${record.content.trim()}” reminder was deleted.`);
  if (raw.operation === 'delete' && language === 'he' && record.status === 'deleted') return rendered(`התזכורת „${record.content.trim()}” נמחקה.`);
  if (raw.operation === 'create' && language === 'he' && record.status === 'active' && plain(record.schedule) && record.schedule.type === 'one-shot' && text(record.schedule.resolvedTime) && text(record.schedule.timezone) && plain(record.calendar) && record.calendar.requested === false && text(timezone) && text(now)) {
    try { return rendered(`התזכורת „${record.content.trim()}” נקבעה ל${formatUserDatetime(record.schedule.resolvedTime, timezone, { now })}.`); }
    catch { return unsupported('invalid_datetime'); }
  }
  return unsupported();
}

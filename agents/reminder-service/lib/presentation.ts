import { formatUserDatetime } from '../../../shared/benson-datetime.js';
import type { ListResult } from './results.js';
import { plain, freeze } from '../../../integrations/openclaw/benson-routing/core/value.js';
import type { Presentation } from '../../../integrations/openclaw/benson-routing/core/response-control.js';
import type { AnyDomainResult } from '../../../integrations/openclaw/benson-routing/core/contracts.js';
import { validateDomainResultEnvelope, readDomainFactsData } from '../../../integrations/openclaw/benson-routing/core/domain-result.js';
/** Full-list prepared content stays domain-owned; unsupported qualifications block. */
export function renderReminderDomainResult(raw: AnyDomainResult, options: { language: 'en' | 'he'; timezone?: string; now?: string }): Presentation {
  const value = validateDomainResultEnvelope(raw);
  if (value.domain === 'reminder' && value.executionMode === 'agentic' && value.outcome.status === 'unknown' &&
    value.outcome.disposition === 'unresolved' && (value.uncertainty.length > 0 || value.evidence.gaps.length > 0) && !value.warnings.length && value.pendingContext === null) {
    return rendered(options.language === 'he'
      ? 'לא ניתן לאמת את השלמת בקשת התזכורת. תיעוד ההשפעות נשמר; יש לבדוק את המצב לפני ניסיון נוסף. לא אבצע את הפעולה שוב אוטומטית.'
      : 'The Reminder request has no verified final outcome. Effect evidence is retained; check the current state before retrying. I will not repeat the operation automatically.');
  }
  if (value.domain === 'reminder' && value.executionMode === 'agentic' && ['create', 'update', 'pause', 'resume', 'delete', 'find', 'list'].includes(value.operation ?? '') &&
    value.outcome.status === 'success' && value.facts.verified === true &&
    ((value.effects.status === 'known' && value.effects.refs.length > 0) ||
      (['find', 'list'].includes(value.operation ?? '') && value.effects.status === 'none')) &&
    !value.effects.reconciliation.required && !value.evidence.gaps.length &&
    !value.uncertainty.length && !value.warnings.length && value.pendingContext === null &&
    value.failures.domain === null && value.failures.handling === null) {
    return renderReminderPresentation({ status: value.outcome.status, domain: value.domain, operation: value.operation,
      verified: value.facts.verified, data: readDomainFactsData(value.facts.data).value, warnings: value.warnings, error: null, pendingContext: null },
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
  if (raw.operation === 'find' || raw.operation === 'list') {
    if (!Array.isArray(data.matches) || data.matchCount !== data.matches.length) return unsupported('incomplete_discovery');
    if (!data.matches.length) return rendered(language === 'he' ? 'לא נמצאו תזכורות תואמות.' : 'No matching reminders were found.');
    const lines: string[] = [], ids = new Set<string>();
    for (const [index, item] of data.matches.entries()) {
      if (!plain(item) || !text(item.reminderId) || ids.has(item.reminderId) || !text(item.content) ||
        !['active', 'paused'].includes(String(item.status))) return unsupported('incomplete_discovery');
      ids.add(item.reminderId);
      const schedule = scheduleText(item, language, timezone, now);
      if (schedule === null) return unsupported('invalid_schedule');
      lines.push(`${index + 1}. ${item.content.trim()} (${language === 'he' ? item.status === 'active' ? 'פעילה' : 'מושהית' : item.status}); ${schedule}`);
    }
    return rendered(lines.join('\n'));
  }
  // Service normalization preserves the complete transaction envelope, whose
  // business record is nested under data. Legacy presentation input is flat.
  if (plain(data.data) && plain(data.record)) return unsupported('ambiguous_record_shape');
  const recordData = plain(data.data) ? data.data : data;
  const transaction = plain(data.transaction) ? data.transaction : null;
  if (transaction?.status !== 'success' || transaction.verified !== true) return unsupported('unverified_transaction');
  let records: unknown[];
  const restructured = recordData.restructuredRecord !== undefined;
  if (Array.isArray(recordData.records)) {
    if (recordData.record !== undefined || recordData.restructuredRecord !== undefined) return unsupported('ambiguous_record_shape');
    records = recordData.records;
  } else if (plain(recordData.record)) {
    if (recordData.restructuredRecord !== undefined) {
      if (raw.operation !== 'update' || !plain(recordData.restructuredRecord) || !text(recordData.changedRecipientId)) return unsupported('invalid_recipient_restructure');
      // Both resulting records are part of the verified transaction. Do not
      // summarize only the changed recipient and hide the retained record.
      records = [recordData.record, recordData.restructuredRecord];
    } else records = [recordData.record];
  } else return unsupported('missing_transaction_records');
  if (!records.length || records.length > 64) return unsupported('invalid_transaction_records');
  const lines: string[] = [], ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (!plain(record) || !text(record.content)) return unsupported('invalid_transaction_records');
    // Retained single-record flat presentation input omitted the internal id.
    // Service envelopes and collections require actual unique record identity.
    if (record.reminderId !== undefined) {
      if (!text(record.reminderId) || ids.has(record.reminderId)) return unsupported('invalid_transaction_records');
      ids.add(record.reminderId);
    } else if (plain(data.data) || Array.isArray(recordData.records) || restructured) return unsupported('invalid_transaction_records');
    const operation = raw.operation;
    if (typeof operation !== 'string' || !['create', 'update', 'pause', 'resume', 'delete'].includes(operation) ||
      (operation === 'update' ? !['active', 'paused'].includes(String(record.status)) :
        record.status !== (operation === 'delete' ? 'deleted' : operation === 'pause' ? 'paused' : 'active'))) return unsupported('invalid_lifecycle_state');
    const schedule = operation === 'delete' || operation === 'pause' ? '' : scheduleText(record, language, timezone, now);
    if (schedule === null) return unsupported('invalid_schedule');
    const hebrew: Record<string, string> = { create: 'נקבעה', update: 'עודכנה', pause: 'הושהתה', resume: 'הופעלה מחדש', delete: 'נמחקה' };
    const english: Record<string, string> = { create: 'created', update: 'updated', pause: 'paused', resume: 'resumed', delete: 'deleted' };
    let line = language === 'he' ? `התזכורת „${record.content.trim()}” ${hebrew[operation]}` : `The “${record.content.trim()}” reminder was ${english[operation]}`;
    if (restructured) line = index === 0
      ? language === 'he' ? `התזכורת שנותרה לנמענים האחרים: „${record.content.trim()}”` : `Reminder retained for the other recipients: “${record.content.trim()}”`
      : language === 'he' ? `התזכורת לנמען שנבחר עודכנה: „${record.content.trim()}”` : `Reminder updated for the selected recipient: “${record.content.trim()}”`;
    if (schedule) line += language === 'he' && operation === 'create' ? ` ל${schedule}` : ` — ${schedule}`;
    line += '.';
    if (record.calendar !== undefined) {
      if (!plain(record.calendar) || typeof record.calendar.requested !== 'boolean' ||
        (record.calendar.requested && !text(record.calendar.eventId))) return unsupported('invalid_calendar_record');
      if (record.calendar.requested) line += language === 'he' ? ' הקישור ל־Calendar טופל כחלק מהפעולה.' : ' The linked Calendar event was included in the operation.';
    }
    lines.push(line);
  }
  return rendered(lines.join('\n'));
}

/** Preserve every owned schedule; ambiguous singular/plural carriers reject. */
function scheduleText(record: Record<string, unknown>, language: 'he' | 'en', timezone?: string, now?: string): string | null {
  const schedules = Array.isArray(record.schedules) ? record.schedules : record.schedule !== undefined ? [record.schedule] : [];
  if (!schedules.length || schedules.length > 64 || (record.schedule !== undefined && Array.isArray(record.schedules) &&
    (schedules.length !== 1 || JSON.stringify(record.schedule) !== JSON.stringify(schedules[0])))) return null;
  const lines: string[] = [];
  try {
    for (const item of schedules) {
      if (!plain(item) || !text(item.timezone)) return null;
      if (item.type === 'one-shot' && text(item.resolvedTime) && text(timezone) && text(now)) {
        const localized = formatUserDatetime(item.resolvedTime, timezone, { now });
        lines.push(language === 'he' ? localized : new Intl.DateTimeFormat('en-GB', {
          timeZone: timezone, dateStyle: 'medium', timeStyle: 'short',
        }).format(new Date(item.resolvedTime)));
      } else if (item.type === 'recurring' && text(item.cron)) {
        // The complete recurring specification is retained, never guessed from
        // a subset of cron fields or described as a one-shot occurrence.
        lines.push(language === 'he' ? `לוח זמנים חוזר: ${item.cron} (${item.timezone})` : `Recurring schedule: ${item.cron} (${item.timezone})`);
      } else return null;
    }
    return lines.join(language === 'he' ? '; וגם ' : '; and ');
  } catch { return null; }
}

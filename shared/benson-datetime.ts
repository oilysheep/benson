const MONTHS_HE = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
] as const;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;
export class UserDatetimeError extends Error {
  constructor(message: string) { super(message); this.name = 'UserDatetimeError'; }
}
function invalid(value: unknown): never { throw new UserDatetimeError(`invalid RFC3339 datetime: ${String(value)}`); }
function parseInstant(value: unknown): Date {
  const match = typeof value === 'string' ? RFC3339.exec(value) : null;
  if (!match) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
      throw new UserDatetimeError('user-facing datetime must include timezone');
    }
    return invalid(value);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone] = match;
  if (zone === undefined) return invalid(value);
  const year = Number(yearText), month = Number(monthText), day = Number(dayText),
    hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const civil = new Date(0);
  civil.setUTCFullYear(year, month - 1, day);
  civil.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, '0').slice(0, 3)));
  if (year < 1 || civil.getUTCFullYear() !== year || civil.getUTCMonth() !== month - 1 || civil.getUTCDate() !== day ||
    civil.getUTCHours() !== hour || civil.getUTCMinutes() !== minute || civil.getUTCSeconds() !== second) return invalid(value);
  let offset = 0;
  if (zone !== 'Z') {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return invalid(value);
    offset = (hours * 60 + minutes) * (zone[0] === '+' ? 1 : -1);
  }
  return new Date(civil.getTime() - offset * 60000);
}
interface LocalParts { year: number; month: number; day: number; hour: number; minute: number }
function localParts(value: Date, formatter: Intl.DateTimeFormat): LocalParts {
  const parts = new Map(formatter.formatToParts(value).map(part => [part.type, Number(part.value)]));
  function required(key: Intl.DateTimeFormatPartTypes): number {
    const part = parts.get(key); if (part === undefined || !Number.isFinite(part)) return invalid(value); return part;
  }
  return { year: required('year'), month: required('month'), day: required('day'), hour: required('hour'), minute: required('minute') };
}
function civilDay(parts: LocalParts): number {
  const date = new Date(0); date.setUTCFullYear(parts.year, parts.month - 1, parts.day); return date.getTime() / 86400000;
}
export function formatUserDatetime(value: unknown, timezoneName: unknown, { now = new Date() }: { now?: Date | string } = {}): string {
  const instant = parseInstant(value);
  if (typeof timezoneName !== 'string' || !timezoneName) throw new UserDatetimeError(`invalid timezone: ${String(timezoneName)}`);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezoneName, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch { throw new UserDatetimeError(`invalid timezone: ${timezoneName}`); }
  const current = now instanceof Date ? now : parseInstant(now);
  if (!Number.isFinite(current.getTime())) return invalid(now);
  const local = localParts(instant, formatter), today = localParts(current, formatter);
  const time = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`;
  const days = civilDay(local) - civilDay(today);
  if (days === 0) return `היום ב־${time}`;
  if (days === 1) return `מחר ב־${time}`;
  const month = MONTHS_HE[local.month - 1]; if (month === undefined) return invalid(value);
  return `${local.day} ב${month} ${local.year} בשעה ${time}`;
}

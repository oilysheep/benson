const MONTHS_HE = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

export class UserDatetimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserDatetimeError";
  }
}

function parseInstant(value) {
  const match = typeof value === "string" ? RFC3339.exec(value) : null;
  if (!match) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)) {
      throw new UserDatetimeError("user-facing datetime must include timezone");
    }
    throw new UserDatetimeError(`invalid RFC3339 datetime: ${value}`);
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone] = match;
  const [year, month, day, hour, minute, second] =
    [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const civil = new Date(0);
  civil.setUTCFullYear(year, month - 1, day);
  civil.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, "0").slice(0, 3)));
  if (year < 1 || civil.getUTCFullYear() !== year || civil.getUTCMonth() !== month - 1 ||
      civil.getUTCDate() !== day || civil.getUTCHours() !== hour ||
      civil.getUTCMinutes() !== minute || civil.getUTCSeconds() !== second) {
    throw new UserDatetimeError(`invalid RFC3339 datetime: ${value}`);
  }

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetRemainder = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetRemainder > 59) {
      throw new UserDatetimeError(`invalid RFC3339 datetime: ${value}`);
    }
    offsetMinutes = (offsetHours * 60 + offsetRemainder) * (zone[0] === "+" ? 1 : -1);
  }
  return new Date(civil.getTime() - offsetMinutes * 60_000);
}

function localParts(value, formatter) {
  const parts = Object.fromEntries(formatter.formatToParts(value)
    .filter((part) => ["year", "month", "day", "hour", "minute"].includes(part.type))
    .map((part) => [part.type, Number(part.value)]));
  return parts;
}

function civilDay(parts) {
  const value = new Date(0);
  value.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return value.getTime() / 86_400_000;
}

export function formatUserDatetime(value, timezoneName, { now = new Date() } = {}) {
  const instant = parseInstant(value);
  if (typeof timezoneName !== "string" || timezoneName.length === 0) {
    throw new UserDatetimeError(`invalid timezone: ${timezoneName}`);
  }
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezoneName,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new UserDatetimeError(`invalid timezone: ${timezoneName}`);
  }
  const current = now instanceof Date ? now : parseInstant(now);
  if (!Number.isFinite(current.getTime())) {
    throw new UserDatetimeError(`invalid RFC3339 datetime: ${now}`);
  }
  const localValue = localParts(instant, formatter);
  const localNow = localParts(current, formatter);
  const time = `${String(localValue.hour).padStart(2, "0")}:${String(localValue.minute).padStart(2, "0")}`;
  const days = civilDay(localValue) - civilDay(localNow);
  if (days === 0) return `היום ב־${time}`;
  if (days === 1) return `מחר ב־${time}`;
  return `${localValue.day} ב${MONTHS_HE[localValue.month - 1]} ${localValue.year} בשעה ${time}`;
}

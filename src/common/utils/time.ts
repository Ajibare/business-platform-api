const MS_PER_DAY = 24 * 60 * 60 * 1000;

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * Formats a stored calendar date (expiry dates are recorded as date-only values)
 * into a `YYYY-MM-DD` key using its UTC parts.
 */
export function dateKeyFromCalendarDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * Returns the calendar date in the given timezone for an instant.
 */
export function localDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

export function isValidDateKey(key: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) && !Number.isNaN(parseDateKey(key));
}

function parseDateKey(key: string): number {
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

export function addDaysKey(key: string, days: number): string {
  const next = new Date(parseDateKey(key) + days * MS_PER_DAY);
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/**
 * Number of calendar days from `fromKey` to `toKey`. Positive when `toKey` is later.
 */
export function diffDaysKeys(fromKey: string, toKey: string): number {
  return Math.round((parseDateKey(toKey) - parseDateKey(fromKey)) / MS_PER_DAY);
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.get('year')),
    Number(values.get('month')) - 1,
    Number(values.get('day')),
    Number(values.get('hour')) % 24,
    Number(values.get('minute')),
    Number(values.get('second')),
  );
  return asUtc - date.getTime();
}

/**
 * Returns the UTC instants that bound a calendar date in the workspace timezone.
 * Two passes keep the result stable across daylight-saving transitions.
 */
export function zonedDayRangeUtc(dateKey: string, timeZone: string): { start: Date; end: Date } {
  const resolve = (key: string): Date => {
    const naive = parseDateKey(key);
    const firstPass = naive - timeZoneOffsetMs(new Date(naive), timeZone);
    const secondPass = naive - timeZoneOffsetMs(new Date(firstPass), timeZone);
    return new Date(secondPass);
  };

  return { start: resolve(dateKey), end: resolve(addDaysKey(dateKey, 1)) };
}

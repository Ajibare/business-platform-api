import {
  addDaysKey,
  dateKeyFromCalendarDate,
  diffDaysKeys,
  localDateKey,
  zonedDayRangeUtc,
} from './time';

describe('time helpers', () => {
  it('derives the workspace calendar date from an instant', () => {
    // 23:30 UTC is already the next day in Africa/Lagos (UTC+1).
    expect(localDateKey(new Date('2026-01-01T23:30:00.000Z'), 'Africa/Lagos')).toBe('2026-01-02');
    expect(localDateKey(new Date('2026-01-01T12:00:00.000Z'), 'Africa/Lagos')).toBe('2026-01-01');
  });

  it('converts expiry values to date-only keys without timezone drift', () => {
    expect(dateKeyFromCalendarDate(new Date('2027-02-14T00:00:00.000Z'))).toBe('2027-02-14');
  });

  it('rolls dates across month and year boundaries', () => {
    expect(addDaysKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysKey('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('counts calendar days between keys', () => {
    expect(diffDaysKeys('2026-11-16', '2027-02-14')).toBe(90);
    expect(diffDaysKeys('2026-11-16', '2026-11-15')).toBe(-1);
  });

  it('returns the UTC bounds of a local calendar day', () => {
    const { start, end } = zonedDayRangeUtc('2026-03-01', 'Africa/Lagos');
    expect(start.toISOString()).toBe('2026-02-28T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-01T23:00:00.000Z');
  });
});

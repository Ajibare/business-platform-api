import {
  buildDailyReportCopy,
  dailyReportDedupeKey,
  isDailyReportDue,
  localTimeKey,
  normaliseDeliveryTime,
} from './daily-report.rules';
import { summariseSalesDay } from '../../products/pharmacy/sales/daily-summary';

describe('normaliseDeliveryTime', () => {
  it('keeps a valid 24 hour time', () => {
    expect(normaliseDeliveryTime('18:45')).toBe('18:45');
    expect(normaliseDeliveryTime(' 07:05 ')).toBe('07:05');
  });

  it('falls back to 20:00 when the value is missing or invalid', () => {
    expect(normaliseDeliveryTime(null)).toBe('20:00');
    expect(normaliseDeliveryTime('')).toBe('20:00');
    expect(normaliseDeliveryTime('7:05')).toBe('20:00');
    expect(normaliseDeliveryTime('24:00')).toBe('20:00');
    expect(normaliseDeliveryTime('evening')).toBe('20:00');
  });
});

describe('localTimeKey', () => {
  it('reads the wall clock in the requested timezone', () => {
    const instant = new Date('2026-11-16T19:05:00.000Z');

    expect(localTimeKey(instant, 'Africa/Lagos')).toBe('20:05');
    expect(localTimeKey(instant, 'UTC')).toBe('19:05');
  });
});

describe('isDailyReportDue', () => {
  const timeZone = 'Africa/Lagos';
  const now = (iso: string) => new Date(iso);

  it('is not due before the delivery time', () => {
    expect(
      isDailyReportDue({ now: now('2026-11-16T18:59:00.000Z'), deliveryTime: '20:00', timeZone }),
    ).toBe(false);
  });

  it('is due at the delivery time and stays due later that evening', () => {
    expect(
      isDailyReportDue({ now: now('2026-11-16T19:00:00.000Z'), deliveryTime: '20:00', timeZone }),
    ).toBe(true);
    expect(
      isDailyReportDue({ now: now('2026-11-16T21:30:00.000Z'), deliveryTime: '20:00', timeZone }),
    ).toBe(true);
  });

  it('is not due again after midnight, so the same report cannot be resent for a new day early', () => {
    // 23:30 UTC is 00:30 the next day in Lagos.
    expect(
      isDailyReportDue({ now: now('2026-11-16T23:30:00.000Z'), deliveryTime: '20:00', timeZone }),
    ).toBe(false);
  });
});

describe('dailyReportDedupeKey', () => {
  it('is stable per business date so a report is only created once', () => {
    expect(dailyReportDedupeKey('2026-11-16')).toBe('daily-report:2026-11-16');
    expect(dailyReportDedupeKey('2026-11-16')).toBe(dailyReportDedupeKey('2026-11-16'));
    expect(dailyReportDedupeKey('2026-11-17')).not.toBe(dailyReportDedupeKey('2026-11-16'));
  });
});

describe('buildDailyReportCopy', () => {
  const summary = summariseSalesDay(
    [{ subtotal: 1000, discountTotal: 100, revenue: 900, unitCount: 10, costTotal: 600 }],
    [{ amount: 50 }],
  );

  const copy = buildDailyReportCopy({
    organizationName: 'Green Cross Pharmacy',
    currency: 'NGN',
    date: '2026-11-16',
    timeZone: 'Africa/Lagos',
    summary,
    dashboardUrl: 'https://app.example.com/dashboard',
  });

  it('labels revenue separately from profit', () => {
    expect(copy.title).toContain('Green Cross Pharmacy');
    expect(copy.title).toContain('16 Nov 2026');
    expect(copy.body).toContain('Total sales revenue:');
    expect(copy.body).toContain('Net sales:');
    expect(copy.body).toContain('Gross profit:');
    expect(copy.body).toContain('Revenue and net sales are income figures, not profit.');
    expect(copy.body).toContain('https://app.example.com/dashboard');
  });

  it('reports the transaction count, discounts and refunds', () => {
    expect(copy.body).toContain('Sales transactions: 1.');
    expect(copy.body).toContain('Discounts:');
    expect(copy.body).toContain('Refunds and returns:');
  });

  it('says so when no cost is recorded instead of inventing a profit', () => {
    const noCost = buildDailyReportCopy({
      organizationName: 'Green Cross Pharmacy',
      currency: 'NGN',
      date: '2026-11-16',
      timeZone: 'Africa/Lagos',
      summary: summariseSalesDay(
        [{ subtotal: 500, discountTotal: 0, revenue: 500, unitCount: 1, costTotal: null }],
        [],
      ),
      dashboardUrl: 'https://app.example.com/dashboard',
    });

    expect(noCost.body).toContain('not available for every sale');
    expect(noCost.body).toContain('Gross profit: not available.');
  });

  it('still produces a report on a day without sales', () => {
    const empty = buildDailyReportCopy({
      organizationName: 'Green Cross Pharmacy',
      currency: 'NGN',
      date: '2026-11-16',
      timeZone: 'Africa/Lagos',
      summary: summariseSalesDay([], []),
      dashboardUrl: 'https://app.example.com/dashboard',
    });

    expect(empty.body).toContain('No completed sales were recorded on this business day.');
  });
});

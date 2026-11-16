import { DailySalesSummary } from '../../products/pharmacy/sales/daily-summary';

export const DAILY_REPORT_NOTIFICATION_TYPE = 'DAILY_SALES_REPORT';
export const DEFAULT_DAILY_REPORT_TIME = '20:00';

/** Validates and normalises a `HH:mm` delivery time. */
export function normaliseDeliveryTime(value: string | null | undefined): string {
  if (!value) return DEFAULT_DAILY_REPORT_TIME;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return DEFAULT_DAILY_REPORT_TIME;
  return `${match[1]}:${match[2]}`;
}

/** Current local `HH:mm` for a timezone. */
export function localTimeKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('hour')}:${values.get('minute')}`;
}

/**
 * A daily report becomes due at the configured local time and stays due until
 * it has been sent. Deduplication is handled by the notification dedupe key,
 * so a scheduler that ticks more often than once a day never sends twice.
 */
export function isDailyReportDue(input: {
  now: Date;
  deliveryTime: string;
  timeZone: string;
}): boolean {
  return localTimeKey(input.now, input.timeZone) >= normaliseDeliveryTime(input.deliveryTime);
}

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function formatReportDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export interface DailyReportCopyInput {
  organizationName: string;
  currency: string;
  date: string;
  timeZone: string;
  summary: DailySalesSummary;
  dashboardUrl: string;
}

/**
 * Builds the daily summary email. Revenue, net sales and gross profit are
 * labelled separately and revenue is never described as profit.
 */
export function buildDailyReportCopy(input: DailyReportCopyInput): { title: string; body: string } {
  const { summary, currency } = input;
  const money = (amount: number) => formatMoney(amount, currency);

  const lines = [
    `${input.organizationName} — daily sales summary for ${formatReportDate(input.date)} (${input.timeZone}).`,
    `Total sales revenue: ${money(summary.revenue)}.`,
    `Sales transactions: ${summary.transactions}.`,
    `Units sold: ${summary.unitsSold}.`,
    `Discounts: ${money(summary.discounts)}.`,
    `Refunds and returns: ${money(summary.refunds)}.`,
    `Net sales: ${money(summary.netSales)}.`,
    summary.cogs === null
      ? 'Cost of goods sold: not available for every sale, so gross profit is not shown.'
      : `Cost of goods sold: ${money(summary.cogs)}.`,
    summary.grossProfit === null
      ? 'Gross profit: not available.'
      : `Gross profit: ${money(summary.grossProfit)}.`,
    'Revenue and net sales are income figures, not profit. Gross profit excludes rent, salaries and other operating costs.',
    summary.transactions === 0
      ? 'No completed sales were recorded on this business day.'
      : 'Voided and cancelled sales are excluded from these figures.',
    `Open the dashboard: ${input.dashboardUrl}`,
  ];

  return {
    title: `${input.organizationName} daily sales summary — ${formatReportDate(input.date)}`,
    body: lines.join(' '),
  };
}

export function dailyReportDedupeKey(dateKey: string): string {
  return `daily-report:${dateKey}`;
}
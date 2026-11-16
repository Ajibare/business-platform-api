import { addDaysKey, dateKeyFromCalendarDate, diffDaysKeys } from '../../../common/utils/time';

export const EXPIRY_NOTIFICATION_TYPE = 'EXPIRY_REMINDER';
export const DEFAULT_REMINDER_LEAD_DAYS = 90;
/** Kept for preference compatibility; milestone reminders ignore the interval. */
export const DEFAULT_REMINDER_INTERVAL_DAYS = 7;

/**
 * Fixed reminder milestones, counted in days before expiry. A batch receives
 * one notification per milestone; the milestone is part of the dedupe key so
 * repeated scans (or several API instances) cannot send the same email twice.
 */
export const EXPIRY_MILESTONES = [90, 60, 30, 7, 0] as const;

/** How long after expiry the "expired" reminder may still be sent. */
export const EXPIRED_GRACE_DAYS = 7;

export type ExpiryMilestoneKey = 'D90' | 'D60' | 'D30' | 'D7' | 'D0' | 'EXPIRED';

export interface ExpiryMilestone {
  daysRemaining: number;
  milestone: ExpiryMilestoneKey;
  dedupeKey: string;
  severity: 'danger' | 'warning';
  action: string;
}

const MILESTONE_ACTIONS: Record<ExpiryMilestoneKey, string> = {
  D90: 'Plan sell-through or a supplier return before the expiry date.',
  D60: 'Prioritise this batch and stop reordering it.',
  D30: 'Move this batch to the front of the shelf and arrange a supplier return if it will not sell.',
  D7: 'Stop selling soon. Quarantine the batch and arrange disposal or a supplier return.',
  D0: 'Expired today. Remove it from sellable stock and record disposal or a supplier return.',
  EXPIRED: 'Expired. Do not sell it. Remove it from sellable stock and record disposal or a supplier return.',
};

/**
 * Resolves which milestone a batch is currently in. Milestones are fixed
 * (90/60/30/7/0 days) rather than interval based, so a batch that reaches
 * 55 days remaining reports the 60-day milestone exactly once.
 */
export function resolveExpiryMilestone(input: {
  expiryDate: Date;
  todayKey: string;
  leadDays: number;
  dedupePrefix?: string;
}): ExpiryMilestone | null {
  const leadDays = Math.max(0, Math.floor(input.leadDays));
  const expiryKey = dateKeyFromCalendarDate(input.expiryDate);
  const daysRemaining = diffDaysKeys(input.todayKey, expiryKey);
  const prefix = input.dedupePrefix ?? 'expiry-reminder';

  if (daysRemaining < 0) {
    if (daysRemaining < -EXPIRED_GRACE_DAYS) return null;
    return {
      daysRemaining,
      milestone: 'EXPIRED',
      dedupeKey: `${prefix}:EXPIRED`,
      severity: 'danger',
      action: MILESTONE_ACTIONS.EXPIRED,
    };
  }

  if (daysRemaining > leadDays) return null;

  const available = EXPIRY_MILESTONES.filter(
    (milestone) => milestone <= leadDays || milestone === 0,
  );
  // The nearest milestone that still covers the remaining days, so a batch at
  // 26 days resolves to D30 rather than jumping back to D90.
  const due = [...available].reverse().find((milestone) => daysRemaining <= milestone);
  if (due === undefined) return null;

  const key: ExpiryMilestoneKey = `D${due}`;
  return {
    daysRemaining,
    milestone: key,
    dedupeKey: `${prefix}:${key}`,
    severity: daysRemaining <= 30 ? 'danger' : 'warning',
    action: MILESTONE_ACTIONS[key],
  };
}

/** Calendar date on which a milestone email becomes due for an expiry date. */
export function milestoneDueDate(expiryDate: Date, milestone: number): string {
  return addDaysKey(dateKeyFromCalendarDate(expiryDate), -milestone);
}

export function buildExpiryReminderCopy(input: {
  organizationName: string;
  productName: string;
  batchNumber: string | null;
  expiryDate: Date;
  daysRemaining: number;
  quantity: number;
  unit: string;
  timeZone: string;
  action: string;
  actionUrl: string;
}): { title: string; body: string } {
  const expiryText = input.expiryDate.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const batchText = input.batchNumber ? `batch ${input.batchNumber}` : 'an unnumbered batch';
  const dayLabel =
    input.daysRemaining === 0
      ? 'today'
      : input.daysRemaining > 0
        ? `in ${input.daysRemaining} day(s)`
        : `${Math.abs(input.daysRemaining)} day(s) ago`;

  return {
    title:
      input.daysRemaining < 0
        ? `${input.productName} has expired (${batchText})`
        : `${input.productName} expires ${dayLabel}`,
    body: [
      `${input.organizationName}: ${input.productName} (${batchText}) expires on ${expiryText}, ${dayLabel}.`,
      `Remaining quantity: ${input.quantity} ${input.unit}.`,
      `Recommended action: ${input.action}`,
      `Review the batch: ${input.actionUrl}`,
      `Expiry dates are compared against the ${input.timeZone} calendar day.`,
    ].join(' '),
  };
}

export function defaultBatchUrl(baseUrl: string, batchId: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  return `${root}/products/pharmacy/expiry?batch=${encodeURIComponent(batchId)}`;
}
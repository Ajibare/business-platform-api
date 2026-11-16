export type ExpiryBucket = 'EXPIRED' | 'WITHIN_30' | 'WITHIN_60' | 'WITHIN_90' | 'BEYOND';

/**
 * Colour guidance for the UI: critical = red, warning = orange,
 * attention = yellow, ok = green.
 */
export type ExpirySeverity = 'critical' | 'warning' | 'attention' | 'ok';

export const EXPIRY_BUCKET_LABELS: Record<ExpiryBucket, string> = {
  EXPIRED: 'Already expired',
  WITHIN_30: 'Expiring within 30 days',
  WITHIN_60: 'Expiring within 60 days',
  WITHIN_90: 'Expiring within 90 days',
  BEYOND: 'No immediate expiry concern',
};

export const EXPIRY_BUCKET_ORDER: ExpiryBucket[] = [
  'EXPIRED',
  'WITHIN_30',
  'WITHIN_60',
  'WITHIN_90',
  'BEYOND',
];

/**
 * Classifies a batch by the number of calendar days left before it expires.
 * Expiry is tracked per batch, never per medicine name.
 */
export function categoriseExpiry(
  daysRemaining: number,
  leadDays = 90,
): { bucket: ExpiryBucket; severity: ExpirySeverity } {
  if (!Number.isFinite(daysRemaining)) {
    return { bucket: 'BEYOND', severity: 'ok' };
  }
  if (daysRemaining < 0) return { bucket: 'EXPIRED', severity: 'critical' };
  if (daysRemaining <= 30) return { bucket: 'WITHIN_30', severity: 'critical' };
  if (daysRemaining <= 60) return { bucket: 'WITHIN_60', severity: 'warning' };
  if (daysRemaining <= Math.max(leadDays, 61)) {
    return { bucket: 'WITHIN_90', severity: 'attention' };
  }
  return { bucket: 'BEYOND', severity: 'ok' };
}

/** Buckets that require attention in the login popup and in alert counts. */
export function isActionableBucket(bucket: ExpiryBucket): boolean {
  return bucket !== 'BEYOND';
}
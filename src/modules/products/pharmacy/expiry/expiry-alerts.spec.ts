import { categoriseExpiry, isActionableBucket } from './expiry-alerts';

describe('categoriseExpiry', () => {
  it('marks a batch that expired yesterday as critical', () => {
    expect(categoriseExpiry(-1)).toEqual({ bucket: 'EXPIRED', severity: 'critical' });
  });

  it('keeps today and the next 30 days in the red bucket', () => {
    expect(categoriseExpiry(0)).toEqual({ bucket: 'WITHIN_30', severity: 'critical' });
    expect(categoriseExpiry(30)).toEqual({ bucket: 'WITHIN_30', severity: 'critical' });
  });

  it('moves to the 60 day bucket at 31 days', () => {
    expect(categoriseExpiry(31)).toEqual({ bucket: 'WITHIN_60', severity: 'warning' });
    expect(categoriseExpiry(60)).toEqual({ bucket: 'WITHIN_60', severity: 'warning' });
  });

  it('moves to the 90 day bucket at 61 days', () => {
    expect(categoriseExpiry(61)).toEqual({ bucket: 'WITHIN_90', severity: 'attention' });
    expect(categoriseExpiry(90)).toEqual({ bucket: 'WITHIN_90', severity: 'attention' });
  });

  it('clears the alert after the lead window', () => {
    expect(categoriseExpiry(91)).toEqual({ bucket: 'BEYOND', severity: 'ok' });
  });

  it('honours a shorter lead window', () => {
    expect(categoriseExpiry(45, 30)).toEqual({ bucket: 'WITHIN_60', severity: 'warning' });
    expect(categoriseExpiry(75, 60)).toEqual({ bucket: 'BEYOND', severity: 'ok' });
  });

  it('treats an unknown day count as no concern instead of throwing', () => {
    expect(categoriseExpiry(Number.NaN)).toEqual({ bucket: 'BEYOND', severity: 'ok' });
  });
});

describe('isActionableBucket', () => {
  it('counts every bucket except the far future one', () => {
    expect(isActionableBucket('EXPIRED')).toBe(true);
    expect(isActionableBucket('WITHIN_30')).toBe(true);
    expect(isActionableBucket('WITHIN_60')).toBe(true);
    expect(isActionableBucket('WITHIN_90')).toBe(true);
    expect(isActionableBucket('BEYOND')).toBe(false);
  });
});

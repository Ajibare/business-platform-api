import {
  buildExpiryReminderCopy,
  defaultBatchUrl,
  resolveExpiryMilestone,
} from './notification-rules';

describe('resolveExpiryMilestone', () => {
  const base = { leadDays: 90, dedupePrefix: 'expiry-reminder:batch-1' };

  it('is due exactly 90 days before expiry', () => {
    const milestone = resolveExpiryMilestone({
      ...base,
      expiryDate: new Date('2027-02-14T00:00:00.000Z'),
      todayKey: '2026-11-16',
    });

    expect(milestone).not.toBeNull();
    expect(milestone?.daysRemaining).toBe(90);
    expect(milestone?.milestone).toBe('D90');
    expect(milestone?.dedupeKey).toBe('expiry-reminder:batch-1:D90');
  });

  it('does nothing before the reminder window opens', () => {
    const milestone = resolveExpiryMilestone({
      ...base,
      expiryDate: new Date('2027-02-15T00:00:00.000Z'),
      todayKey: '2026-11-16',
    });

    expect(milestone).toBeNull();
  });

  it('resolves the 60 day milestone once the batch is inside 60 days', () => {
    const expiryDate = new Date('2027-02-07T00:00:00.000Z');

    const atSixty = resolveExpiryMilestone({ ...base, expiryDate, todayKey: '2026-12-09' });
    const atFiftyFive = resolveExpiryMilestone({ ...base, expiryDate, todayKey: '2026-12-14' });

    expect(atSixty?.milestone).toBe('D60');
    expect(atFiftyFive?.milestone).toBe('D60');
    expect(atFiftyFive?.dedupeKey).toBe(atSixty?.dedupeKey);
  });

  it('opens the 30 day milestone after 60 days', () => {
    const milestone = resolveExpiryMilestone({
      ...base,
      expiryDate: new Date('2027-02-07T00:00:00.000Z'),
      todayKey: '2027-01-12',
    });

    expect(milestone?.daysRemaining).toBe(26);
    expect(milestone?.milestone).toBe('D30');
    expect(milestone?.severity).toBe('danger');
  });

  it('opens the 7 day milestone in the final week', () => {
    const milestone = resolveExpiryMilestone({
      ...base,
      expiryDate: new Date('2027-02-07T00:00:00.000Z'),
      todayKey: '2027-02-01',
    });

    expect(milestone?.milestone).toBe('D7');
  });

  it('sends a single expiry-day reminder', () => {
    const milestone = resolveExpiryMilestone({
      ...base,
      expiryDate: new Date('2027-02-07T00:00:00.000Z'),
      todayKey: '2027-02-07',
    });

    expect(milestone?.daysRemaining).toBe(0);
    expect(milestone?.milestone).toBe('D0');
    expect(milestone?.dedupeKey).toBe('expiry-reminder:batch-1:D0');
  });

  it('sends one expired reminder inside the grace period and nothing after it', () => {
    const inGrace = resolveExpiryMilestone({
      ...base,
      expiryDate: new Date('2027-02-07T00:00:00.000Z'),
      todayKey: '2027-02-10',
    });
    const afterGrace = resolveExpiryMilestone({
      ...base,
      expiryDate: new Date('2027-02-07T00:00:00.000Z'),
      todayKey: '2027-03-01',
    });

    expect(inGrace?.milestone).toBe('EXPIRED');
    expect(inGrace?.dedupeKey).toBe('expiry-reminder:batch-1:EXPIRED');
    expect(afterGrace).toBeNull();
  });

  it('honours a shorter lead time', () => {
    const outside = resolveExpiryMilestone({
      leadDays: 30,
      dedupePrefix: 'batch-9',
      expiryDate: new Date('2027-01-15T00:00:00.000Z'),
      todayKey: '2026-12-01',
    });
    const inside = resolveExpiryMilestone({
      leadDays: 30,
      dedupePrefix: 'batch-9',
      expiryDate: new Date('2027-01-15T00:00:00.000Z'),
      todayKey: '2026-12-20',
    });

    expect(outside).toBeNull();
    expect(inside?.milestone).toBe('D30');
    expect(inside?.dedupeKey).toBe('batch-9:D30');
  });
});

describe('buildExpiryReminderCopy', () => {
  it('includes the organisation, product, batch, expiry, quantity, action and link', () => {
    const copy = buildExpiryReminderCopy({
      organizationName: 'Green Cross Pharmacy',
      productName: 'Paracetamol 500mg',
      batchNumber: 'PC2451',
      expiryDate: new Date('2027-02-14T00:00:00.000Z'),
      daysRemaining: 90,
      quantity: 240,
      unit: 'tablet',
      timeZone: 'Africa/Lagos',
      action: 'Plan sell-through or a supplier return before the expiry date.',
      actionUrl: 'https://app.example.com/products/pharmacy/expiry?batch=batch-1',
    });

    expect(copy.title).toContain('Paracetamol 500mg');
    expect(copy.body).toContain('Green Cross Pharmacy');
    expect(copy.body).toContain('batch PC2451');
    expect(copy.body).toContain('14 Feb 2027');
    expect(copy.body).toContain('in 90 day(s)');
    expect(copy.body).toContain('240 tablet');
    expect(copy.body).toContain('Recommended action');
    expect(copy.body).toContain('https://app.example.com/products/pharmacy/expiry?batch=batch-1');
    expect(copy.body).toContain('Africa/Lagos');
  });

  it('describes an expired batch without claiming it can be sold', () => {
    const copy = buildExpiryReminderCopy({
      organizationName: 'Green Cross Pharmacy',
      productName: 'Amoxicillin 250mg',
      batchNumber: null,
      expiryDate: new Date('2026-11-10T00:00:00.000Z'),
      daysRemaining: -6,
      quantity: 12,
      unit: 'capsule',
      timeZone: 'Africa/Lagos',
      action: 'Expired. Do not sell it.',
      actionUrl: 'https://app.example.com/products/pharmacy/expiry?batch=batch-2',
    });

    expect(copy.title).toContain('has expired');
    expect(copy.body).toContain('6 day(s) ago');
    expect(copy.body).toContain('unnumbered batch');
  });
});

describe('defaultBatchUrl', () => {
  it('builds an inventory link without doubling slashes', () => {
    expect(defaultBatchUrl('https://app.example.com/', 'batch 1')).toBe(
      'https://app.example.com/products/pharmacy/expiry?batch=batch%201',
    );
  });
});
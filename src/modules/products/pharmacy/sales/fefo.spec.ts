import {
  FefoBatch,
  allocateFefo,
  isExpiredOn,
  planSaleLines,
  roundMoney,
  roundQuantity,
} from './fefo';

const today = '2026-11-16';

function batch(
  batchId: string,
  expiryKey: string | null,
  quantity: number,
  options: { unitCost?: number | null; sellingPrice?: number | null } = {},
): FefoBatch {
  return {
    batchId,
    expiryDate: expiryKey ? new Date(`${expiryKey}T00:00:00.000Z`) : null,
    quantity,
    unitCost: options.unitCost ?? null,
    sellingPrice: options.sellingPrice ?? null,
  };
}

describe('isExpiredOn', () => {
  it('treats a batch expiring today as sellable and the day before as expired', () => {
    expect(isExpiredOn(new Date('2026-11-16T00:00:00.000Z'), today)).toBe(false);
    expect(isExpiredOn(new Date('2026-11-15T00:00:00.000Z'), today)).toBe(true);
  });

  it('never treats a batch without an expiry date as expired', () => {
    expect(isExpiredOn(null, today)).toBe(false);
  });
});

describe('allocateFefo', () => {
  const december = batch('batch-dec', '2026-12-31', 10);
  const january = batch('batch-jan', '2027-01-31', 10);
  const june = batch('batch-jun', '2027-06-30', 100);

  it('consumes the batch that expires first', () => {
    const result = allocateFefo([june, january, december], 5, today);

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].batchId).toBe('batch-dec');
    expect(result.allocations[0].quantity).toBe(5);
    expect(result.shortage).toBe(0);
  });

  it('spans several batches, nearest expiry first, and takes only what is needed', () => {
    const result = allocateFefo([june, january, december], 15, today);

    expect(result.allocations.map((allocation) => allocation.batchId)).toEqual([
      'batch-dec',
      'batch-jan',
    ]);
    expect(result.allocations.map((allocation) => allocation.quantity)).toEqual([10, 5]);
    expect(result.available).toBe(120);
  });

  it('never allocates expired stock', () => {
    const expired = batch('batch-old', '2026-11-01', 50);
    const result = allocateFefo([expired, december], 12, today);

    expect(result.available).toBe(10);
    expect(result.shortage).toBe(2);
    expect(result.allocations).toEqual([]);
  });

  it('reports a shortage instead of allocating a partial sale', () => {
    const result = allocateFefo([december], 11, today);

    expect(result.allocations).toEqual([]);
    expect(result.shortage).toBe(1);
  });

  it('ignores batches that have no stock left', () => {
    const empty = batch('batch-empty', '2026-12-01', 0);
    const result = allocateFefo([empty, december], 3, today);

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0].batchId).toBe('batch-dec');
  });

  it('uses batches without an expiry date only after dated batches', () => {
    const undated = batch('batch-undated', null, 20);
    const result = allocateFefo([undated, december], 15, today);

    expect(result.allocations.map((allocation) => allocation.batchId)).toEqual([
      'batch-dec',
      'batch-undated',
    ]);
    expect(result.allocations[1].quantity).toBe(5);
  });

  it('rejects a request for zero units without allocating anything', () => {
    const result = allocateFefo([december], 0, today);

    expect(result.allocations).toEqual([]);
    expect(result.shortage).toBe(0);
  });
});

describe('planSaleLines', () => {
  it('prices each line from its own batch when no price is supplied', () => {
    const allocation = allocateFefo(
      [batch('a', '2026-12-01', 4, { sellingPrice: 250 }), batch('b', '2027-01-01', 6, { sellingPrice: 300 })],
      6,
      today,
    );

    const plan = planSaleLines({ allocations: allocation.allocations });

    expect(plan.lines.map((line) => line.unitPrice)).toEqual([250, 300]);
    expect(plan.totals.subtotal).toBe(1600);
    expect(plan.totals.revenue).toBe(1600);
    expect(plan.totals.unitCount).toBe(6);
  });

  it('applies an explicit unit price to every allocation', () => {
    const allocation = allocateFefo(
      [batch('a', '2026-12-01', 2, { sellingPrice: 100 }), batch('b', '2027-01-01', 2, { sellingPrice: 100 })],
      4,
      today,
    );

    const plan = planSaleLines({ allocations: allocation.allocations, unitPrice: 150 });

    expect(plan.lines.every((line) => line.unitPrice === 150)).toBe(true);
    expect(plan.totals.subtotal).toBe(600);
  });

  it('spreads a discount across batches so the totals match exactly', () => {
    const allocation = allocateFefo(
      [batch('a', '2026-12-01', 3, { sellingPrice: 100 }), batch('b', '2027-01-01', 3, { sellingPrice: 100 })],
      6,
      today,
    );

    const plan = planSaleLines({ allocations: allocation.allocations, discount: 100 });

    const lineDiscounts = plan.lines.reduce((total, line) => total + line.discount, 0);
    expect(roundMoney(lineDiscounts)).toBe(100);
    expect(plan.totals.revenue).toBe(500);
    expect(plan.totals.discountTotal).toBe(100);
  });

  it('never discounts more than the value of the sale', () => {
    const allocation = allocateFefo([batch('a', '2026-12-01', 1, { sellingPrice: 50 })], 1, today);

    const plan = planSaleLines({ allocations: allocation.allocations, discount: 500 });

    expect(plan.totals.discountTotal).toBe(50);
    expect(plan.totals.revenue).toBe(0);
  });

  it('leaves cost unknown when any allocation has no purchase cost', () => {
    const allocation = allocateFefo(
      [batch('a', '2026-12-01', 2, { unitCost: 100, sellingPrice: 200 }), batch('b', '2027-01-01', 2, { sellingPrice: 200 })],
      4,
      today,
    );

    const plan = planSaleLines({ allocations: allocation.allocations });

    expect(plan.totals.costTotal).toBeNull();
    expect(plan.lines[0].costTotal).toBe(200);
    expect(plan.lines[1].costTotal).toBeNull();
  });

  it('totals cost when every batch has one', () => {
    const allocation = allocateFefo(
      [batch('a', '2026-12-01', 2, { unitCost: 100, sellingPrice: 200 }), batch('b', '2027-01-01', 1, { unitCost: 120, sellingPrice: 200 })],
      3,
      today,
    );

    const plan = planSaleLines({ allocations: allocation.allocations });

    expect(plan.totals.costTotal).toBe(320);
    expect(roundMoney(plan.totals.revenue - (plan.totals.costTotal ?? 0))).toBe(280);
  });

  it('refuses a negative unit price', () => {
    expect(() =>
      planSaleLines({
        allocations: [
          {
            batchId: 'a',
            quantity: 1,
            expiryDate: null,
            unitCost: null,
            sellingPrice: null,
          },
        ],
        unitPrice: -1,
      }),
    ).toThrow('Unit price cannot be negative.');
  });
});

describe('rounding helpers', () => {
  it('rounds money to two places and quantities to three', () => {
    expect(roundMoney(30.015)).toBe(30.02);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundQuantity(0.1 + 0.2)).toBe(0.3);
  });
});

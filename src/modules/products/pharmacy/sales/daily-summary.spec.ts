import { summariseSalesDay } from './daily-summary';

describe('summariseSalesDay', () => {
  it('separates gross sales, revenue, refunds and net sales', () => {
    const summary = summariseSalesDay(
      [
        { subtotal: 1000, discountTotal: 100, revenue: 900, unitCount: 10, costTotal: 600 },
        { subtotal: 500, discountTotal: 0, revenue: 500, unitCount: 5, costTotal: 300 },
      ],
      [{ amount: 150 }],
    );

    expect(summary.transactions).toBe(2);
    expect(summary.unitsSold).toBe(15);
    expect(summary.grossSales).toBe(1500);
    expect(summary.discounts).toBe(100);
    expect(summary.revenue).toBe(1400);
    expect(summary.refunds).toBe(150);
    expect(summary.netSales).toBe(1250);
    expect(summary.cogs).toBe(900);
    expect(summary.grossProfit).toBe(350);
  });

  it('keeps refunds out of revenue so the two figures are never mixed', () => {
    const withoutRefund = summariseSalesDay(
      [{ subtotal: 500, discountTotal: 0, revenue: 500, unitCount: 1, costTotal: 400 }],
      [],
    );
    const withRefund = summariseSalesDay(
      [{ subtotal: 500, discountTotal: 0, revenue: 500, unitCount: 1, costTotal: 400 }],
      [{ amount: 500 }],
    );

    expect(withRefund.revenue).toBe(withoutRefund.revenue);
    expect(withRefund.netSales).toBe(0);
    expect(withRefund.grossProfit).toBe(-400);
  });

  it('reports no profit at all when a purchase cost is missing', () => {
    const summary = summariseSalesDay(
      [{ subtotal: 500, discountTotal: 0, revenue: 500, unitCount: 1, costTotal: null }],
      [],
    );

    expect(summary.cogs).toBeNull();
    expect(summary.grossProfit).toBeNull();
    expect(summary.revenue).toBe(500);
  });

  it('produces zeros, not NaN, on a day without sales', () => {
    const summary = summariseSalesDay([], []);

    expect(summary).toEqual({
      transactions: 0,
      unitsSold: 0,
      grossSales: 0,
      discounts: 0,
      revenue: 0,
      refunds: 0,
      netSales: 0,
      cogs: 0,
      grossProfit: 0,
    });
  });

  it('rounds to cents so totals never drift', () => {
    const summary = summariseSalesDay(
      [
        { subtotal: 10.005, discountTotal: 0, revenue: 10.005, unitCount: 0.333, costTotal: 3.333 },
        { subtotal: 10.005, discountTotal: 0, revenue: 10.005, unitCount: 0.333, costTotal: 3.333 },
      ],
      [],
    );

    expect(summary.revenue).toBe(20.01);
    expect(summary.unitsSold).toBe(0.666);
    expect(summary.cogs).toBe(6.67);
  });
});

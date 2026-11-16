import { roundMoney, roundQuantity } from './fefo';

export interface DailySaleRow {
  subtotal: number;
  discountTotal: number;
  revenue: number;
  unitCount: number;
  costTotal: number | null;
}

export interface DailyReturnRow {
  amount: number;
}

export interface DailySalesSummary {
  transactions: number;
  unitsSold: number;
  /** Value of goods sold before discounts. */
  grossSales: number;
  discounts: number;
  /** Gross sales minus discounts. Never labelled as profit. */
  revenue: number;
  refunds: number;
  /** Revenue minus refunds for the business day. */
  netSales: number;
  /** Cost of goods sold. Null when any sale is missing batch cost. */
  cogs: number | null;
  /** Net sales minus cost of goods sold. Null when cost is incomplete. */
  grossProfit: number | null;
}

/**
 * Single source of truth for daily income figures. Voided and cancelled sales
 * are filtered out by the caller so they can never be counted twice.
 */
export function summariseSalesDay(
  sales: DailySaleRow[],
  returns: DailyReturnRow[],
): DailySalesSummary {
  const grossSales = roundMoney(sales.reduce((total, sale) => total + sale.subtotal, 0));
  const discounts = roundMoney(sales.reduce((total, sale) => total + sale.discountTotal, 0));
  const revenue = roundMoney(sales.reduce((total, sale) => total + sale.revenue, 0));
  const refunds = roundMoney(returns.reduce((total, entry) => total + entry.amount, 0));
  const unitsSold = roundQuantity(sales.reduce((total, sale) => total + sale.unitCount, 0));
  const netSales = roundMoney(revenue - refunds);

  const missingCost = sales.some((sale) => sale.costTotal === null);
  const cogs = missingCost
    ? null
    : roundMoney(sales.reduce((total, sale) => total + (sale.costTotal ?? 0), 0));

  return {
    transactions: sales.length,
    unitsSold,
    grossSales,
    discounts,
    revenue,
    refunds,
    netSales,
    cogs,
    grossProfit: cogs === null ? null : roundMoney(netSales - cogs),
  };
}
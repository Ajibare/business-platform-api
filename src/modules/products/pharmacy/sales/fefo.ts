import { dateKeyFromCalendarDate } from '../../../../common/utils/time';

export interface FefoBatch {
  batchId: string;
  expiryDate: Date | null;
  /** Quantity currently recorded against the batch. */
  quantity: number;
  unitCost: number | null;
  sellingPrice: number | null;
}

export interface FefoAllocation {
  batchId: string;
  quantity: number;
  expiryDate: Date | null;
  unitCost: number | null;
  sellingPrice: number | null;
}

export interface SaleLinePlan {
  batchId: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  /** Quantity x unit price, after the line discount. */
  lineTotal: number;
  unitCost: number | null;
  costTotal: number | null;
}

export interface SalePlanTotals {
  subtotal: number;
  discountTotal: number;
  revenue: number;
  unitCount: number;
  /** Null when at least one line has no recorded batch cost. */
  costTotal: number | null;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function roundQuantity(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

/**
 * A batch is expired once its calendar expiry date is before today. Expiry
 * dates are stored as date-only values, so both sides are compared as keys.
 */
export function isExpiredOn(expiryDate: Date | null, todayKey: string): boolean {
  if (!expiryDate) return false;
  return dateKeyFromCalendarDate(expiryDate) < todayKey;
}

/**
 * Allocates a sale across batches using FEFO: the batch that expires first is
 * consumed first, and batches without an expiry date are consumed last.
 *
 * Expired batches and batches with no remaining stock never contribute. The
 * caller is responsible for persisting the allocations atomically.
 */
export function allocateFefo(
  batches: FefoBatch[],
  requested: number,
  todayKey: string,
): { allocations: FefoAllocation[]; available: number; shortage: number } {
  const eligible = batches
    .filter((batch) => batch.quantity > 0 && !isExpiredOn(batch.expiryDate, todayKey))
    .sort((left, right) => {
      if (left.expiryDate && right.expiryDate) {
        return left.expiryDate.getTime() - right.expiryDate.getTime();
      }
      if (left.expiryDate) return -1;
      if (right.expiryDate) return 1;
      return left.batchId.localeCompare(right.batchId);
    });

  const available = roundQuantity(eligible.reduce((total, batch) => total + batch.quantity, 0));
  if (requested <= 0) {
    return { allocations: [], available, shortage: 0 };
  }
  if (available < requested) {
    return { allocations: [], available, shortage: roundQuantity(requested - available) };
  }

  const allocations: FefoAllocation[] = [];
  let remaining = requested;
  for (const batch of eligible) {
    if (remaining <= 0) break;
    const take = roundQuantity(Math.min(batch.quantity, remaining));
    if (take <= 0) continue;
    allocations.push({
      batchId: batch.batchId,
      quantity: take,
      expiryDate: batch.expiryDate,
      unitCost: batch.unitCost,
      sellingPrice: batch.sellingPrice,
    });
    remaining = roundQuantity(remaining - take);
  }

  return { allocations, available, shortage: 0 };
}

/**
 * Prices the FEFO allocations. When no explicit unit price is supplied the
 * batch selling price is used. A line discount is spread across the
 * allocations in proportion to their value so the sale total always matches
 * the requested discount exactly.
 */
export function planSaleLines(input: {
  allocations: FefoAllocation[];
  unitPrice?: number | null;
  discount?: number;
}): { lines: SaleLinePlan[]; totals: SalePlanTotals } {
  const priced = input.allocations.map((allocation) => {
    const unitPrice = roundMoney(input.unitPrice ?? allocation.sellingPrice ?? 0);
    if (unitPrice < 0) {
      throw new Error('Unit price cannot be negative.');
    }
    const gross = roundMoney(unitPrice * allocation.quantity);
    return {
      allocation,
      unitPrice,
      gross,
      unitCost: allocation.unitCost,
      costTotal:
        allocation.unitCost === null ? null : roundMoney(allocation.unitCost * allocation.quantity),
    };
  });

  const grossTotal = roundMoney(priced.reduce((total, line) => total + line.gross, 0));
  const requestedDiscount = Math.max(0, roundMoney(input.discount ?? 0));
  const discountTotal = Math.min(requestedDiscount, grossTotal);

  const lines: SaleLinePlan[] = [];
  let allocatedDiscount = 0;
  priced.forEach((line, index) => {
    const isLast = index === priced.length - 1;
    const share = isLast
      ? roundMoney(discountTotal - allocatedDiscount)
      : grossTotal === 0
        ? 0
        : roundMoney((discountTotal * line.gross) / grossTotal);
    const discount = Math.min(share, line.gross);
    allocatedDiscount = roundMoney(allocatedDiscount + discount);

    lines.push({
      batchId: line.allocation.batchId,
      quantity: line.allocation.quantity,
      unitPrice: line.unitPrice,
      discount,
      lineTotal: roundMoney(line.gross - discount),
      unitCost: line.unitCost,
      costTotal: line.costTotal,
    });
  });

  const missingCost = lines.some((line) => line.costTotal === null);
  const totals: SalePlanTotals = {
    subtotal: grossTotal,
    discountTotal,
    revenue: roundMoney(grossTotal - discountTotal),
    unitCount: roundQuantity(lines.reduce((total, line) => total + line.quantity, 0)),
    costTotal: missingCost
      ? null
      : roundMoney(lines.reduce((total, line) => total + (line.costTotal ?? 0), 0)),
  };

  return { lines, totals };
}
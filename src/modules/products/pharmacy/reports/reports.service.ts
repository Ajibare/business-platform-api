import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { ExpiryService } from '../expiry/expiry.service';
import { DailySalesSummary, summariseSalesDay } from '../sales/daily-summary';
import {
  addDaysKey,
  dateKeyFromCalendarDate,
  diffDaysKeys,
  isValidDateKey,
  localDateKey,
  zonedDayRangeUtc,
} from '../../../../common/utils/time';

export interface DailyPerformance {
  date: string;
  timeZone: string;
  currency: string;
  branchIds: string[];
  consolidated: boolean;
  recordedStockIssues: {
    transactions: number;
    products: number;
    quantity: number;
  };
  sales: {
    available: true;
    transactions: number;
    products: number;
    amount: number;
  };
  income: DailySalesSummary;
  gain: {
    available: boolean;
    amount: number | null;
    reason: string;
  };
  commission: {
    available: false;
    amount: null;
    reason: string;
  };
  definitions: Record<string, string>;
}

export interface DashboardSummary {
  medicines: number;
  outOfStock: number;
  lowStock: number;
  nearExpiry: number;
  expired: number;
  unknownExpiry: number;
  estimatedValueAtRisk: number | null;
  /** How many branches produced these figures. */
  branches: number;
  consolidated: boolean;
}

export interface LowStockItem {
  medicineId: string;
  name: string;
  unit: string;
  reorderThreshold: number;
  totalRecordedQuantity: number;
}

/** One row of an inter-branch comparison. */
export interface BranchComparisonRow {
  branchId: string;
  name: string;
  code: string;
  status: string;
  sales: {
    transactions: number;
    units: number;
    revenue: number;
    grossProfit: number | null;
    refunds: number;
    netSales: number;
  };
  stock: {
    quantity: number;
    value: number | null;
    lowStock: number;
    outOfStock: number;
  };
  movements: {
    issued: number;
    received: number;
    transferredIn: number;
    transferredOut: number;
    adjustments: number;
  };
  expiry: {
    expiredBatches: number;
    nearExpiryBatches: number;
    expiredQuantity: number;
    nearExpiryQuantity: number;
    valueAtRisk: number | null;
  };
}

export interface BranchComparison {
  from: string;
  to: string;
  timeZone: string;
  currency: string;
  consolidated: boolean;
  branches: BranchComparisonRow[];
  totals: Omit<BranchComparisonRow, 'branchId' | 'name' | 'code' | 'status'>;
}

export type TrendGranularity = 'day' | 'week' | 'month';

export interface TrendPoint {
  /** `YYYY-MM-DD`, `YYYY-Www` or `YYYY-MM`. */
  period: string;
  label: string;
  sales: { transactions: number; revenue: number; units: number };
  movements: { issued: number; received: number };
  byBranch: Record<string, { transactions: number; revenue: number; units: number }>;
}

export interface PerformanceTrend {
  granularity: TrendGranularity;
  timeZone: string;
  currency: string;
  from: string;
  to: string;
  points: TrendPoint[];
  branches: { id: string; name: string; code: string }[];
}

/** Types that add stock. Anything else in the ledger removes it. */
const INBOUND_MOVEMENTS = new Set(['RECEIPT', 'OPENING', 'RETURN', 'TRANSFER_IN']);

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expiryService: ExpiryService,
  ) {}

  /**
   * Stock and expiry summary for the branches in scope. The medicine count is the
   * shared catalogue; quantities only ever come from the selected branches, so a
   * single-branch view never shows another branch's stock.
   */
  async getDashboard(
    organizationId: string,
    branchIds: string[],
    warningDays: number,
  ): Promise<{ data: DashboardSummary }> {
    const medicines = await this.prisma.product.findMany({
      where: { organizationId },
      select: { id: true, reorderThreshold: true },
    });
    const balances = await this.prisma.batchBalance.findMany({
      where: { organizationId, batch: { branchId: { in: branchIds } } },
      select: { batch: { select: { productId: true } }, quantity: true },
    });

    const quantitiesByMedicine = this.quantitiesByMedicine(balances);

    let outOfStock = 0;
    let lowStock = 0;
    for (const medicine of medicines) {
      const quantity = quantitiesByMedicine.get(medicine.id) ?? 0;
      if (medicine.reorderThreshold === null) continue;
      if (quantity <= 0) outOfStock += 1;
      if (quantity < medicine.reorderThreshold.toNumber()) lowStock += 1;
    }

    const [nearExpiry, expired, unknownExpiry] = await Promise.all([
      this.expiryService.findNear(organizationId, branchIds, warningDays),
      this.expiryService.findExpired(organizationId, branchIds),
      this.expiryService.findUnknown(organizationId, branchIds),
    ]);
    const estimatedValueAtRisk = nearExpiry.data.reduce(
      (total, batch) => (batch.unitCost !== null ? total + (batch.estimatedValue ?? 0) : total),
      0,
    );

    const summary: DashboardSummary = {
      medicines: medicines.length,
      outOfStock,
      lowStock,
      nearExpiry: nearExpiry.data.length,
      expired: expired.data.length,
      unknownExpiry: unknownExpiry.data.length,
      estimatedValueAtRisk: nearExpiry.data.some((batch) => batch.unitCost !== null)
        ? this.roundMoney(estimatedValueAtRisk)
        : null,
      branches: branchIds.length,
      consolidated: branchIds.length !== 1,
    };

    return { data: summary };
  }

  async getLowStock(
    organizationId: string,
    branchIds: string[],
  ): Promise<{ data: LowStockItem[] }> {
    const medicines = await this.prisma.product.findMany({
      where: { organizationId },
      select: { id: true, name: true, unit: true, reorderThreshold: true },
    });
    const balances = await this.prisma.batchBalance.findMany({
      where: { organizationId, batch: { branchId: { in: branchIds } } },
      select: { batch: { select: { productId: true } }, quantity: true },
    });

    const quantitiesByMedicine = this.quantitiesByMedicine(balances);

    const items: LowStockItem[] = [];
    for (const medicine of medicines) {
      if (medicine.reorderThreshold === null) continue;
      const quantity = quantitiesByMedicine.get(medicine.id) ?? 0;
      if (quantity < medicine.reorderThreshold.toNumber()) {
        items.push({
          medicineId: medicine.id,
          name: medicine.name,
          unit: medicine.unit,
          reorderThreshold: medicine.reorderThreshold.toNumber(),
          totalRecordedQuantity: quantity,
        });
      }
    }

    return { data: items };
  }

  /**
   * Daily operational and income metrics for the workspace date.
   *
   * Sales figures come from recorded sales only: voided sales are excluded, and
   * refunds are counted in the day they were given. Stock issues are reported
   * separately because an ISSUE movement is not necessarily a sale.
   */
  async getDailyPerformance(
    organizationId: string,
    branchIds: string[],
    requestedDate?: string,
  ): Promise<{ data: DailyPerformance }> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true, currency: true },
    });
    const timeZone = organization?.timezone ?? 'Africa/Lagos';
    const currency = organization?.currency ?? 'NGN';
    const date =
      requestedDate && isValidDateKey(requestedDate)
        ? requestedDate
        : localDateKey(new Date(), timeZone);

    const { start, end } = zonedDayRangeUtc(date, timeZone);

    const [issues, sales, returns] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where: {
          organizationId,
          branchId: { in: branchIds },
          type: 'ISSUE',
          occurredAt: { gte: start, lt: end },
        },
        select: {
          id: true,
          quantityDelta: true,
          batch: { select: { productId: true } },
        },
      }),
      this.prisma.sale.findMany({
        where: {
          organizationId,
          branchId: { in: branchIds },
          status: 'COMPLETED',
          occurredAt: { gte: start, lt: end },
        },
        select: {
          subtotal: true,
          discountTotal: true,
          revenue: true,
          unitCount: true,
          costTotal: true,
          lines: { select: { productId: true } },
        },
      }),
      this.prisma.saleReturn.findMany({
        where: { organizationId, sale: { branchId: { in: branchIds } }, occurredAt: { gte: start, lt: end } },
        select: { amount: true },
      }),
    ]);

    const productIds = new Set<string>();
    let quantity = 0;
    for (const issue of issues) {
      productIds.add(issue.batch.productId);
      quantity += Math.abs(this.toQuantity(issue.quantityDelta));
    }

    const soldProductIds = new Set<string>();
    const income = summariseSalesDay(
      sales.map((sale) => {
        for (const line of sale.lines) soldProductIds.add(line.productId);
        return {
          subtotal: this.toQuantity(sale.subtotal),
          discountTotal: this.toQuantity(sale.discountTotal),
          revenue: this.toQuantity(sale.revenue),
          unitCount: this.toQuantity(sale.unitCount),
          costTotal:
            sale.costTotal === null ? null : this.toQuantity(sale.costTotal),
        };
      }),
      returns.map((entry) => ({ amount: this.toQuantity(entry.amount) })),
    );

    return {
      data: {
        date,
        timeZone,
        currency,
        branchIds,
        consolidated: branchIds.length !== 1,
        recordedStockIssues: {
          transactions: issues.length,
          products: productIds.size,
          quantity,
        },
        sales: {
          available: true,
          transactions: income.transactions,
          products: soldProductIds.size,
          amount: income.revenue,
        },
        income,
        gain: {
          available: income.grossProfit !== null,
          amount: income.grossProfit,
          reason:
            income.grossProfit === null
              ? 'Gross profit is unavailable because at least one sale has no batch purchase cost recorded. Record unit cost on every batch to enable it.'
              : 'Net sales for the business day minus the recorded batch cost of goods sold.',
        },
        commission: {
          available: false,
          amount: null,
          reason:
            'Not available: no commission rules are defined (who earns commission, fixed or percentage, per product, transaction or user, and how returns are treated).',
        },
        definitions: {
          recordedStockIssues:
            'Number of ISSUE stock movements recorded on this date, the distinct products involved and the absolute quantity issued. Stock issues are operational movements and may include non-sale adjustments.',
          sales:
            'Completed sales transactions recorded on this date, the distinct products sold and the sales revenue after discounts. Voided sales are excluded.',
          'income.grossSales': 'Value of goods sold before discounts.',
          'income.discounts': 'Discount given on completed sales for the business day.',
          'income.revenue': 'Gross sales minus discounts. This is revenue, not profit.',
          'income.refunds': 'Refunds and customer returns recorded during the business day.',
          'income.netSales': 'Revenue minus refunds for the business day.',
          'income.cogs':
            'Purchase cost of the batches actually sold. Not shown when any sold batch has no recorded cost.',
          'income.grossProfit':
            'Net sales minus cost of goods sold. Does not include rent, salaries or other operating costs.',
          gain: 'Gross profit is selling price minus purchase cost for the units sold, net of refunds.',
          commission: 'Amount payable to staff or agents according to an approved commission rule. No rule has been approved.',
          dateWindow: `Daily totals use the ${timeZone} calendar day, from ${start.toISOString()} to ${end.toISOString()}.`,
        },
      },
    };
  }

  /**
   * Side-by-side figures for every branch in scope.
   *
   * One row per branch so a manager can see their own numbers next to the rest,
   * plus a total row that adds them up. Nothing here is combined across branches
   * before it is shown per branch.
   */
  async getBranchComparison(
    organizationId: string,
    branchIds: string[],
    options: { from?: string; to?: string } = {},
  ): Promise<{ data: BranchComparison }> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true, currency: true },
    });
    const timeZone = organization?.timezone ?? 'Africa/Lagos';
    const currency = organization?.currency ?? 'NGN';

    const todayKey = localDateKey(new Date(), timeZone);
    const toKey = options.to && isValidDateKey(options.to) ? options.to : todayKey;
    const fromKey =
      options.from && isValidDateKey(options.from) ? options.from : addDaysKey(toKey, -29);
    const { start } = zonedDayRangeUtc(fromKey, timeZone);
    const { end } = zonedDayRangeUtc(toKey, timeZone);

    const branches = await this.prisma.branch.findMany({
      where: { organizationId, id: { in: branchIds } },
      select: { id: true, name: true, code: true, status: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    const [products, sales, returns, movements, balances] = await Promise.all([
      this.prisma.product.findMany({
        where: { organizationId },
        select: { id: true, reorderThreshold: true },
      }),
      this.prisma.sale.findMany({
        where: {
          organizationId,
          branchId: { in: branchIds },
          status: 'COMPLETED',
          occurredAt: { gte: start, lt: end },
        },
        select: {
          branchId: true,
          revenue: true,
          subtotal: true,
          discountTotal: true,
          unitCount: true,
          costTotal: true,
        },
      }),
      this.prisma.saleReturn.findMany({
        where: { organizationId, occurredAt: { gte: start, lt: end }, sale: { branchId: { in: branchIds } } },
        select: { amount: true, sale: { select: { branchId: true } } },
      }),
      this.prisma.stockMovement.findMany({
        where: { organizationId, branchId: { in: branchIds }, occurredAt: { gte: start, lt: end } },
        select: { branchId: true, type: true, quantityDelta: true },
      }),
      this.prisma.batchBalance.findMany({
        where: { organizationId, batch: { branchId: { in: branchIds } } },
        select: {
          quantity: true,
          batch: {
            select: { branchId: true, productId: true, unitCost: true, expiryDate: true },
          },
        },
      }),
    ]);

    const nearExpiryCutoff = addDaysKey(todayKey, 30);

    const rows = branches.map<BranchComparisonRow>((branch) => {
      const branchSales = sales.filter((sale) => sale.branchId === branch.id);
      const branchReturns = returns.filter((entry) => entry.sale.branchId === branch.id);
      const branchMovements = movements.filter((movement) => movement.branchId === branch.id);
      const branchBalances = balances.filter((balance) => balance.batch.branchId === branch.id);

      return {
        branchId: branch.id,
        name: branch.name,
        code: branch.code,
        status: branch.status,
        ...this.summariseBranch({
          products,
          sales: branchSales,
          returns: branchReturns,
          movements: branchMovements,
          balances: branchBalances,
          todayKey,
          nearExpiryCutoff,
        }),
      };
    });

    const totals = this.summariseBranch({
      products,
      sales,
      returns,
      movements,
      balances,
      todayKey,
      nearExpiryCutoff,
    });

    return {
      data: {
        from: fromKey,
        to: toKey,
        timeZone,
        currency,
        consolidated: branchIds.length !== 1,
        branches: rows,
        totals,
      },
    };
  }

  /**
   * Sales and stock movement trend for the branches in scope, bucketed by day,
   * week or month in the organisation's time zone.
   */
  async getTrend(
    organizationId: string,
    branchIds: string[],
    options: { granularity?: TrendGranularity; points?: number } = {},
  ): Promise<{ data: PerformanceTrend }> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true, currency: true },
    });
    const timeZone = organization?.timezone ?? 'Africa/Lagos';
    const currency = organization?.currency ?? 'NGN';
    const granularity: TrendGranularity =
      options.granularity === 'week' || options.granularity === 'month'
        ? options.granularity
        : 'day';
    const points = Math.min(Math.max(Math.floor(options.points ?? 14), 2), 90);

    const todayKey = localDateKey(new Date(), timeZone);
    const bucketDays = granularity === 'day' ? 1 : granularity === 'week' ? 7 : 30;
    // Over-fetch one bucket so a partial first bucket still lines up with today.
    const fromKey = addDaysKey(todayKey, -(points * bucketDays - 1));
    const { start } = zonedDayRangeUtc(fromKey, timeZone);
    const { end } = zonedDayRangeUtc(todayKey, timeZone);

    const [branches, sales, movements] = await Promise.all([
      this.prisma.branch.findMany({
        where: { organizationId, id: { in: branchIds } },
        select: { id: true, name: true, code: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      }),
      this.prisma.sale.findMany({
        where: {
          organizationId,
          branchId: { in: branchIds },
          status: 'COMPLETED',
          occurredAt: { gte: start, lt: end },
        },
        select: { branchId: true, revenue: true, unitCount: true, occurredAt: true },
      }),
      this.prisma.stockMovement.findMany({
        where: { organizationId, branchId: { in: branchIds }, occurredAt: { gte: start, lt: end } },
        select: { branchId: true, type: true, quantityDelta: true, occurredAt: true },
      }),
    ]);

    const buckets = new Map<string, TrendPoint>();
    for (let offset = 0; offset < points; offset += 1) {
      const dateKey = addDaysKey(fromKey, offset * bucketDays);
      const period = this.periodKey(dateKey, granularity);
      if (buckets.has(period)) continue;
      buckets.set(period, {
        period,
        label: this.periodLabel(dateKey, granularity),
        sales: { transactions: 0, revenue: 0, units: 0 },
        movements: { issued: 0, received: 0 },
        byBranch: Object.fromEntries(
          branches.map((branch) => [
            branch.id,
            { transactions: 0, revenue: 0, units: 0 },
          ]),
        ),
      });
    }

    for (const sale of sales) {
      const dateKey = localDateKey(sale.occurredAt, timeZone);
      const point = buckets.get(this.periodKey(dateKey, granularity));
      if (!point) continue;
      const revenue = this.toQuantity(sale.revenue);
      const units = this.toQuantity(sale.unitCount);
      point.sales.transactions += 1;
      point.sales.revenue += revenue;
      point.sales.units += units;
      const branch = point.byBranch[sale.branchId];
      if (branch) {
        branch.transactions += 1;
        branch.revenue += revenue;
        branch.units += units;
      }
    }

    for (const movement of movements) {
      const dateKey = localDateKey(movement.occurredAt, timeZone);
      const point = buckets.get(this.periodKey(dateKey, granularity));
      if (!point) continue;
      const delta = Math.abs(this.toQuantity(movement.quantityDelta));
      if (INBOUND_MOVEMENTS.has(movement.type)) point.movements.received += delta;
      else point.movements.issued += delta;
    }

    const ordered = [...buckets.values()].map((point) => ({
      ...point,
      sales: { ...point.sales, revenue: this.roundMoney(point.sales.revenue) },
      byBranch: Object.fromEntries(
        Object.entries(point.byBranch).map(([branchId, value]) => [
          branchId,
          { ...value, revenue: this.roundMoney(value.revenue) },
        ]),
      ),
    }));

    return {
      data: {
        granularity,
        timeZone,
        currency,
        from: fromKey,
        to: todayKey,
        points: ordered,
        branches,
      },
    };
  }

  private summariseBranch(input: {
    products: { id: string; reorderThreshold: { toNumber: () => number } | null }[];
    sales: {
      revenue: unknown;
      subtotal: unknown;
      discountTotal: unknown;
      unitCount: unknown;
      costTotal: unknown;
    }[];
    returns: { amount: unknown }[];
    movements: { branchId: string; type: string; quantityDelta: unknown }[];
    balances: {
      quantity: unknown;
      batch: { productId: string; unitCost: unknown; expiryDate: Date | null };
    }[];
    todayKey: string;
    nearExpiryCutoff: string;
  }): Omit<BranchComparisonRow, 'branchId' | 'name' | 'code' | 'status'> {
    const revenue = input.sales.reduce((total, sale) => total + this.toQuantity(sale.revenue), 0);
    const units = input.sales.reduce((total, sale) => total + this.toQuantity(sale.unitCount), 0);
    const refunds = input.returns.reduce((total, entry) => total + this.toQuantity(entry.amount), 0);

    let cogs = 0;
    let hasCogs = true;
    for (const sale of input.sales) {
      if (sale.costTotal === null) {
        hasCogs = false;
        break;
      }
      cogs += this.toQuantity(sale.costTotal);
    }

    const quantitiesByMedicine = this.quantitiesByMedicine(input.balances);
    let lowStock = 0;
    let outOfStock = 0;
    for (const product of input.products) {
      if (product.reorderThreshold === null) continue;
      const quantity = quantitiesByMedicine.get(product.id) ?? 0;
      if (quantity <= 0) outOfStock += 1;
      if (quantity < product.reorderThreshold.toNumber()) lowStock += 1;
    }

    let quantity = 0;
    let value = 0;
    let hasValue = true;
    let expiredBatches = 0;
    let nearExpiryBatches = 0;
    let expiredQuantity = 0;
    let nearExpiryQuantity = 0;
    let valueAtRisk = 0;
    let hasValueAtRisk = false;

    for (const balance of input.balances) {
      const onHand = this.toQuantity(balance.quantity);
      quantity += onHand;
      const unitCost = balance.batch.unitCost === null ? null : this.toQuantity(balance.batch.unitCost);
      if (unitCost === null) hasValue = false;
      else value += onHand * unitCost;

      if (onHand <= 0 || !balance.batch.expiryDate) continue;
      const expiryKey = dateKeyFromCalendarDate(balance.batch.expiryDate);
      const daysRemaining = diffDaysKeys(input.todayKey, expiryKey);
      if (daysRemaining < 0) {
        expiredBatches += 1;
        expiredQuantity += onHand;
        if (unitCost !== null) {
          hasValueAtRisk = true;
          valueAtRisk += onHand * unitCost;
        }
      } else if (expiryKey <= input.nearExpiryCutoff) {
        nearExpiryBatches += 1;
        nearExpiryQuantity += onHand;
        if (unitCost !== null) {
          hasValueAtRisk = true;
          valueAtRisk += onHand * unitCost;
        }
      }
    }

    const movements = {
      issued: 0,
      received: 0,
      transferredIn: 0,
      transferredOut: 0,
      adjustments: 0,
    };
    for (const movement of input.movements) {
      const delta = Math.abs(this.toQuantity(movement.quantityDelta));
      if (movement.type === 'TRANSFER_IN') movements.transferredIn += delta;
      else if (movement.type === 'TRANSFER_OUT') movements.transferredOut += delta;
      else if (movement.type === 'ADJUSTMENT') movements.adjustments += delta;
      else if (INBOUND_MOVEMENTS.has(movement.type)) movements.received += delta;
      else movements.issued += delta;
    }

    return {
      sales: {
        transactions: input.sales.length,
        units,
        revenue: this.roundMoney(revenue),
        grossProfit: hasCogs ? this.roundMoney(revenue - refunds - cogs) : null,
        refunds: this.roundMoney(refunds),
        netSales: this.roundMoney(revenue - refunds),
      },
      stock: {
        quantity,
        value: hasValue ? this.roundMoney(value) : null,
        lowStock,
        outOfStock,
      },
      movements,
      expiry: {
        expiredBatches,
        nearExpiryBatches,
        expiredQuantity,
        nearExpiryQuantity,
        valueAtRisk: hasValueAtRisk ? this.roundMoney(valueAtRisk) : null,
      },
    };
  }

  private quantitiesByMedicine(
    balances: { batch: { productId: string }; quantity: unknown }[],
  ): Map<string, number> {
    const quantities = new Map<string, number>();
    for (const balance of balances) {
      const current = quantities.get(balance.batch.productId) ?? 0;
      quantities.set(balance.batch.productId, current + this.toQuantity(balance.quantity));
    }
    return quantities;
  }

  private periodKey(dateKey: string, granularity: TrendGranularity): string {
    if (granularity === 'month') return dateKey.slice(0, 7);
    if (granularity === 'day') return dateKey;
    // Weeks are labelled by their Monday so a week never splits across buckets.
    const value = new Date(`${dateKey}T00:00:00.000Z`);
    const weekday = value.getUTCDay();
    const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
    value.setUTCDate(value.getUTCDate() + mondayOffset);
    return `W${value.toISOString().slice(0, 10)}`;
  }

  private periodLabel(dateKey: string, granularity: TrendGranularity): string {
    if (granularity === 'month') return dateKey.slice(0, 7);
    if (granularity === 'week') return `Week of ${this.periodKey(dateKey, 'week').slice(1)}`;
    return dateKey;
  }

  private roundMoney(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private toQuantity(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
  }
}

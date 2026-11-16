import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { ExpiryService } from '../expiry/expiry.service';
import { DailySalesSummary, summariseSalesDay } from '../sales/daily-summary';
import {
  isValidDateKey,
  localDateKey,
  zonedDayRangeUtc,
} from '../../../../common/utils/time';

export interface DailyPerformance {
  date: string;
  timeZone: string;
  currency: string;
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
}

export interface LowStockItem {
  medicineId: string;
  name: string;
  unit: string;
  reorderThreshold: number;
  totalRecordedQuantity: number;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expiryService: ExpiryService,
  ) {}

  async getDashboard(organizationId: string, warningDays: number): Promise<{ data: DashboardSummary }> {
    const medicines = await this.prisma.product.findMany({
      where: { organizationId },
      select: { id: true, reorderThreshold: true },
    });
    const balances = await this.prisma.batchBalance.findMany({
      where: { organizationId },
      select: { batch: { select: { productId: true } }, quantity: true },
    });

    const quantitiesByMedicine = new Map<string, number>();
    for (const balance of balances) {
      const current = quantitiesByMedicine.get(balance.batch.productId) ?? 0;
      quantitiesByMedicine.set(balance.batch.productId, current + this.toQuantity(balance.quantity));
    }

    let outOfStock = 0;
    let lowStock = 0;
    for (const medicine of medicines) {
      const quantity = quantitiesByMedicine.get(medicine.id) ?? 0;
      if (medicine.reorderThreshold === null) continue;
      if (quantity <= 0) outOfStock += 1;
      if (quantity < medicine.reorderThreshold.toNumber()) lowStock += 1;
    }

    const nearExpiry = await this.expiryService.findNear(organizationId, warningDays);
    const expired = await this.expiryService.findExpired(organizationId);
    const unknownExpiry = await this.expiryService.findUnknown(organizationId);
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
      estimatedValueAtRisk: nearExpiry.data.some((batch) => batch.unitCost !== null) ? estimatedValueAtRisk : null,
    };

    return { data: summary };
  }

  async getLowStock(organizationId: string): Promise<{ data: LowStockItem[] }> {
    const medicines = await this.prisma.product.findMany({
      where: { organizationId },
      select: { id: true, name: true, unit: true, reorderThreshold: true },
    });
    const balances = await this.prisma.batchBalance.findMany({
      where: { organizationId },
      select: { batch: { select: { productId: true } }, quantity: true },
    });

    const quantitiesByMedicine = new Map<string, number>();
    for (const balance of balances) {
      const current = quantitiesByMedicine.get(balance.batch.productId) ?? 0;
      quantitiesByMedicine.set(balance.batch.productId, current + this.toQuantity(balance.quantity));
    }

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

  private toQuantity(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
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
        where: { organizationId, occurredAt: { gte: start, lt: end } },
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
}

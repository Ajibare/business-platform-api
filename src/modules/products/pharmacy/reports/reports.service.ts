import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { ExpiryService } from '../expiry/expiry.service';

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
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';

export interface ExpiryBatchRecord {
  batchId: string;
  productId: string;
  medicineName: string;
  batchNumber: string | null;
  expiryDate: Date;
  quantity: number;
  unitCost: number | null;
  estimatedValue: number | null;
}

@Injectable()
export class ExpiryService {
  constructor(private readonly prisma: PrismaService) {}

  async findNear(organizationId: string, warningDays: number): Promise<{ data: ExpiryBatchRecord[] }> {
    const threshold = new Date(Date.now() + warningDays * 24 * 60 * 60 * 1000);
    const batches = await this.prisma.batch.findMany({
      where: { organizationId, expiryDate: { not: null } },
      orderBy: { expiryDate: 'asc' },
    });

    const items: ExpiryBatchRecord[] = [];
    for (const batch of batches) {
      if (!batch.expiryDate) continue;
      if (batch.expiryDate <= new Date() || batch.expiryDate > threshold) continue;
      const balance = await this.prisma.batchBalance.findFirst({
        where: { organizationId, batchId: batch.id },
      });
      const quantity = balance ? this.toQuantity(balance.quantity) : 0;
      if (quantity <= 0) continue;
      const medicine = await this.prisma.product.findFirst({
        where: { id: batch.productId, organizationId },
      });
      items.push({
        batchId: batch.id,
        productId: batch.productId,
        medicineName: medicine?.name ?? '',
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        quantity,
        unitCost: batch.unitCost !== null ? this.toQuantity(batch.unitCost) : null,
        estimatedValue: batch.unitCost !== null ? quantity * this.toQuantity(batch.unitCost) : null,
      });
    }

    return { data: items };
  }

  async findExpired(organizationId: string): Promise<{ data: ExpiryBatchRecord[] }> {
    const batches = await this.prisma.batch.findMany({
      where: { organizationId, expiryDate: { not: null } },
      orderBy: { expiryDate: 'asc' },
    });

    const items: ExpiryBatchRecord[] = [];
    for (const batch of batches) {
      if (!batch.expiryDate) continue;
      if (batch.expiryDate >= new Date()) continue;
      const balance = await this.prisma.batchBalance.findFirst({
        where: { organizationId, batchId: batch.id },
      });
      const quantity = balance ? this.toQuantity(balance.quantity) : 0;
      if (quantity <= 0) continue;
      const medicine = await this.prisma.product.findFirst({
        where: { id: batch.productId, organizationId },
      });
      items.push({
        batchId: batch.id,
        productId: batch.productId,
        medicineName: medicine?.name ?? '',
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        quantity,
        unitCost: batch.unitCost !== null ? this.toQuantity(batch.unitCost) : null,
        estimatedValue: batch.unitCost !== null ? quantity * this.toQuantity(batch.unitCost) : null,
      });
    }

    return { data: items };
  }

  async findUnknown(organizationId: string): Promise<{ data: ExpiryBatchRecord[] }> {
    const batches = await this.prisma.batch.findMany({
      where: { organizationId, expiryDate: null },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const items: ExpiryBatchRecord[] = [];
    for (const batch of batches) {
      const balance = await this.prisma.batchBalance.findFirst({
        where: { organizationId, batchId: batch.id },
      });
      const quantity = balance ? this.toQuantity(balance.quantity) : 0;
      if (quantity <= 0) continue;
      const medicine = await this.prisma.product.findFirst({
        where: { id: batch.productId, organizationId },
      });
      items.push({
        batchId: batch.id,
        productId: batch.productId,
        medicineName: medicine?.name ?? '',
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate ?? new Date(),
        quantity,
        unitCost: batch.unitCost !== null ? this.toQuantity(batch.unitCost) : null,
        estimatedValue: batch.unitCost !== null ? quantity * this.toQuantity(batch.unitCost) : null,
      });
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

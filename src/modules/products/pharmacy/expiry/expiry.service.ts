import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import {
  dateKeyFromCalendarDate,
  diffDaysKeys,
  localDateKey,
} from '../../../../common/utils/time';
import {
  EXPIRY_BUCKET_LABELS,
  ExpiryBucket,
  ExpirySeverity,
  categoriseExpiry,
} from './expiry-alerts';

export interface ExpiryBatchRecord {
  batchId: string;
  branchId: string;
  branchName: string;
  productId: string;
  medicineName: string;
  batchNumber: string | null;
  expiryDate: Date;
  quantity: number;
  unitCost: number | null;
  estimatedValue: number | null;
}

export interface ExpiryAlertItem {
  batchId: string;
  branchId: string;
  branchName: string;
  productId: string;
  medicineName: string;
  batchNumber: string | null;
  expiryDate: string;
  daysRemaining: number;
  quantity: number;
  unit: string;
  unitCost: number | null;
  valueAtRisk: number | null;
  bucket: ExpiryBucket;
  severity: ExpirySeverity;
  statusLabel: string;
}

export interface ExpiryAlertCounts {
  expired: number;
  within30: number;
  within60: number;
  within90: number;
}

export interface ExpiryAlerts {
  generatedAt: string;
  timeZone: string;
  windowDays: number;
  counts: ExpiryAlertCounts;
  totals: ExpiryAlertCounts & {
    batches: number;
    medicines: number;
    valueAtRisk: number | null;
  };
  items: ExpiryAlertItem[];
}

const BATCH_INCLUDE = {
  product: { select: { id: true, name: true, unit: true, active: true } },
  balance: { select: { quantity: true } },
  branch: { select: { id: true, name: true } },
} satisfies Prisma.BatchInclude;

type BatchWithContext = Prisma.BatchGetPayload<{ include: typeof BATCH_INCLUDE }>;

@Injectable()
export class ExpiryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Batch level expiry overview used by the login alert popup and the expiry
   * screen. Only batches that still hold stock are returned; a medicine can
   * appear several times, once per batch.
   */
  async getAlerts(
    organizationId: string,
    branchIds: string[],
    options: { windowDays?: number; search?: string } = {},
  ): Promise<{ data: ExpiryAlerts }> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true, nearExpiryWarningDays: true },
    });
    const timeZone = organization?.timezone ?? 'Africa/Lagos';
    const windowDays = this.clampWindow(
      options.windowDays ?? organization?.nearExpiryWarningDays ?? 90,
    );
    const todayKey = localDateKey(new Date(), timeZone);
    const search = options.search?.trim();

    const batches = await this.prisma.batch.findMany({
      where: {
        organizationId,
        branchId: { in: branchIds },
        expiryDate: { not: null },
        product: { active: true },
        // Searching matches the batch number or the medicine, never only one of them.
        ...(search
          ? {
              OR: [
                { batchNumber: { contains: search, mode: 'insensitive' as const } },
                {
                  product: {
                    is: {
                      OR: [
                        { name: { contains: search, mode: 'insensitive' as const } },
                        { genericName: { contains: search, mode: 'insensitive' as const } },
                        { brand: { contains: search, mode: 'insensitive' as const } },
                      ],
                    },
                  },
                },
              ],
            }
          : {}),
      },
      include: BATCH_INCLUDE,
      orderBy: { expiryDate: 'asc' },
    });

    const items: ExpiryAlertItem[] = [];
    const counts: ExpiryAlertCounts = { expired: 0, within30: 0, within60: 0, within90: 0 };
    const medicineIds = new Set<string>();
    let valueAtRisk = 0;
    let hasCost = false;

    for (const batch of batches) {
      if (!batch.expiryDate) continue;
      const quantity = this.toQuantity(batch.balance?.quantity);
      // Depleted, returned or written-off batches are not an active risk.
      if (quantity <= 0) continue;

      const daysRemaining = diffDaysKeys(todayKey, dateKeyFromCalendarDate(batch.expiryDate));
      if (daysRemaining > windowDays) continue;

      const { bucket, severity } = categoriseExpiry(daysRemaining, windowDays);
      const unitCost = batch.unitCost === null ? null : this.toQuantity(batch.unitCost);
      const value = unitCost === null ? null : this.roundMoney(unitCost * quantity);

      items.push({
        batchId: batch.id,
        branchId: batch.branchId,
        branchName: batch.branch.name,
        productId: batch.productId,
        medicineName: batch.product.name,
        batchNumber: batch.batchNumber,
        expiryDate: dateKeyFromCalendarDate(batch.expiryDate),
        daysRemaining,
        quantity,
        unit: batch.unit ?? batch.product.unit,
        unitCost,
        valueAtRisk: value,
        bucket,
        severity,
        statusLabel: EXPIRY_BUCKET_LABELS[bucket],
      });

      medicineIds.add(batch.productId);
      if (value !== null) {
        hasCost = true;
        valueAtRisk += value;
      }

      switch (bucket) {
        case 'EXPIRED':
          counts.expired += 1;
          break;
        case 'WITHIN_30':
          counts.within30 += 1;
          break;
        case 'WITHIN_60':
          counts.within60 += 1;
          break;
        case 'WITHIN_90':
          counts.within90 += 1;
          break;
        default:
          break;
      }
    }

    return {
      data: {
        generatedAt: new Date().toISOString(),
        timeZone,
        windowDays,
        counts,
        totals: {
          ...counts,
          batches: items.length,
          medicines: medicineIds.size,
          valueAtRisk: hasCost ? this.roundMoney(valueAtRisk) : null,
        },
        items,
      },
    };
  }

  async findNear(
    organizationId: string,
    branchIds: string[],
    warningDays: number,
  ): Promise<{ data: ExpiryBatchRecord[] }> {
    const windowDays = this.clampWindow(warningDays);
    const threshold = new Date(Date.now() + windowDays * 24 * 60 * 60 * 1000);
    const batches = await this.prisma.batch.findMany({
      where: {
        organizationId,
        branchId: { in: branchIds },
        expiryDate: { not: null, gt: new Date(), lte: threshold },
      },
      include: BATCH_INCLUDE,
      orderBy: { expiryDate: 'asc' },
    });

    return { data: this.toRecords(batches, (batch) => Boolean(batch.expiryDate)) };
  }

  async findExpired(
    organizationId: string,
    branchIds: string[],
  ): Promise<{ data: ExpiryBatchRecord[] }> {
    const batches = await this.prisma.batch.findMany({
      where: { organizationId, branchId: { in: branchIds }, expiryDate: { not: null, lt: new Date() } },
      include: BATCH_INCLUDE,
      orderBy: { expiryDate: 'asc' },
    });

    return { data: this.toRecords(batches, (batch) => Boolean(batch.expiryDate)) };
  }

  async findUnknown(
    organizationId: string,
    branchIds: string[],
  ): Promise<{ data: ExpiryBatchRecord[] }> {
    const batches = await this.prisma.batch.findMany({
      where: { organizationId, branchId: { in: branchIds }, expiryDate: null },
      include: BATCH_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return { data: this.toRecords(batches, () => true) };
  }

  private toRecords(
    batches: BatchWithContext[],
    include: (batch: BatchWithContext) => boolean,
  ): ExpiryBatchRecord[] {
    const items: ExpiryBatchRecord[] = [];
    for (const batch of batches) {
      if (!include(batch)) continue;
      const quantity = this.toQuantity(batch.balance?.quantity);
      if (quantity <= 0) continue;
      const unitCost = batch.unitCost === null ? null : this.toQuantity(batch.unitCost);
      items.push({
        batchId: batch.id,
        branchId: batch.branchId,
        branchName: batch.branch.name,
        productId: batch.productId,
        medicineName: batch.product.name,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate ?? new Date(),
        quantity,
        unitCost,
        estimatedValue: unitCost === null ? null : this.roundMoney(quantity * unitCost),
      });
    }
    return items;
  }

  private clampWindow(value: number): number {
    if (!Number.isFinite(value)) return 90;
    return Math.min(Math.max(Math.floor(value), 1), 365);
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
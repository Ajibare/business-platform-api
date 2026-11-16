import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { AuditService } from '../../../platform/audit/audit.service';
import { dateKeyFromCalendarDate, diffDaysKeys, localDateKey } from '../../../../common/utils/time';
import { isValidBarcode, normalizeBarcode } from './barcode.util';

export interface BarcodeBatchRecord {
  id: string;
  batchNumber: string | null;
  expiryDate: Date | null;
  unit: string;
  unitCost: number | null;
  sellingPrice: number | null;
  balanceQuantity: number;
  daysToExpiry: number | null;
  expiryStatus: 'EXPIRED' | 'EXPIRING_SOON' | 'OK' | 'UNKNOWN';
}

export interface BarcodeLookupRecord {
  barcode: string;
  product: {
    id: string;
    name: string;
    brand: string | null;
    strength: string | null;
    dosageForm: string | null;
    packSize: string | null;
    unit: string;
    barcode: string | null;
    reorderThreshold: number | null;
    active: boolean;
    totalRecordedQuantity: number;
  };
  batches: BarcodeBatchRecord[];
}

@Injectable()
export class BarcodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async lookup(organizationId: string, rawCode: string): Promise<BarcodeLookupRecord> {
    const code = normalizeBarcode(rawCode);
    if (!code) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Enter a barcode to search.',
      });
    }

    const product = await this.prisma.product.findFirst({
      where: { organizationId, barcode: code },
      include: {
        batches: {
          include: { balance: { select: { quantity: true } } },
          orderBy: { expiryDate: 'asc' },
        },
      },
    });

    if (!product) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'No product in this pharmacy matches that barcode.',
      });
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true, nearExpiryWarningDays: true },
    });
    const timeZone = organization?.timezone ?? 'Africa/Lagos';
    const warningWindowDays = organization?.nearExpiryWarningDays ?? 90;
    const todayKey = localDateKey(new Date(), timeZone);

    let totalRecordedQuantity = 0;
    const batches: BarcodeBatchRecord[] = product.batches.map((batch) => {
      const quantity = batch.balance ? this.toNumber(batch.balance.quantity) : 0;
      totalRecordedQuantity += quantity;
      const daysToExpiry = batch.expiryDate
        ? diffDaysKeys(todayKey, dateKeyFromCalendarDate(batch.expiryDate))
        : null;

      return {
        id: batch.id,
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        unit: batch.unit,
        unitCost: batch.unitCost !== null ? this.toNumber(batch.unitCost) : null,
        sellingPrice: batch.sellingPrice !== null ? this.toNumber(batch.sellingPrice) : null,
        balanceQuantity: quantity,
        daysToExpiry,
        expiryStatus: this.expiryStatus(daysToExpiry, warningWindowDays),
      };
    });

    return {
      barcode: code,
      product: {
        id: product.id,
        name: product.name,
        brand: product.brand,
        strength: product.strength,
        dosageForm: product.dosageForm,
        packSize: product.packSize,
        unit: product.unit,
        barcode: product.barcode,
        reorderThreshold:
          product.reorderThreshold !== null ? this.toNumber(product.reorderThreshold) : null,
        active: product.active,
        totalRecordedQuantity,
      },
      batches,
    };
  }

  async assertAvailable(organizationId: string, barcode: string, excludeProductId?: string) {
    const existing = await this.prisma.product.findFirst({
      where: {
        organizationId,
        barcode,
        ...(excludeProductId ? { NOT: { id: excludeProductId } } : {}),
      },
      select: { id: true, name: true },
    });

    if (existing) {
      throw new ConflictException({
        code: 'DUPLICATE_REQUEST',
        message: `This barcode is already assigned to ${existing.name}.`,
      });
    }
  }

  async assign(organizationId: string, actorId: string, productId: string, rawBarcode: string | null) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, organizationId },
      select: { id: true, name: true },
    });
    if (!product) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Product not found' });
    }

    if (rawBarcode === null || rawBarcode.trim() === '') {
      await this.prisma.product.update({ where: { id: productId }, data: { barcode: null } });
      await this.auditService.record({
        organizationId,
        actorId,
        action: 'BARCODE_CLEARED',
        entityType: 'Product',
        entityId: productId,
        metadata: { name: product.name },
      });
      return { data: { id: productId, name: product.name, barcode: null } };
    }

    const barcode = normalizeBarcode(rawBarcode);
    if (!isValidBarcode(barcode)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message:
          'Barcodes must be 4 to 64 characters and may only contain letters, numbers, dot, dash or underscore.',
      });
    }

    await this.assertAvailable(organizationId, barcode, productId);

    const updated = await this.prisma.product.update({
      where: { id: productId },
      data: { barcode },
      select: { id: true, name: true, barcode: true },
    });

    await this.auditService.record({
      organizationId,
      actorId,
      action: 'BARCODE_ASSIGNED',
      entityType: 'Product',
      entityId: productId,
      metadata: { barcode, name: product.name },
    });

    return { data: updated };
  }

  /** Uses the near-expiry window configured during pharmacy setup (default 90 days). */
  private expiryStatus(
    daysToExpiry: number | null,
    warningWindowDays: number,
  ): BarcodeBatchRecord['expiryStatus'] {
    if (daysToExpiry === null) return 'UNKNOWN';
    if (daysToExpiry < 0) return 'EXPIRED';
    if (daysToExpiry <= warningWindowDays) return 'EXPIRING_SOON';
    return 'OK';
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
  }
}

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { AuditService } from '../../../platform/audit/audit.service';
import { dateKeyFromCalendarDate, localDateKey } from '../../../../common/utils/time';
import { normalizeProductName } from '../../../../common/utils/product-name';
import { BulkCreateMedicinesDto, BulkMedicineRowDto } from './dto/bulk-create-medicines.dto';

export interface BulkMedicineRowResult {
  /** 1-based position of the row in the request. */
  row: number;
  name: string;
  status: 'CREATED' | 'BATCH_ADDED' | 'FAILED';
  medicineId: string | null;
  batchId: string | null;
  quantity: number | null;
  errors: string[];
  warnings: string[];
}

export interface BulkMedicineResult {
  totalRows: number;
  created: number;
  batchesAdded: number;
  failed: number;
  rows: BulkMedicineRowResult[];
}

interface CachedProduct {
  id: string;
  name: string;
  unit: string;
  normalizedName: string;
  sku: string | null;
}

/**
 * Creates several medicines, and their opening batches, in one request.
 *
 * Every row is processed in its own transaction so one bad row cannot block the
 * rest, and each row reports its own result. Repeating a medicine name is
 * allowed when the repeated row carries batch details, which is how a medicine
 * starts life with more than one batch.
 */
@Injectable()
export class BulkMedicinesService {
  private readonly logger = new Logger(BulkMedicinesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async createMany(
    organizationId: string,
    actorId: string,
    dto: BulkCreateMedicinesDto,
  ): Promise<BulkMedicineResult> {
    const [organization, existingProducts] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { timezone: true },
      }),
      this.prisma.product.findMany({
        where: { organizationId },
        select: { id: true, name: true, unit: true, normalizedName: true, sku: true },
      }),
    ]);
    const timeZone = organization?.timezone ?? 'Africa/Lagos';
    const todayKey = localDateKey(new Date(), timeZone);

    const products = new Map<string, CachedProduct>(
      existingProducts.map((product) => [product.normalizedName, product]),
    );
    const skus = new Set(
      existingProducts.map((product) => product.sku).filter((sku): sku is string => Boolean(sku)),
    );

    const supplierIds = [
      ...new Set(dto.rows.map((row) => row.supplierId).filter((id): id is string => Boolean(id))),
    ];
    const suppliers = supplierIds.length
      ? await this.prisma.supplier.findMany({
          where: { organizationId, id: { in: supplierIds } },
          select: { id: true },
        })
      : [];
    const knownSuppliers = new Set(suppliers.map((supplier) => supplier.id));

    const rows: BulkMedicineRowResult[] = [];
    for (const [index, row] of dto.rows.entries()) {
      const rowNumber = index + 1;
      try {
        const result = await this.createRow({
          organizationId,
          actorId,
          row,
          rowNumber,
          todayKey,
          products,
          skus,
          knownSuppliers,
        });
        rows.push(result);

        if (result.medicineId && result.status !== 'FAILED') {
          const normalizedName = normalizeProductName(row.name);
          if (!products.has(normalizedName)) {
            products.set(normalizedName, {
              id: result.medicineId,
              name: row.name.trim(),
              unit: row.unit.trim(),
              normalizedName,
              sku: row.sku?.trim() || null,
            });
          }
          if (row.sku?.trim()) skus.add(row.sku.trim());
        }
      } catch (error) {
        rows.push({
          row: rowNumber,
          name: row.name,
          status: 'FAILED',
          medicineId: null,
          batchId: null,
          quantity: null,
          errors: [this.describeError(error)],
          warnings: [],
        });
      }
    }

    const summary: BulkMedicineResult = {
      totalRows: rows.length,
      created: rows.filter((row) => row.status === 'CREATED').length,
      batchesAdded: rows.filter((row) => row.status === 'BATCH_ADDED').length,
      failed: rows.filter((row) => row.status === 'FAILED').length,
      rows,
    };

    await this.auditService.record({
      organizationId,
      actorId,
      action: 'MEDICINES_BULK_CREATED',
      entityType: 'Product',
      entityId: organizationId,
      metadata: {
        totalRows: summary.totalRows,
        created: summary.created,
        batchesAdded: summary.batchesAdded,
        failed: summary.failed,
      },
    });

    if (summary.failed > 0) {
      this.logger.warn(
        `Bulk medicine creation for ${organizationId}: ${summary.failed} of ${summary.totalRows} rows failed.`,
      );
    }

    return summary;
  }

  private async createRow(input: {
    organizationId: string;
    actorId: string;
    row: BulkMedicineRowDto;
    rowNumber: number;
    todayKey: string;
    products: Map<string, CachedProduct>;
    skus: Set<string>;
    knownSuppliers: Set<string>;
  }): Promise<BulkMedicineRowResult> {
    const { organizationId, actorId, row, rowNumber, products, skus } = input;

    const name = row.name?.trim() ?? '';
    const unit = row.unit?.trim() ?? '';
    if (!name) throw new BadRequestException('Medicine name is required.');
    if (!unit) throw new BadRequestException('Unit is required.');
    if (row.supplierId && !input.knownSuppliers.has(row.supplierId)) {
      throw new BadRequestException('The selected supplier was not found for this pharmacy.');
    }

    const normalizedName = normalizeProductName(name);
    const sku = row.sku?.trim() || null;
    const hasBatch = Boolean(
      row.batchNumber?.trim() ||
        row.expiryDate ||
        row.quantity !== undefined ||
        row.unitCost !== undefined ||
        row.sellingPrice !== undefined,
    );

    const quantity = row.quantity ?? 0;
    if (hasBatch && (!Number.isFinite(quantity) || quantity <= 0)) {
      throw new BadRequestException('Quantity must be greater than zero for a new batch.');
    }

    const expiryDate = this.parseExpiry(row.expiryDate);
    const warnings = this.buildWarnings({ expiryDate, todayKey: input.todayKey, row });

    // A brand new SKU must not collide with an existing medicine.
    if (sku && !products.has(normalizedName) && skus.has(sku)) {
      throw new BadRequestException(`SKU ${sku} is already used by another medicine.`);
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      let product = products.get(normalizedName);
      let medicineCreated = false;

      if (!product) {
        const created = await tx.product.create({
          data: {
            organizationId,
            name,
            normalizedName,
            genericName: row.genericName?.trim() || null,
            category: row.category?.trim() || null,
            brand: row.brand?.trim() || null,
            strength: row.strength?.trim() || null,
            dosageForm: row.dosageForm?.trim() || null,
            packSize: row.packSize?.trim() || null,
            unit,
            sku,
            reorderThreshold: row.reorderThreshold ?? null,
          },
          select: { id: true, name: true, unit: true, normalizedName: true, sku: true },
        });
        product = created;
        medicineCreated = true;
      }

      if (!hasBatch) {
        if (!medicineCreated) {
          throw new BadRequestException(
            `A medicine named "${name}" already exists. Add a batch number or quantity to add stock to it.`,
          );
        }
        return { status: 'CREATED' as const, medicineId: product.id, batchId: null, quantity: null };
      }

      const batchData = {
        organizationId,
        productId: product.id,
        batchNumber: row.batchNumber?.trim() || null,
        expiryDate,
        unit: product.unit || unit,
        unitCost: row.unitCost ?? null,
        sellingPrice: row.sellingPrice ?? null,
      };

      if (row.supplierId) {
        // Mirrors ReceiptsService.confirm so supplier receipts and stock agree.
        const receipt = await tx.stockReceipt.create({
          data: {
            organizationId,
            supplierId: row.supplierId,
            externalReference: 'Bulk medicine creation',
            status: 'DRAFT',
            actorId,
            lines: {
              create: [
                {
                  productId: product.id,
                  batchNumber: batchData.batchNumber,
                  expiryDate,
                  unitCost: batchData.unitCost,
                  sellingPrice: batchData.sellingPrice,
                  quantity,
                },
              ],
            },
          },
          include: { lines: { select: { id: true } } },
        });

        const batch = await tx.batch.create({ data: batchData, select: { id: true } });
        await this.recordOpeningStock(tx, {
          organizationId,
          actorId,
          batchId: batch.id,
          quantity,
          type: 'RECEIPT',
          reason: 'Bulk medicine creation via supplier receipt',
          idempotencyKey: `bulk:${receipt.id}:${receipt.lines[0]?.id ?? batch.id}`,
        });
        await tx.stockReceipt.update({ where: { id: receipt.id }, data: { status: 'CONFIRMED' } });

        return {
          status: medicineCreated ? ('CREATED' as const) : ('BATCH_ADDED' as const),
          medicineId: product.id,
          batchId: batch.id,
          quantity,
        };
      }

      const batch = await tx.batch.create({ data: batchData, select: { id: true } });
      await this.recordOpeningStock(tx, {
        organizationId,
        actorId,
        batchId: batch.id,
        quantity,
        type: 'OPENING',
        reason: 'Bulk medicine creation',
        idempotencyKey: `bulk:${batch.id}`,
      });

      return {
        status: medicineCreated ? ('CREATED' as const) : ('BATCH_ADDED' as const),
        medicineId: product.id,
        batchId: batch.id,
        quantity,
      };
    });

    return {
      row: rowNumber,
      name,
      status: outcome.status,
      medicineId: outcome.medicineId,
      batchId: outcome.batchId,
      quantity: outcome.quantity,
      errors: [],
      warnings,
    };
  }

  /** Writes the movement and the batch balance together, like every other stock path. */
  private async recordOpeningStock(
    tx: PrismaTransaction,
    input: {
      organizationId: string;
      actorId: string;
      batchId: string;
      quantity: number;
      type: 'OPENING' | 'RECEIPT';
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<void> {
    await tx.stockMovement.create({
      data: {
        organizationId: input.organizationId,
        batchId: input.batchId,
        type: input.type,
        quantityDelta: input.quantity,
        previousQuantity: 0,
        newQuantity: input.quantity,
        reason: input.reason,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
      },
    });

    await tx.batchBalance.create({
      data: {
        organizationId: input.organizationId,
        batchId: input.batchId,
        quantity: input.quantity,
        version: 1,
      },
    });
  }

  private buildWarnings(input: {
    expiryDate: Date | null;
    todayKey: string;
    row: BulkMedicineRowDto;
  }): string[] {
    const warnings: string[] = [];

    if (input.expiryDate) {
      const expiryKey = dateKeyFromCalendarDate(input.expiryDate);
      if (expiryKey <= input.todayKey) {
        warnings.push('This batch is already expired and cannot be sold.');
      }
    }

    const cost = input.row.unitCost;
    const price = input.row.sellingPrice;
    if (typeof cost === 'number' && typeof price === 'number' && price > 0 && price < cost) {
      warnings.push('The selling price is below the purchase price.');
    }

    return warnings;
  }

  private parseExpiry(value?: string): Date | null {
    if (!value) return null;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || dateKeyFromCalendarDate(parsed) !== value) {
      throw new BadRequestException('The expiry date is not a real calendar date.');
    }
    return parsed;
  }

  private describeError(error: unknown): string {
    if (error && typeof error === 'object') {
      const response = (error as { response?: { message?: string | string[] } }).response;
      if (response?.message) {
        return Array.isArray(response.message) ? response.message.join(' ') : response.message;
      }
      const message = (error as { message?: string }).message;
      if (message) return message;
    }
    return 'This row could not be saved.';
  }
}

type PrismaTransaction = Prisma.TransactionClient;

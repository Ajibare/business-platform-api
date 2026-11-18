import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { CreateBatchDto } from './dto/create-batch.dto';
import { ListBatchesDto } from './dto/list-batches.dto';

export interface BatchRecord {
  id: string;
  organizationId: string;
  branchId: string;
  productId: string;
  medicineName: string;
  batchNumber: string | null;
  expiryDate: Date | null;
  unit: string;
  unitCost: number | null;
  sellingPrice: number | null;
  balanceQuantity: number;
  version: number;
}

@Injectable()
export class BatchesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Opening stock for one medicine in one branch. */
  async create(
    organizationId: string,
    branchId: string,
    actorId: string,
    dto: CreateBatchDto,
  ): Promise<BatchRecord> {
    const medicine = await this.prisma.product.findFirst({
      where: { id: dto.medicineId, organizationId },
    });
    if (!medicine) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Medicine not found' });
    }

    const existingMovement = await this.prisma.stockMovement.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: dto.idempotencyKey } },
    });
    if (existingMovement) {
      // A replay must resolve to the same branch's batch. If the key was used
      // elsewhere the caller sent a stale key, which is a conflict, not a match.
      if (existingMovement.branchId !== branchId) {
        throw new ConflictException({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'That request has already been used for another branch. Reload and try again.',
        });
      }

      const existingBatch = await this.prisma.batch.findUnique({
        where: { id: existingMovement.batchId },
        include: { product: { select: { name: true } }, balance: true },
      });
      if (!existingBatch) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Batch not found' });
      }

      return {
        id: existingBatch.id,
        organizationId: existingBatch.organizationId,
        branchId: existingBatch.branchId,
        productId: existingBatch.productId,
        medicineName: existingBatch.product?.name ?? '',
        batchNumber: existingBatch.batchNumber,
        expiryDate: existingBatch.expiryDate,
        unit: existingBatch.unit,
        unitCost: existingBatch.unitCost !== null ? this.toQuantity(existingBatch.unitCost) : null,
        sellingPrice:
          existingBatch.sellingPrice !== null ? this.toQuantity(existingBatch.sellingPrice) : null,
        balanceQuantity: existingBatch.balance
          ? this.toQuantity(existingBatch.balance.quantity)
          : 0,
        version: existingBatch.balance ? existingBatch.balance.version : 0,
      };
    }

    const batch = await this.prisma.batch.create({
      data: {
        organizationId,
        branchId,
        productId: medicine.id,
        batchNumber: dto.batchNumber ?? null,
        expiryDate: dto.expiryDate ? new Date(dto.expiryDate) : null,
        unit: dto.unit ?? medicine.unit,
        unitCost: dto.unitCost ?? null,
        sellingPrice: dto.sellingPrice ?? null,
      },
    });

    await this.prisma.stockMovement.create({
      data: {
        organizationId,
        branchId,
        batchId: batch.id,
        type: 'OPENING',
        quantityDelta: dto.quantity,
        reason: 'Opening stock',
        actorId,
        idempotencyKey: dto.idempotencyKey,
      },
    });

    const balance = await this.prisma.batchBalance.upsert({
      where: { batchId: batch.id },
      create: {
        organizationId,
        batchId: batch.id,
        quantity: dto.quantity,
        version: 1,
      },
      update: {
        quantity: dto.quantity,
        version: { increment: 1 },
      },
    });

    return {
      id: batch.id,
      organizationId: batch.organizationId,
      branchId: batch.branchId,
      productId: batch.productId,
      medicineName: medicine.name,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      unit: batch.unit,
      unitCost: batch.unitCost !== null ? this.toQuantity(batch.unitCost) : null,
      sellingPrice: batch.sellingPrice !== null ? this.toQuantity(batch.sellingPrice) : null,
      balanceQuantity: this.toQuantity(balance.quantity),
      version: balance.version,
    };
  }

  async findAll(organizationId: string, branchIds: string[], query: ListBatchesDto) {
    const batches = await this.prisma.batch.findMany({
      where: {
        organizationId,
        branchId: { in: branchIds },
        ...(query.medicineId ? { productId: query.medicineId } : {}),
      },
      include: {
        product: { select: { name: true } },
        balance: { select: { quantity: true, version: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return { data: batches.map((batch) => this.toRecord(batch)) };
  }

  async findOne(organizationId: string, branchIds: string[], id: string): Promise<BatchRecord> {
    const batch = await this.prisma.batch.findFirst({
      where: { id, organizationId, branchId: { in: branchIds } },
      include: {
        product: { select: { name: true } },
        balance: { select: { quantity: true, version: true } },
      },
    });
    if (!batch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Batch not found' });
    }
    return this.toRecord(batch);
  }

  private toRecord(batch: {
    id: string;
    organizationId: string;
    branchId: string;
    productId: string;
    batchNumber: string | null;
    expiryDate: Date | null;
    unit: string;
    unitCost: unknown;
    sellingPrice: unknown;
    product?: { name: string } | null;
    balance?: { quantity: unknown; version: number } | null;
  }): BatchRecord {
    return {
      id: batch.id,
      organizationId: batch.organizationId,
      branchId: batch.branchId,
      productId: batch.productId,
      medicineName: batch.product?.name ?? '',
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      unit: batch.unit,
      unitCost: batch.unitCost !== null ? this.toQuantity(batch.unitCost) : null,
      sellingPrice: batch.sellingPrice !== null ? this.toQuantity(batch.sellingPrice) : null,
      balanceQuantity: batch.balance ? this.toQuantity(batch.balance.quantity) : 0,
      version: batch.balance ? batch.balance.version : 0,
    };
  }

  private toQuantity(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
  }
}

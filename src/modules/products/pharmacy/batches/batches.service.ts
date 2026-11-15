import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { CreateBatchDto } from './dto/create-batch.dto';
import { ListBatchesDto } from './dto/list-batches.dto';

export interface BatchRecord {
  id: string;
  organizationId: string;
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

  async create(organizationId: string, actorId: string, dto: CreateBatchDto): Promise<BatchRecord> {
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
      const existingBatch = await this.prisma.batch.findUnique({
        where: { id: existingMovement.batchId },
      });
      if (!existingBatch) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Batch not found' });
      }
      const existingBalance = await this.prisma.batchBalance.findUnique({
        where: { batchId: existingBatch.id },
      });
      return {
        id: existingBatch.id,
        organizationId: existingBatch.organizationId,
        productId: existingBatch.productId,
        medicineName: medicine.name,
        batchNumber: existingBatch.batchNumber,
        expiryDate: existingBatch.expiryDate,
        unit: existingBatch.unit,
        unitCost: existingBatch.unitCost !== null ? this.toQuantity(existingBatch.unitCost) : null,
        sellingPrice: existingBatch.sellingPrice !== null ? this.toQuantity(existingBatch.sellingPrice) : null,
        balanceQuantity: existingBalance ? this.toQuantity(existingBalance.quantity) : 0,
        version: existingBalance ? existingBalance.version : 0,
      };
    }

    const batch = await this.prisma.batch.create({
      data: {
        organizationId,
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

  async findAll(organizationId: string, query: ListBatchesDto) {
    const medicine = query.medicineId
      ? await this.prisma.product.findFirst({
          where: { id: query.medicineId, organizationId },
        })
      : null;

    const batches = await this.prisma.batch.findMany({
      where: {
        organizationId,
        ...(medicine ? { productId: medicine.id } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    const items: BatchRecord[] = [];
    for (const batch of batches) {
      const medicineItem = await this.prisma.product.findFirst({
        where: { id: batch.productId, organizationId },
      });
      const balance = await this.prisma.batchBalance.findFirst({
        where: { organizationId, batchId: batch.id },
      });
      items.push({
        id: batch.id,
        organizationId: batch.organizationId,
        productId: batch.productId,
        medicineName: medicineItem?.name ?? '',
        batchNumber: batch.batchNumber,
        expiryDate: batch.expiryDate,
        unit: batch.unit,
        unitCost: batch.unitCost !== null ? this.toQuantity(batch.unitCost) : null,
        sellingPrice: batch.sellingPrice !== null ? this.toQuantity(batch.sellingPrice) : null,
        balanceQuantity: balance ? this.toQuantity(balance.quantity) : 0,
        version: balance ? balance.version : 0,
      });
    }

    return { data: items };
  }

  async findOne(organizationId: string, id: string): Promise<BatchRecord> {
    const batch = await this.prisma.batch.findFirst({ where: { id, organizationId } });
    if (!batch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Batch not found' });
    }
    const medicine = await this.prisma.product.findFirst({
      where: { id: batch.productId, organizationId },
    });
    const balance = await this.prisma.batchBalance.findFirst({
      where: { organizationId, batchId: batch.id },
    });

    return {
      id: batch.id,
      organizationId: batch.organizationId,
      productId: batch.productId,
      medicineName: medicine?.name ?? '',
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      unit: batch.unit,
      unitCost: batch.unitCost !== null ? this.toQuantity(batch.unitCost) : null,
      sellingPrice: batch.sellingPrice !== null ? this.toQuantity(batch.sellingPrice) : null,
      balanceQuantity: balance ? this.toQuantity(balance.quantity) : 0,
      version: balance ? balance.version : 0,
    };
  }

  private toQuantity(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
  }
}

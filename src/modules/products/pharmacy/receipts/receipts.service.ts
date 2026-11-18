import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { CreateReceiptDto } from './dto/create-receipt.dto';

export interface ReceiptLineRecord {
  id: string;
  receiptId: string;
  productId: string;
  batchNumber: string | null;
  expiryDate: Date | null;
  unitCost: number | null;
  sellingPrice: number | null;
  quantity: number;
}

export interface ReceiptRecord {
  id: string;
  organizationId: string;
  branchId: string;
  supplierId: string | null;
  externalReference: string | null;
  status: string;
  receivedAt: Date;
  actorId: string | null;
  lines: ReceiptLineRecord[];
}

@Injectable()
export class ReceiptsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Stock is received into one branch; that branch owns the batches it creates. */
  async create(
    organizationId: string,
    branchId: string,
    actorId: string,
    dto: CreateReceiptDto,
  ): Promise<ReceiptRecord> {
    for (const line of dto.lines) {
      const product = await this.prisma.product.findFirst({
        where: { id: line.productId, organizationId },
      });
      if (!product) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: `Medicine ${line.productId} not found`,
        });
      }
    }

    if (dto.supplierId) {
      const supplier = await this.prisma.supplier.findFirst({
        where: { id: dto.supplierId, organizationId },
      });
      if (!supplier) {
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Supplier not found' });
      }
    }

    const receipt = await this.prisma.stockReceipt.create({
      data: {
        organizationId,
        branchId,
        supplierId: dto.supplierId ?? null,
        externalReference: dto.externalReference ?? null,
        status: 'DRAFT',
        receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : new Date(),
        actorId,
        lines: {
          create: dto.lines.map((line) => ({
            productId: line.productId,
            batchNumber: line.batchNumber ?? null,
            expiryDate: line.expiryDate ? new Date(line.expiryDate) : null,
            unitCost: line.unitCost ?? null,
            sellingPrice: line.sellingPrice ?? null,
            quantity: line.quantity,
          })),
        },
      },
      include: { lines: true },
    });

    return this.toRecord(receipt as never, organizationId);
  }

  async confirm(
    organizationId: string,
    branchIds: string[],
    id: string,
    actorId: string,
  ): Promise<ReceiptRecord> {
    const receipt = await this.prisma.stockReceipt.findFirst({
      where: { id, organizationId, branchId: { in: branchIds } },
      include: { lines: true },
    });
    if (!receipt) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Receipt not found' });
    }
    if (receipt.status !== 'DRAFT') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Only draft receipts can be confirmed.',
      });
    }

    const confirmed = await this.prisma.$transaction(async (tx) => {
      for (const line of receipt.lines) {
        const product = await tx.product.findFirst({
          where: { id: line.productId, organizationId },
        });
        if (!product) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: `Medicine ${line.productId} not found`,
          });
        }

        const batch = await tx.batch.create({
          data: {
            organizationId,
            branchId: receipt.branchId,
            productId: line.productId,
            batchNumber: line.batchNumber ?? null,
            expiryDate: line.expiryDate ?? null,
            unit: product.unit,
            unitCost: line.unitCost ?? null,
            sellingPrice: line.sellingPrice ?? null,
          },
        });

        await tx.stockMovement.create({
          data: {
            organizationId,
            branchId: receipt.branchId,
            batchId: batch.id,
            type: 'RECEIPT',
            quantityDelta: this.toQuantity(line.quantity),
            reason: 'Supplier receipt',
            actorId,
            idempotencyKey: `receipt-${receipt.id}-${line.id}`,
            occurredAt: receipt.receivedAt,
          },
        });

        const balance = await tx.batchBalance.findFirst({
          where: { organizationId, batchId: batch.id },
        });
        const newQuantity = (balance ? this.toQuantity(balance.quantity) : 0) + this.toQuantity(line.quantity);
        await tx.batchBalance.upsert({
          where: { batchId: batch.id },
          create: { organizationId, batchId: batch.id, quantity: newQuantity, version: 1 },
          update: { quantity: newQuantity, version: { increment: 1 } },
        });
      }

      return tx.stockReceipt.update({
        where: { id: receipt.id },
        data: { status: 'CONFIRMED' },
        include: { lines: true },
      });
    });

    return this.toRecord(confirmed as never, organizationId);
  }

  private toRecord(receipt: never, _organizationId: string): ReceiptRecord {
    const record = receipt as unknown as {
      id: string;
      organizationId: string;
      branchId: string;
      supplierId: string | null;
      externalReference: string | null;
      status: string;
      receivedAt: Date;
      actorId: string | null;
      lines: ReceiptLineRecord[];
    };
    return {
      id: record.id,
      organizationId: record.organizationId,
      branchId: record.branchId,
      supplierId: record.supplierId,
      externalReference: record.externalReference,
      status: record.status,
      receivedAt: record.receivedAt,
      actorId: record.actorId,
      lines: (record.lines ?? []).map((line) => ({
        id: line.id,
        receiptId: line.receiptId,
        productId: line.productId,
        batchNumber: line.batchNumber,
        expiryDate: line.expiryDate,
        unitCost: line.unitCost ? this.toQuantity(line.unitCost) : null,
        sellingPrice: line.sellingPrice ? this.toQuantity(line.sellingPrice) : null,
        quantity: this.toQuantity(line.quantity),
      })),
    };
  }

  private toQuantity(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
  }
}

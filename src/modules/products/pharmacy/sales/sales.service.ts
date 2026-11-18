import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SaleStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../../database/prisma.service';
import { AuditService } from '../../../platform/audit/audit.service';
import { localDateKey, zonedDayRangeUtc } from '../../../../common/utils/time';
import { CreateSaleDto } from './dto/create-sale.dto';
import { CreateSaleReturnDto } from './dto/create-sale-return.dto';
import { ListSalesDto } from './dto/list-sales.dto';
import {
  FefoBatch,
  allocateFefo,
  planSaleLines,
  roundMoney,
  roundQuantity,
} from './fefo';

const SALE_INCLUDE = {
  lines: {
    include: {
      product: { select: { name: true, unit: true } },
      batch: { select: { batchNumber: true } },
    },
  },
} satisfies Prisma.SaleInclude;

type SaleWithLines = Prisma.SaleGetPayload<{ include: typeof SALE_INCLUDE }>;

export interface SaleLineRecord {
  id: string;
  productId: string;
  medicineName: string;
  batchId: string;
  batchNumber: string | null;
  quantity: number;
  returnedQuantity: number;
  unitPrice: number;
  discount: number;
  lineTotal: number;
  unitCost: number | null;
  costTotal: number | null;
}

export interface SaleRecord {
  id: string;
  organizationId: string;
  branchId: string;
  reference: string;
  status: string;
  occurredAt: Date;
  customerName: string | null;
  note: string | null;
  subtotal: number;
  discountTotal: number;
  refundTotal: number;
  revenue: number;
  netSales: number;
  costTotal: number | null;
  grossProfit: number | null;
  unitCount: number;
  voidedAt: Date | null;
  createdAt: Date;
  lines: SaleLineRecord[];
}

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Records a sale in one branch and deducts stock at batch level using FEFO.
   *
   * Only batches belonging to `branchId` are considered, so a sale can never
   * take stock from another location. The sale row, the balance decrements and
   * the ISSUE movements are written in one transaction. Decrements are
   * conditional (`quantity >= take`) so a concurrent sale can never drive a
   * batch negative, and the per-batch movement idempotency key means a retried
   * request cannot deduct twice.
   */
  async create(
    organizationId: string,
    branchId: string,
    actorId: string,
    dto: CreateSaleDto,
  ): Promise<{ data: SaleRecord }> {
    const idempotencyKey = dto.idempotencyKey?.trim() || `sale-${randomUUID()}`;
    const replay = await this.findByKey(organizationId, branchId, idempotencyKey);
    if (replay) return { data: this.toRecord(replay) };

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const timeZone = organization?.timezone ?? 'Africa/Lagos';
    const todayKey = localDateKey(new Date(), timeZone);
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();

    const productIds = [...new Set(dto.items.map((item) => item.productId))];
    const products = await this.prisma.product.findMany({
      where: { organizationId, id: { in: productIds } },
      select: { id: true, name: true, unit: true },
    });
    const productById = new Map(products.map((product) => [product.id, product]));
    const missing = productIds.filter((id) => !productById.has(id));
    if (missing.length > 0) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: `Medicine not found in this pharmacy: ${missing.join(', ')}.`,
      });
    }

    const batches = await this.prisma.batch.findMany({
      where: { organizationId, branchId, productId: { in: productIds } },
      select: {
        id: true,
        productId: true,
        expiryDate: true,
        unitCost: true,
        sellingPrice: true,
        balance: { select: { quantity: true } },
      },
      orderBy: [{ expiryDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
    });

    const batchesByProduct = new Map<string, FefoBatch[]>();
    for (const batch of batches) {
      const entry: FefoBatch = {
        batchId: batch.id,
        expiryDate: batch.expiryDate,
        quantity: this.toNumber(batch.balance?.quantity),
        unitCost: this.toNullableNumber(batch.unitCost),
        sellingPrice: this.toNullableNumber(batch.sellingPrice),
      };
      const current = batchesByProduct.get(batch.productId) ?? [];
      current.push(entry);
      batchesByProduct.set(batch.productId, current);
    }

    const lines: Array<{
      productId: string;
      batchId: string;
      quantity: number;
      unitPrice: number;
      discount: number;
      lineTotal: number;
      unitCost: number | null;
      costTotal: number | null;
    }> = [];
    const stockDeductions = new Map<string, number>();
    let subtotal = 0;
    let discountTotal = 0;
    let revenue = 0;
    let unitCount = 0;
    let costsComplete = true;

    for (const item of dto.items) {
      const product = productById.get(item.productId)!;
      const requested = roundQuantity(item.quantity);
      const allocation = allocateFefo(
        batchesByProduct.get(item.productId) ?? [],
        requested,
        todayKey,
      );

      if (allocation.shortage > 0) {
        throw new ConflictException({
          code: 'INSUFFICIENT_STOCK',
          message: `${product.name} has ${allocation.available} ${product.unit} available in unexpired batches. Requested ${requested}.`,
          details: {
            productId: product.id,
            requested,
            available: allocation.available,
            shortage: allocation.shortage,
          },
        });
      }

      const plan = planSaleLines({
        allocations: allocation.allocations,
        unitPrice: item.unitPrice ?? null,
        discount: item.discount ?? 0,
      });

      for (const line of plan.lines) {
        lines.push({ productId: product.id, ...line });
        stockDeductions.set(
          line.batchId,
          roundQuantity((stockDeductions.get(line.batchId) ?? 0) + line.quantity),
        );
      }

      subtotal = roundMoney(subtotal + plan.totals.subtotal);
      discountTotal = roundMoney(discountTotal + plan.totals.discountTotal);
      revenue = roundMoney(revenue + plan.totals.revenue);
      unitCount = roundQuantity(unitCount + plan.totals.unitCount);
      if (plan.totals.costTotal === null) costsComplete = false;
    }

    const costTotal = costsComplete
      ? roundMoney(lines.reduce((total, line) => total + (line.costTotal ?? 0), 0))
      : null;
    const grossProfit = costTotal === null ? null : roundMoney(revenue - costTotal);
    const reference = `SALE-${todayKey.replace(/-/g, '')}-${randomUUID()
      .slice(0, 6)
      .toUpperCase()}`;

    try {
      const sale = await this.prisma.$transaction(
        async (tx) => {
          const created = await tx.sale.create({
            data: {
              organizationId,
              branchId,
              reference,
              status: 'COMPLETED',
              occurredAt,
              actorId,
              customerName: dto.customerName?.trim() || null,
              note: dto.note?.trim() || null,
              idempotencyKey,
              subtotal,
              discountTotal,
              revenue,
              costTotal,
              grossProfit,
              unitCount,
              lines: {
                create: lines.map((line) => ({
                  productId: line.productId,
                  batchId: line.batchId,
                  quantity: line.quantity,
                  unitPrice: line.unitPrice,
                  discount: line.discount,
                  lineTotal: line.lineTotal,
                  unitCost: line.unitCost,
                  costTotal: line.costTotal,
                })),
              },
            },
            include: SALE_INCLUDE,
          });

          for (const [batchId, quantity] of stockDeductions) {
            const decremented = await tx.batchBalance.updateMany({
              where: { organizationId, batchId, quantity: { gte: quantity } },
              data: { quantity: { decrement: quantity }, version: { increment: 1 } },
            });
            if (decremented.count !== 1) {
              throw new ConflictException({
                code: 'INSUFFICIENT_STOCK',
                message:
                  'Available stock changed while the sale was being recorded. Review the quantity and try again.',
              });
            }

            const balance = await tx.batchBalance.findUnique({
              where: { batchId },
              select: { quantity: true },
            });
            const newQuantity = this.toNumber(balance?.quantity);

            await tx.stockMovement.create({
              data: {
                organizationId,
                branchId,
                batchId,
                type: 'ISSUE',
                quantityDelta: -quantity,
                previousQuantity: roundQuantity(newQuantity + quantity),
                newQuantity,
                reason: 'Sale',
                actorId,
                idempotencyKey: `${idempotencyKey}:${batchId}`,
                occurredAt,
              },
            });
          }

          return created;
        },
        { timeout: 15_000 },
      );

      await this.auditService.record({
        organizationId,
        branchId,
        actorId,
        action: 'SALE_RECORDED',
        entityType: 'Sale',
        entityId: sale.id,
        metadata: { reference, revenue, unitCount, lines: lines.length },
      });

      return { data: this.toRecord(sale) };
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const existing = await this.findByKey(organizationId, branchId, idempotencyKey);
        if (existing) return { data: this.toRecord(existing) };
      }
      throw error;
    }
  }

  async findAll(organizationId: string, branchIds: string[], query: ListSalesDto) {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    const where: Prisma.SaleWhereInput = { organizationId, branchId: { in: branchIds } };
    if (query.status && (query.status === 'COMPLETED' || query.status === 'VOIDED')) {
      where.status = query.status as SaleStatus;
    }

    if (query.from || query.to) {
      const organization = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { timezone: true },
      });
      const timeZone = organization?.timezone ?? 'Africa/Lagos';
      const first = query.from ?? query.to!;
      const last = query.to ?? query.from!;
      where.occurredAt = {
        gte: zonedDayRangeUtc(first, timeZone).start,
        lt: zonedDayRangeUtc(last, timeZone).end,
      };
    }

    const [sales, total] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        include: SALE_INCLUDE,
        orderBy: { occurredAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.sale.count({ where }),
    ]);

    return {
      data: sales.map((sale) => this.toRecord(sale)),
      meta: { total, limit, offset },
    };
  }

  async findOne(organizationId: string, branchIds: string[], id: string): Promise<{ data: SaleRecord }> {
    const sale = await this.prisma.sale.findFirst({
      where: { id, organizationId, branchId: { in: branchIds } },
      include: SALE_INCLUDE,
    });
    if (!sale) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found' });
    }
    return { data: this.toRecord(sale) };
  }

  /**
   * Voids a sale and reverses every ISSUE movement it created. The sale stays
   * in the history with status VOIDED and is excluded from revenue totals.
   */
  async void(
    organizationId: string,
    branchIds: string[],
    actorId: string,
    id: string,
  ): Promise<{ data: SaleRecord }> {
    const sale = await this.prisma.sale.findFirst({
      where: { id, organizationId, branchId: { in: branchIds } },
      include: SALE_INCLUDE,
    });
    if (!sale) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found' });
    }
    if (sale.status === 'VOIDED') {
      return { data: this.toRecord(sale) };
    }
    if (this.toNumber(sale.refundTotal) > 0) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'This sale has refunds recorded against it and cannot be voided.',
      });
    }

    const restock = new Map<string, number>();
    for (const line of sale.lines) {
      restock.set(
        line.batchId,
        roundQuantity((restock.get(line.batchId) ?? 0) + this.toNumber(line.quantity)),
      );
    }

    const voided = await this.prisma.$transaction(
      async (tx) => {
        for (const [batchId, quantity] of restock) {
          await tx.batchBalance.updateMany({
            where: { organizationId, batchId },
            data: { quantity: { increment: quantity }, version: { increment: 1 } },
          });

          const balance = await tx.batchBalance.findUnique({
            where: { batchId },
            select: { quantity: true },
          });
          const newQuantity = this.toNumber(balance?.quantity);

          await tx.stockMovement.create({
            data: {
              organizationId,
              branchId: sale.branchId,
              batchId,
              type: 'REVERSAL',
              quantityDelta: quantity,
              previousQuantity: roundQuantity(newQuantity - quantity),
              newQuantity,
              reason: `Sale ${sale.reference} voided`,
              actorId,
              idempotencyKey: `sale-void:${sale.id}:${batchId}`,
            },
          });
        }

        return tx.sale.update({
          where: { id: sale.id },
          data: { status: 'VOIDED', voidedAt: new Date(), voidedById: actorId },
          include: SALE_INCLUDE,
        });
      },
      { timeout: 15_000 },
    );

    await this.auditService.record({
      organizationId,
      branchId: sale.branchId,
      actorId,
      action: 'SALE_VOIDED',
      entityType: 'Sale',
      entityId: sale.id,
      metadata: { reference: sale.reference, revenue: this.toNumber(sale.revenue) },
    });

    return { data: this.toRecord(voided) };
  }

  /**
   * Records a customer return against a completed sale. Stock goes back to the
   * batch it was sold from, the refund is tracked separately from revenue, and
   * the line cannot be returned beyond the quantity originally sold.
   */
  async recordReturn(
    organizationId: string,
    branchIds: string[],
    actorId: string,
    saleId: string,
    dto: CreateSaleReturnDto,
  ): Promise<{ data: SaleRecord }> {
    const idempotencyKey = dto.idempotencyKey?.trim() || `sale-return-${randomUUID()}`;
    const replay = await this.prisma.saleReturn.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
      select: { saleId: true },
    });
    if (replay) {
      return this.findOne(organizationId, branchIds, replay.saleId);
    }

    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, organizationId, branchId: { in: branchIds } },
      include: SALE_INCLUDE,
    });
    if (!sale) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Sale not found' });
    }
    if (sale.status !== 'COMPLETED') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Voided sales cannot accept returns.',
      });
    }

    const lineById = new Map(sale.lines.map((line) => [line.id, line]));
    const occurredAt = dto.occurredAt ? new Date(dto.occurredAt) : new Date();

    const planned = dto.items.map((item) => {
      const line = lineById.get(item.saleLineId);
      if (!line) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: `Sale line ${item.saleLineId} does not belong to this sale.`,
        });
      }
      const quantity = roundQuantity(item.quantity);
      const remaining = roundQuantity(
        this.toNumber(line.quantity) - this.toNumber(line.returnedQuantity),
      );
      if (quantity > remaining) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: `Only ${remaining} unit(s) remain returnable on this line.`,
        });
      }
      const unitRefund = this.toNumber(line.quantity) > 0
        ? this.toNumber(line.lineTotal) / this.toNumber(line.quantity)
        : 0;
      return {
        line,
        quantity,
        amount: roundMoney(unitRefund * quantity),
      };
    });

    const amount = roundMoney(planned.reduce((total, item) => total + item.amount, 0));
    const quantity = roundQuantity(planned.reduce((total, item) => total + item.quantity, 0));

    const restock = new Map<string, number>();
    for (const item of planned) {
      restock.set(
        item.line.batchId,
        roundQuantity((restock.get(item.line.batchId) ?? 0) + item.quantity),
      );
    }

    try {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.saleReturn.create({
            data: {
              organizationId,
              saleId: sale.id,
              amount,
              quantity,
              reason: dto.reason?.trim() || null,
              actorId,
              idempotencyKey,
              occurredAt,
              lines: {
                create: planned.map((item) => ({
                  saleLineId: item.line.id,
                  quantity: item.quantity,
                  amount: item.amount,
                })),
              },
            },
          });

          for (const [batchId, restockQuantity] of restock) {
            await tx.batchBalance.updateMany({
              where: { organizationId, batchId },
              data: { quantity: { increment: restockQuantity }, version: { increment: 1 } },
            });

            const balance = await tx.batchBalance.findUnique({
              where: { batchId },
              select: { quantity: true },
            });
            const newQuantity = this.toNumber(balance?.quantity);

            await tx.stockMovement.create({
              data: {
                organizationId,
                branchId: sale.branchId,
                batchId,
                type: 'CUSTOMER_RETURN',
                quantityDelta: restockQuantity,
                previousQuantity: roundQuantity(newQuantity - restockQuantity),
                newQuantity,
                reason: dto.reason?.trim() || `Return against sale ${sale.reference}`,
                actorId,
                idempotencyKey: `${idempotencyKey}:${batchId}`,
                occurredAt,
              },
            });
          }

          for (const item of planned) {
            await tx.saleLine.update({
              where: { id: item.line.id },
              data: { returnedQuantity: { increment: item.quantity } },
            });
          }

          const updated = await tx.sale.update({
            where: { id: sale.id },
            data: { refundTotal: { increment: amount } },
            select: { revenue: true, refundTotal: true, costTotal: true },
          });

          const grossProfit = updated.costTotal === null
            ? null
            : roundMoney(
                this.toNumber(updated.revenue) -
                  this.toNumber(updated.refundTotal) -
                  this.toNumber(updated.costTotal),
              );

          await tx.sale.update({ where: { id: sale.id }, data: { grossProfit } });
        },
        { timeout: 15_000 },
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        return this.findOne(organizationId, branchIds, sale.id);
      }
      throw error;
    }

    await this.auditService.record({
      organizationId,
      branchId: sale.branchId,
      actorId,
      action: 'SALE_RETURN_RECORDED',
      entityType: 'Sale',
      entityId: sale.id,
      metadata: { reference: sale.reference, amount, quantity },
    });

    return this.findOne(organizationId, branchIds, sale.id);
  }

  /**
   * A replay is only honoured inside the same branch. The idempotency key is
   * unique per organisation, so the branch is checked explicitly rather than
   * letting a key from one location replay another location's sale.
   */
  private async findByKey(
    organizationId: string,
    branchId: string,
    idempotencyKey: string,
  ) {
    const sale = await this.prisma.sale.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
      include: SALE_INCLUDE,
    });
    return sale && sale.branchId === branchId ? sale : null;
  }

  private toRecord(sale: SaleWithLines): SaleRecord {
    const revenue = this.toNumber(sale.revenue);
    const refundTotal = this.toNumber(sale.refundTotal);
    return {
      id: sale.id,
      organizationId: sale.organizationId,
      branchId: sale.branchId,
      reference: sale.reference,
      status: sale.status,
      occurredAt: sale.occurredAt,
      customerName: sale.customerName,
      note: sale.note,
      subtotal: this.toNumber(sale.subtotal),
      discountTotal: this.toNumber(sale.discountTotal),
      refundTotal,
      revenue,
      netSales: roundMoney(revenue - refundTotal),
      costTotal: this.toNullableNumber(sale.costTotal),
      grossProfit: this.toNullableNumber(sale.grossProfit),
      unitCount: this.toNumber(sale.unitCount),
      voidedAt: sale.voidedAt,
      createdAt: sale.createdAt,
      lines: sale.lines.map((line) => ({
        id: line.id,
        productId: line.productId,
        medicineName: line.product.name,
        batchId: line.batchId,
        batchNumber: line.batch.batchNumber,
        quantity: this.toNumber(line.quantity),
        returnedQuantity: this.toNumber(line.returnedQuantity),
        unitPrice: this.toNumber(line.unitPrice),
        discount: this.toNumber(line.discount),
        lineTotal: this.toNumber(line.lineTotal),
        unitCost: this.toNullableNumber(line.unitCost),
        costTotal: this.toNullableNumber(line.costTotal),
      })),
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
  }

  private toNullableNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    return this.toNumber(value);
  }
}
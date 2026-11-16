import { Injectable, NotFoundException, BadRequestException, HttpException } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { dateKeyFromCalendarDate, localDateKey } from '../../../../common/utils/time';
import { CreateMovementDto } from './dto/create-movement.dto';
import { ListMovementsDto } from './dto/list-movements.dto';
import { ListStockDto } from './dto/list-stock.dto';

export interface StockOnHandRecord {
  productId: string;
  name: string;
  unit: string;
  /** Quantity the sale engine can sell: unexpired batches only. */
  sellableQuantity: number;
  /** Quantity sitting in batches that have already expired. */
  expiredQuantity: number;
  totalQuantity: number;
  batchCount: number;
  nearestExpiryDate: string | null;
  /** Selling price of the batch that will be picked first by FEFO. */
  sellingPrice: number | null;
}

export interface MovementRecord {
  id: string;
  organizationId: string;
  batchId: string;
  type: string;
  quantityDelta: number;
  reason: string | null;
  actorId: string | null;
  idempotencyKey: string;
  reversalOfId: string | null;
  occurredAt: Date;
  balanceQuantity: number;
  version: number;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, actorId: string, dto: CreateMovementDto): Promise<MovementRecord> {
    const batch = await this.prisma.batch.findFirst({ where: { id: dto.batchId, organizationId } });
    if (!batch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Batch not found' });
    }

    const existing = await this.prisma.stockMovement.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: dto.idempotencyKey } },
    });
    if (existing) {
      const balance = await this.prisma.batchBalance.findFirst({
        where: { organizationId, batchId: batch.id },
      });
      return {
        id: existing.id,
        organizationId: existing.organizationId,
        batchId: existing.batchId,
        type: existing.type,
        quantityDelta: this.toQuantity(existing.quantityDelta),
        reason: existing.reason,
        actorId: existing.actorId,
        idempotencyKey: existing.idempotencyKey,
        reversalOfId: existing.reversalOfId,
        occurredAt: existing.occurredAt,
        balanceQuantity: balance ? this.toQuantity(balance.quantity) : 0,
        version: balance ? balance.version : 0,
      };
    }

    const original = dto.type === 'REVERSAL' && dto.reversalOfId
      ? await this.prisma.stockMovement.findFirst({
          where: { id: dto.reversalOfId, organizationId },
        })
      : null;

    let quantityDelta = dto.quantityDelta;
    if (dto.type === 'REVERSAL' && original) {
      quantityDelta = -this.toQuantity(original.quantityDelta);
    }

    if (dto.type === 'ADJUSTMENT' && !dto.reason) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Adjustment movements require a reason.',
      });
    }

    const balance = await this.prisma.batchBalance.findFirst({
      where: { organizationId, batchId: batch.id },
    });
    const currentQuantity = balance ? this.toQuantity(balance.quantity) : 0;
    const newQuantity = currentQuantity + quantityDelta;
    if (newQuantity < 0) {
      throw new HttpException(
        { code: 'INSUFFICIENT_STOCK', message: 'Insufficient stock to complete this movement.' },
        409,
      );
    }

    const movement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.stockMovement.create({
        data: {
          organizationId,
          batchId: batch.id,
          type: dto.type,
          quantityDelta,
          reason: dto.reason ?? null,
          actorId,
          idempotencyKey: dto.idempotencyKey,
          reversalOfId: dto.reversalOfId ?? null,
          occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
        },
      });

      const updatedBalance = await tx.batchBalance.upsert({
        where: { batchId: batch.id },
        create: {
          organizationId,
          batchId: batch.id,
          quantity: newQuantity,
          version: 1,
        },
        update: {
          quantity: newQuantity,
          version: { increment: 1 },
        },
      });

      return { movement: created, balance: updatedBalance };
    });

    const balanceRecord = await this.prisma.batchBalance.findFirst({
      where: { organizationId, batchId: batch.id },
    });

    return {
      id: movement.movement.id,
      organizationId: movement.movement.organizationId,
      batchId: movement.movement.batchId,
      type: movement.movement.type,
      quantityDelta: this.toQuantity(movement.movement.quantityDelta),
      reason: movement.movement.reason,
      actorId: movement.movement.actorId,
      idempotencyKey: movement.movement.idempotencyKey,
      reversalOfId: movement.movement.reversalOfId,
      occurredAt: movement.movement.occurredAt,
      balanceQuantity: balanceRecord ? this.toQuantity(balanceRecord.quantity) : newQuantity,
      version: balanceRecord ? balanceRecord.version : 1,
    };
  }

  /**
   * Sellable stock per medicine, used by the sales screen. Quantities come from
   * batch balances so the number shown is the number FEFO would actually pick.
   */
  async stockOnHand(
    organizationId: string,
    query: ListStockDto = {},
  ): Promise<{ data: StockOnHandRecord[] }> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const timeZone = organization?.timezone ?? 'Africa/Lagos';
    const todayKey = localDateKey(new Date(), timeZone);
    const search = query.search?.trim();

    const products = await this.prisma.product.findMany({
      where: {
        organizationId,
        active: true,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { genericName: { contains: search, mode: 'insensitive' as const } },
                { brand: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      select: { id: true, name: true, unit: true },
      orderBy: { name: 'asc' },
      take: query.limit ?? 100,
    });
    if (products.length === 0) return { data: [] };

    const balances = await this.prisma.batchBalance.findMany({
      where: {
        organizationId,
        quantity: { gt: 0 },
        batch: { productId: { in: products.map((product) => product.id) } },
      },
      select: {
        quantity: true,
        batch: { select: { productId: true, expiryDate: true, sellingPrice: true } },
      },
    });

    const byProduct = new Map<string, StockOnHandRecord>();
    for (const product of products) {
      byProduct.set(product.id, {
        productId: product.id,
        name: product.name,
        unit: product.unit,
        sellableQuantity: 0,
        expiredQuantity: 0,
        totalQuantity: 0,
        batchCount: 0,
        nearestExpiryDate: null,
        sellingPrice: null,
      });
    }

    for (const balance of balances) {
      const entry = byProduct.get(balance.batch.productId);
      if (!entry) continue;
      const quantity = this.toQuantity(balance.quantity);
      const expiryKey = balance.batch.expiryDate
        ? dateKeyFromCalendarDate(balance.batch.expiryDate)
        : null;
      const expired = expiryKey !== null && expiryKey < todayKey;

      entry.totalQuantity += quantity;
      entry.batchCount += 1;
      if (expired) {
        entry.expiredQuantity += quantity;
        continue;
      }

      entry.sellableQuantity += quantity;
      // FEFO picks the earliest expiry first, so that batch sets the price and date shown.
      if (expiryKey !== null && (entry.nearestExpiryDate === null || expiryKey < entry.nearestExpiryDate)) {
        entry.nearestExpiryDate = expiryKey;
        entry.sellingPrice =
          balance.batch.sellingPrice !== null ? this.toQuantity(balance.batch.sellingPrice) : null;
      } else if (expiryKey === null && entry.nearestExpiryDate === null && entry.sellingPrice === null) {
        entry.sellingPrice =
          balance.batch.sellingPrice !== null ? this.toQuantity(balance.batch.sellingPrice) : null;
      }
    }

    return { data: [...byProduct.values()] };
  }

  async findAll(organizationId: string, query: ListMovementsDto) {
    const movements = await this.prisma.stockMovement.findMany({
      where: {
        organizationId,
        ...(query.batchId ? { batchId: query.batchId } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.from || query.to
          ? {
              occurredAt: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: 100,
    });

    const items = movements.map((movement) => ({
      id: movement.id,
      organizationId: movement.organizationId,
      batchId: movement.batchId,
      type: movement.type,
      quantityDelta: this.toQuantity(movement.quantityDelta),
      reason: movement.reason,
      actorId: movement.actorId,
      idempotencyKey: movement.idempotencyKey,
      reversalOfId: movement.reversalOfId,
      occurredAt: movement.occurredAt,
      balanceQuantity: 0,
      version: 0,
    }));

    return { data: items };
  }

  private toQuantity(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
  }
}

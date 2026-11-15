import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { CreateCountDto } from './dto/create-count.dto';
import { AddCountLineDto } from './dto/add-count-line.dto';

export interface StockCountLineRecord {
  id: string;
  countId: string;
  batchId: string | null;
  productId: string | null;
  recordedQuantity: number | null;
  countedQuantity: number;
  variance: number | null;
  note: string | null;
  versionAtCount: Date;
}

export interface StockCountRecord {
  id: string;
  organizationId: string;
  status: string;
  scope: string;
  startedAt: Date;
  closedAt: Date | null;
  counterId: string | null;
  approverId: string | null;
  lines: StockCountLineRecord[];
}

@Injectable()
export class CountsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, actorId: string, dto: CreateCountDto): Promise<StockCountRecord> {
    const count = await this.prisma.stockCount.create({
      data: {
        organizationId,
        status: 'DRAFT',
        scope: dto.scope,
        counterId: actorId,
        startedAt: new Date(),
      },
      include: { lines: true },
    });

    const batches = await this.prisma.batch.findMany({
      where: {
        organizationId,
        ...(dto.scope === 'TARGETED' && dto.productIds?.length
          ? { productId: { in: dto.productIds } }
          : {}),
      },
    });

    for (const batch of batches) {
      const balance = await this.prisma.batchBalance.findFirst({
        where: { organizationId, batchId: batch.id },
      });
      const recordedQuantity = balance ? this.toQuantity(balance.quantity) : 0;
      await this.prisma.stockCountLine.create({
        data: {
          countId: count.id,
          batchId: batch.id,
          productId: batch.productId,
          recordedQuantity,
          countedQuantity: 0,
          variance: -recordedQuantity,
          note: null,
        },
      });
    }

    const withLines = await this.prisma.stockCount.findUnique({
      where: { id: count.id },
      include: { lines: true },
    });

    return this.toRecord(withLines as never, organizationId);
  }

  async addLine(
    organizationId: string,
    countId: string,
    dto: AddCountLineDto,
  ): Promise<StockCountLineRecord> {
    const count = await this.prisma.stockCount.findFirst({ where: { id: countId, organizationId } });
    if (!count) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Stock count not found' });
    }
    if (count.status !== 'DRAFT') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Lines can only be added to a draft stock count.',
      });
    }

    const batch = dto.batchId
      ? await this.prisma.batch.findFirst({ where: { id: dto.batchId, organizationId } })
      : null;

    const existing = batch
      ? await this.prisma.stockCountLine.findFirst({ where: { countId, batchId: batch.id } })
      : null;

    const recordedQuantity = existing
      ? this.toQuantity(existing.recordedQuantity)
      : batch
        ? this.toQuantity(
            (await this.prisma.batchBalance.findFirst({ where: { organizationId, batchId: batch.id } }))
              ?.quantity ?? 0,
          )
        : 0;

    const variance = dto.countedQuantity - recordedQuantity;

    const line = existing
      ? await this.prisma.stockCountLine.update({
          where: { id: existing.id },
          data: { countedQuantity: dto.countedQuantity, variance, note: dto.note ?? null },
        })
      : await this.prisma.stockCountLine.create({
          data: {
            countId,
            batchId: batch?.id ?? null,
            productId: batch?.productId ?? null,
            recordedQuantity,
            countedQuantity: dto.countedQuantity,
            variance,
            note: dto.note ?? null,
          },
        });

    return {
      id: line.id,
      countId,
      batchId: line.batchId,
      productId: line.productId,
      recordedQuantity: line.recordedQuantity ? this.toQuantity(line.recordedQuantity) : null,
      countedQuantity: this.toQuantity(line.countedQuantity),
      variance: line.variance ? this.toQuantity(line.variance) : null,
      note: line.note,
      versionAtCount: line.versionAtCount,
    };
  }

  async submit(organizationId: string, id: string): Promise<StockCountRecord> {
    const count = await this.prisma.stockCount.findFirst({ where: { id, organizationId } });
    if (!count) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Stock count not found' });
    }
    if (count.status !== 'DRAFT') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Only draft stock counts can be submitted.',
      });
    }

    const updated = await this.prisma.stockCount.update({
      where: { id: count.id },
      data: { status: 'SUBMITTED' },
      include: { lines: true },
    });

    return this.toRecord(updated as never, organizationId);
  }

  async approve(organizationId: string, id: string, approverId: string): Promise<StockCountRecord> {
    const count = await this.prisma.stockCount.findFirst({
      where: { id, organizationId },
      include: { lines: true },
    });
    if (!count) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Stock count not found' });
    }
    if (count.status !== 'SUBMITTED') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Only submitted stock counts can be approved.',
      });
    }

    for (const line of count.lines) {
      const variance = line.variance ? this.toQuantity(line.variance) : 0;
      if (variance === 0) continue;

      await this.prisma.stockMovement.create({
        data: {
          organizationId,
          batchId: line.batchId as string,
          type: 'ADJUSTMENT',
          quantityDelta: variance,
          reason: 'Physical stock count adjustment',
          actorId: approverId,
          idempotencyKey: `count-${count.id}-${line.id}`,
        },
      });

      const batchBalance = await this.prisma.batchBalance.findFirst({
        where: { organizationId, batchId: line.batchId as string },
      });
      const newQuantity = (batchBalance ? this.toQuantity(batchBalance.quantity) : 0) + variance;
      await this.prisma.batchBalance.upsert({
        where: { batchId: line.batchId as string },
        create: { organizationId, batchId: line.batchId as string, quantity: newQuantity, version: 1 },
        update: { quantity: newQuantity, version: { increment: 1 } },
      });
    }

    const updated = await this.prisma.stockCount.update({
      where: { id: count.id },
      data: { status: 'APPROVED', closedAt: new Date(), approverId },
      include: { lines: true },
    });

    return this.toRecord(updated as never, organizationId);
  }

  private toRecord(count: never, _organizationId: string): StockCountRecord {
    const record = count as unknown as {
      id: string;
      organizationId: string;
      status: string;
      scope: string;
      startedAt: Date;
      closedAt: Date | null;
      counterId: string | null;
      approverId: string | null;
      lines: StockCountLineRecord[];
    };
    return {
      id: record.id,
      organizationId: record.organizationId,
      status: record.status,
      scope: record.scope,
      startedAt: record.startedAt,
      closedAt: record.closedAt,
      counterId: record.counterId,
      approverId: record.approverId,
      lines: (record.lines ?? []).map((line) => ({
        id: line.id,
        countId: line.countId,
        batchId: line.batchId,
        productId: line.productId,
        recordedQuantity: line.recordedQuantity ? this.toQuantity(line.recordedQuantity) : null,
        countedQuantity: this.toQuantity(line.countedQuantity),
        variance: line.variance ? this.toQuantity(line.variance) : null,
        note: line.note,
        versionAtCount: line.versionAtCount,
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

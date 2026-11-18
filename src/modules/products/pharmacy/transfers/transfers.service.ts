import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TransferStatus } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../../database/prisma.service';
import { AuditService } from '../../../platform/audit/audit.service';
import { BranchAccessService, type RequestActor } from '../../../platform/branches/branch-access.service';
import { CreateTransferDto } from './dto/create-transfer.dto';
import {
  ListTransfersDto,
  ReceiveTransferDto,
} from './dto/list-transfers.dto';

export interface TransferLineRecord {
  id: string;
  productId: string;
  productName: string;
  sourceBatchId: string;
  destinationBatchId: string | null;
  batchNumber: string | null;
  expiryDate: Date | null;
  unit: string;
  quantity: number;
  receivedQuantity: number;
  damagedQuantity: number;
}

export interface TransferRecord {
  id: string;
  reference: string;
  fromBranchId: string;
  fromBranchName: string;
  toBranchId: string;
  toBranchName: string;
  status: TransferStatus;
  note: string | null;
  requestedById: string | null;
  approvedById: string | null;
  dispatchedById: string | null;
  receivedById: string | null;
  rejectedById: string | null;
  rejectedReason: string | null;
  approvedAt: Date | null;
  dispatchedAt: Date | null;
  receivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lines: TransferLineRecord[];
}

const TRANSFER_INCLUDE = {
  fromBranch: { select: { name: true } },
  toBranch: { select: { name: true } },
  lines: {
    include: {
      product: { select: { name: true } },
      sourceBatch: { select: { batchNumber: true, expiryDate: true, unit: true } },
    },
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.StockTransferInclude;

type TransferWithRelations = Prisma.StockTransferGetPayload<{ include: typeof TRANSFER_INCLUDE }>;

/**
 * Inter-branch stock transfers.
 *
 * Stock leaves the source branch exactly once, at dispatch, and arrives at the
 * destination exactly once, at receipt. Every movement carries its own
 * idempotency key, so a retried request can never move the same units twice,
 * and each step runs in a transaction with the status change it belongs to.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
    private readonly auditService: AuditService,
  ) {}

  async findAll(
    actor: RequestActor,
    branchIds: string[],
    query: ListTransfersDto,
  ): Promise<{ data: TransferRecord[] }> {
    const direction = query.direction ?? 'all';
    const branchFilter =
      direction === 'in'
        ? { toBranchId: { in: branchIds } }
        : direction === 'out'
          ? { fromBranchId: { in: branchIds } }
          : { OR: [{ fromBranchId: { in: branchIds } }, { toBranchId: { in: branchIds } }] };

    const transfers = await this.prisma.stockTransfer.findMany({
      where: {
        organizationId: actor.organizationId,
        ...branchFilter,
        ...(query.status ? { status: query.status } : {}),
      },
      include: TRANSFER_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(query.limit ?? 50, 1), 200),
    });

    return { data: transfers.map((transfer) => this.toRecord(transfer)) };
  }

  async findOne(
    actor: RequestActor,
    branchIds: string[],
    id: string,
  ): Promise<{ data: TransferRecord }> {
    const transfer = await this.prisma.stockTransfer.findFirst({
      where: {
        id,
        organizationId: actor.organizationId,
        OR: [{ fromBranchId: { in: branchIds } }, { toBranchId: { in: branchIds } }],
      },
      include: TRANSFER_INCLUDE,
    });
    if (!transfer) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Transfer not found' });
    }
    return { data: this.toRecord(transfer) };
  }

  async create(actor: RequestActor, dto: CreateTransferDto): Promise<{ data: TransferRecord }> {
    const fromBranchId = dto.fromBranchId?.trim() || null;
    if (!fromBranchId) {
      throw new BadRequestException({
        code: 'BRANCH_REQUIRED',
        message: 'Choose the branch the stock is leaving from.',
      });
    }

    const [fromBranch, toBranch] = await Promise.all([
      this.prisma.branch.findFirst({ where: { id: fromBranchId, organizationId: actor.organizationId } }),
      this.prisma.branch.findFirst({ where: { id: dto.toBranchId, organizationId: actor.organizationId } }),
    ]);

    if (!fromBranch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Source branch not found' });
    }
    if (!toBranch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Destination branch not found' });
    }
    if (fromBranch.id === toBranch.id) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'The source and destination branches must be different.',
      });
    }
    if (fromBranch.status !== 'ACTIVE') {
      throw new BadRequestException({
        code: 'BRANCH_INACTIVE',
        message: 'The source branch is not active.',
      });
    }
    if (toBranch.status !== 'ACTIVE') {
      throw new BadRequestException({
        code: 'BRANCH_INACTIVE',
        message: 'The destination branch is not active.',
      });
    }

    // The caller must be allowed to take stock out of the source branch.
    await this.branchAccess.assertAccess(actor, fromBranchId);

    const batches = await this.prisma.batch.findMany({
      where: {
        organizationId: actor.organizationId,
        branchId: fromBranchId,
        id: { in: dto.lines.map((line) => line.sourceBatchId) },
      },
      include: { balance: { select: { quantity: true } } },
    });
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));

    for (const line of dto.lines) {
      const batch = batchById.get(line.sourceBatchId);
      if (!batch) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'A selected batch does not belong to the source branch.',
        });
      }
      const available = this.toQuantity(batch.balance?.quantity);
      if (available < line.quantity) {
        throw new BadRequestException({
          code: 'INSUFFICIENT_STOCK',
          message: `Only ${available} units are available in batch ${batch.batchNumber ?? batch.id}.`,
        });
      }
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: actor.organizationId },
      select: { requireTransferApproval: true },
    });

    const submit = dto.submit !== false;
    const status: TransferStatus = !submit
      ? TransferStatus.DRAFT
      : organization?.requireTransferApproval
        ? TransferStatus.PENDING_APPROVAL
        : TransferStatus.APPROVED;

    const transfer = await this.prisma.stockTransfer.create({
      data: {
        organizationId: actor.organizationId,
        reference: this.reference(),
        fromBranchId,
        toBranchId: toBranch.id,
        status,
        note: dto.note?.trim() || null,
        requestedById: actor.userId,
        approvedById: status === TransferStatus.APPROVED ? actor.userId : null,
        approvedAt: status === TransferStatus.APPROVED ? new Date() : null,
        lines: {
          create: dto.lines.map((line) => ({
            productId: batchById.get(line.sourceBatchId)!.productId,
            sourceBatchId: line.sourceBatchId,
            quantity: new Prisma.Decimal(line.quantity),
          })),
        },
      },
      include: TRANSFER_INCLUDE,
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      branchId: fromBranchId,
      actorId: actor.userId,
      action: 'TRANSFER_CREATED',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      metadata: {
        reference: transfer.reference,
        toBranchId: toBranch.id,
        status,
        lines: dto.lines.length,
      },
    });

    return { data: this.toRecord(transfer) };
  }

  /** Moves a draft into the approval flow. */
  async submit(actor: RequestActor, id: string): Promise<{ data: TransferRecord }> {
    const transfer = await this.requireTransfer(actor, id);

    if (transfer.status !== TransferStatus.DRAFT) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Only a draft transfer can be submitted.',
      });
    }
    if (transfer.requestedById && transfer.requestedById !== actor.userId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Only the person who drafted this transfer can submit it.',
      });
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: actor.organizationId },
      select: { requireTransferApproval: true },
    });
    const nextStatus = organization?.requireTransferApproval
      ? TransferStatus.PENDING_APPROVAL
      : TransferStatus.APPROVED;

    return this.transition(actor, id, nextStatus, {
      approvedById: nextStatus === TransferStatus.APPROVED ? actor.userId : null,
      approvedAt: nextStatus === TransferStatus.APPROVED ? new Date() : null,
    }, 'TRANSFER_SUBMITTED');
  }

  async approve(actor: RequestActor, id: string): Promise<{ data: TransferRecord }> {
    const transfer = await this.requireTransfer(actor, id);
    if (transfer.status !== TransferStatus.PENDING_APPROVAL) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Only a transfer waiting for approval can be approved.',
      });
    }
    if (transfer.requestedById === actor.userId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'A transfer must be approved by someone other than the requester.',
      });
    }

    return this.transition(
      actor,
      id,
      TransferStatus.APPROVED,
      { approvedById: actor.userId, approvedAt: new Date() },
      'TRANSFER_APPROVED',
    );
  }

  async reject(
    actor: RequestActor,
    id: string,
    reason: string,
  ): Promise<{ data: TransferRecord }> {
    const transfer = await this.requireTransfer(actor, id);
    if (transfer.status !== TransferStatus.PENDING_APPROVAL) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Only a transfer waiting for approval can be rejected.',
      });
    }

    return this.transition(
      actor,
      id,
      TransferStatus.REJECTED,
      { rejectedById: actor.userId, rejectedReason: reason.trim(), closedAt: new Date() },
      'TRANSFER_REJECTED',
    );
  }

  async cancel(actor: RequestActor, id: string): Promise<{ data: TransferRecord }> {
    const transfer = await this.requireTransfer(actor, id);
    const cancellable: TransferStatus[] = [
      TransferStatus.DRAFT,
      TransferStatus.PENDING_APPROVAL,
      TransferStatus.APPROVED,
    ];
    if (!cancellable.includes(transfer.status)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Stock that has already left the branch cannot be cancelled. Reject or receive it instead.',
      });
    }

    return this.transition(
      actor,
      id,
      TransferStatus.CANCELLED,
      { closedAt: new Date() },
      'TRANSFER_CANCELLED',
    );
  }

  /**
   * Sends the stock out of the source branch: the batch balance drops, a
   * TRANSFER_OUT movement is written, and the destination batch is created with
   * an empty balance so receipt has something to fill.
   */
  async dispatch(actor: RequestActor, id: string): Promise<{ data: TransferRecord }> {
    const transfer = await this.requireTransfer(actor, id);
    if (transfer.status !== TransferStatus.APPROVED) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Only an approved transfer can be dispatched.',
      });
    }
    await this.branchAccess.assertAccess(actor, transfer.fromBranchId);

    const dispatched = await this.prisma.$transaction(async (tx) => {
      for (const line of transfer.lines) {
        const quantity = this.toQuantity(line.quantity);
        const balance = await tx.batchBalance.findFirst({
          where: { organizationId: actor.organizationId, batchId: line.sourceBatchId },
        });
        if (!balance) {
          throw new NotFoundException({
            code: 'NOT_FOUND',
            message: 'The source batch no longer holds stock.',
          });
        }
        const previous = this.toQuantity(balance.quantity);
        if (previous < quantity) {
          throw new BadRequestException({
            code: 'INSUFFICIENT_STOCK',
            message: `Batch ${line.sourceBatch?.batchNumber ?? line.sourceBatchId} now holds only ${previous} units.`,
          });
        }

        // Conditional decrement keeps two concurrent dispatches from overshooting.
        const updated = await tx.batchBalance.updateMany({
          where: { batchId: line.sourceBatchId, quantity: { gte: new Prisma.Decimal(quantity) } },
          data: { quantity: { decrement: new Prisma.Decimal(quantity) }, version: { increment: 1 } },
        });
        if (updated.count !== 1) {
          throw new BadRequestException({
            code: 'INSUFFICIENT_STOCK',
            message: 'The batch balance changed while dispatching. Reload and try again.',
          });
        }

        await tx.stockMovement.create({
          data: {
            organizationId: actor.organizationId,
            branchId: transfer.fromBranchId,
            batchId: line.sourceBatchId,
            type: 'TRANSFER_OUT',
            quantityDelta: new Prisma.Decimal(-quantity),
            previousQuantity: new Prisma.Decimal(previous),
            newQuantity: new Prisma.Decimal(previous - quantity),
            reason: `Transfer ${transfer.reference} to ${transfer.toBranch.name}`,
            actorId: actor.userId,
            idempotencyKey: `transfer:${transfer.id}:${line.id}:out`,
          },
        });

        const destinationBatch = await this.destinationBatch(tx, {
          organizationId: actor.organizationId,
          toBranchId: transfer.toBranchId,
          source: line,
        });

        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: { destinationBatchId: destinationBatch.id },
        });
      }

      return tx.stockTransfer.update({
        where: { id: transfer.id },
        data: {
          status: TransferStatus.IN_TRANSIT,
          dispatchedById: actor.userId,
          dispatchedAt: new Date(),
        },
        include: TRANSFER_INCLUDE,
      });
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      branchId: transfer.fromBranchId,
      actorId: actor.userId,
      action: 'TRANSFER_DISPATCHED',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      metadata: { reference: transfer.reference, toBranchId: transfer.toBranchId },
    });

    return { data: this.toRecord(dispatched) };
  }

  /**
   * Confirms what arrived. Quantity that arrived damaged is received and then
   * written off so the batch ledger explains every unit; quantity that never
   * arrived is simply not received and is recorded on the line.
   */
  async receive(
    actor: RequestActor,
    id: string,
    dto: ReceiveTransferDto,
  ): Promise<{ data: TransferRecord }> {
    const transfer = await this.requireTransfer(actor, id);
    if (transfer.status !== TransferStatus.IN_TRANSIT) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Only a transfer in transit can be received.',
      });
    }
    await this.branchAccess.assertAccess(actor, transfer.toBranchId);

    const requested = new Map((dto.lines ?? []).map((line) => [line.lineId, line]));

    const received = await this.prisma.$transaction(async (tx) => {
      for (const line of transfer.lines) {
        const dispatchedQuantity = this.toQuantity(line.quantity);
        const input = requested.get(line.id);
        const good = input ? input.receivedQuantity : dispatchedQuantity;
        const damaged = input?.damagedQuantity ?? 0;

        if (good + damaged > dispatchedQuantity) {
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: 'Received and damaged quantities cannot exceed what was dispatched.',
          });
        }
        if (!line.destinationBatchId) {
          throw new BadRequestException({
            code: 'VALIDATION_ERROR',
            message: 'This transfer was not dispatched, so there is nothing to receive.',
          });
        }

        const arrived = good + damaged;
        if (arrived > 0) {
          await this.applyMovement(tx, {
            organizationId: actor.organizationId,
            branchId: transfer.toBranchId,
            batchId: line.destinationBatchId,
            type: 'TRANSFER_IN',
            quantity: arrived,
            reason: `Transfer ${transfer.reference} from ${transfer.fromBranch.name}`,
            actorId: actor.userId,
            idempotencyKey: `transfer:${transfer.id}:${line.id}:in`,
          });
        }

        if (damaged > 0) {
          await this.applyMovement(tx, {
            organizationId: actor.organizationId,
            branchId: transfer.toBranchId,
            batchId: line.destinationBatchId,
            type: 'ADJUSTMENT',
            quantity: -damaged,
            reason: `Damaged in transfer ${transfer.reference}`,
            actorId: actor.userId,
            idempotencyKey: `transfer:${transfer.id}:${line.id}:damage`,
          });
        }

        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: {
            receivedQuantity: new Prisma.Decimal(good),
            damagedQuantity: new Prisma.Decimal(damaged),
          },
        });
      }

      return tx.stockTransfer.update({
        where: { id: transfer.id },
        data: {
          status: TransferStatus.RECEIVED,
          receivedById: actor.userId,
          receivedAt: new Date(),
          closedAt: new Date(),
          note: dto.note?.trim() ? dto.note.trim() : transfer.note,
        },
        include: TRANSFER_INCLUDE,
      });
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      branchId: transfer.toBranchId,
      actorId: actor.userId,
      action: 'TRANSFER_RECEIVED',
      entityType: 'StockTransfer',
      entityId: transfer.id,
      metadata: { reference: transfer.reference, fromBranchId: transfer.fromBranchId },
    });

    return { data: this.toRecord(received) };
  }

  /** Loads a transfer with its branch and line context, enforcing org membership. */
  private async requireTransfer(actor: RequestActor, id: string): Promise<TransferWithRelations> {
    const transfer = await this.prisma.stockTransfer.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: TRANSFER_INCLUDE,
    });
    if (!transfer) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Transfer not found' });
    }

    // The caller must be able to reach one side of the transfer.
    const allowed = await this.branchAccess.allowedBranchIds(actor);
    const touches = allowed.includes(transfer.fromBranchId) || allowed.includes(transfer.toBranchId);
    if (!touches) {
      throw new ForbiddenException({
        code: 'BRANCH_FORBIDDEN',
        message: 'You do not have access to either branch in this transfer.',
      });
    }

    return transfer;
  }

  private async transition(
    actor: RequestActor,
    id: string,
    status: TransferStatus,
    data: Prisma.StockTransferUpdateInput,
    action: string,
  ): Promise<{ data: TransferRecord }> {
    const transfer = await this.prisma.stockTransfer.update({
      where: { id },
      data: { status, ...data },
      include: TRANSFER_INCLUDE,
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      branchId: transfer.fromBranchId,
      actorId: actor.userId,
      action,
      entityType: 'StockTransfer',
      entityId: transfer.id,
      metadata: { reference: transfer.reference, status },
    });

    return { data: this.toRecord(transfer) };
  }

  /**
   * Applies a delta to a batch balance and writes the matching movement in one
   * step. Used by receipt, where the destination batch always exists because
   * dispatch created it.
   */
  private async applyMovement(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      branchId: string;
      batchId: string;
      type: 'TRANSFER_IN' | 'ADJUSTMENT';
      quantity: number;
      reason: string;
      actorId: string;
      idempotencyKey: string;
    },
  ): Promise<void> {
    const existing = await tx.stockMovement.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      select: { id: true },
    });
    if (existing) return;

    const balance = await tx.batchBalance.findFirst({
      where: { organizationId: input.organizationId, batchId: input.batchId },
    });
    const previous = this.toQuantity(balance?.quantity);
    const next = previous + input.quantity;

    if (next < 0) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_STOCK',
        message: 'The destination batch balance cannot go below zero.',
      });
    }

    await tx.batchBalance.upsert({
      where: { batchId: input.batchId },
      create: {
        organizationId: input.organizationId,
        batchId: input.batchId,
        quantity: new Prisma.Decimal(next),
        version: 1,
      },
      update: { quantity: new Prisma.Decimal(next), version: { increment: 1 } },
    });

    await tx.stockMovement.create({
      data: {
        organizationId: input.organizationId,
        branchId: input.branchId,
        batchId: input.batchId,
        type: input.type,
        quantityDelta: new Prisma.Decimal(input.quantity),
        previousQuantity: new Prisma.Decimal(previous),
        newQuantity: new Prisma.Decimal(next),
        reason: input.reason,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
      },
    });
  }

  /**
   * Finds the matching batch in the destination branch, creating it when the
   * branch has never held this batch. Batch identity stays per branch, which is
   * what keeps expiry and valuation independent between locations.
   */
  private async destinationBatch(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string;
      toBranchId: string;
      source: TransferWithRelations['lines'][number];
    },
  ) {
    const { source } = input;
    const existing = await tx.batch.findFirst({
      where: {
        organizationId: input.organizationId,
        branchId: input.toBranchId,
        productId: source.productId,
        batchNumber: source.sourceBatch.batchNumber,
        expiryDate: source.sourceBatch.expiryDate,
      },
    });
    if (existing) return existing;

    return tx.batch.create({
      data: {
        organizationId: input.organizationId,
        branchId: input.toBranchId,
        productId: source.productId,
        batchNumber: source.sourceBatch.batchNumber,
        expiryDate: source.sourceBatch.expiryDate,
        unit: source.sourceBatch.unit,
      },
    });
  }

  private toRecord(transfer: TransferWithRelations): TransferRecord {
    return {
      id: transfer.id,
      reference: transfer.reference,
      fromBranchId: transfer.fromBranchId,
      fromBranchName: transfer.fromBranch.name,
      toBranchId: transfer.toBranchId,
      toBranchName: transfer.toBranch.name,
      status: transfer.status,
      note: transfer.note,
      requestedById: transfer.requestedById,
      approvedById: transfer.approvedById,
      dispatchedById: transfer.dispatchedById,
      receivedById: transfer.receivedById,
      rejectedById: transfer.rejectedById,
      rejectedReason: transfer.rejectedReason,
      approvedAt: transfer.approvedAt,
      dispatchedAt: transfer.dispatchedAt,
      receivedAt: transfer.receivedAt,
      createdAt: transfer.createdAt,
      updatedAt: transfer.updatedAt,
      lines: transfer.lines.map((line) => ({
        id: line.id,
        productId: line.productId,
        productName: line.product.name,
        sourceBatchId: line.sourceBatchId,
        destinationBatchId: line.destinationBatchId,
        batchNumber: line.sourceBatch.batchNumber,
        expiryDate: line.sourceBatch.expiryDate,
        unit: line.sourceBatch.unit,
        quantity: this.toQuantity(line.quantity),
        receivedQuantity: this.toQuantity(line.receivedQuantity),
        damagedQuantity: this.toQuantity(line.damagedQuantity),
      })),
    };
  }

  /** Readable, per-organisation unique reference such as `TRF-8F3K1Q`. */
  private reference(): string {
    return `TRF-${randomBytes(3).toString('hex').toUpperCase()}`;
  }

  private toQuantity(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
  }
}

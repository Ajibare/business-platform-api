import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, Role, TransferStatus } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { AuditService } from '../../../platform/audit/audit.service';
import {
  BranchAccessService,
  type RequestActor,
} from '../../../platform/branches/branch-access.service';
import { TransfersService } from './transfers.service';

/**
 * Inter-branch transfers. The units must leave the source exactly once and
 * arrive at the destination exactly once, so these cases pin the state machine,
 * the balance arithmetic and the idempotency keys of every movement.
 */
describe('TransfersService', () => {
  let service: TransfersService;

  const prismaMock = {
    branch: { findFirst: jest.fn() },
    batch: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    batchBalance: { findFirst: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() },
    stockMovement: { create: jest.fn(), findUnique: jest.fn() },
    stockTransfer: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    stockTransferLine: { update: jest.fn() },
    organization: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };

  const branchAccessMock = {
    assertAccess: jest.fn(),
    allowedBranchIds: jest.fn(),
  };

  const auditMock = { record: jest.fn() };

  let branches: Record<string, { id: string; name: string; status: string }>;

  const actor: RequestActor = {
    userId: 'user-1',
    organizationId: 'org-1',
    role: Role.PHARMACIST,
    permissions: new Set(['transfer:request', 'transfer:dispatch', 'transfer:receive']),
  };

  const dec = (value: number) => new Prisma.Decimal(value);

  function transferRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 't-1',
      reference: 'TRF-ABC123',
      organizationId: 'org-1',
      fromBranchId: 'b1',
      toBranchId: 'b2',
      status: TransferStatus.APPROVED,
      note: null,
      requestedById: 'user-1',
      approvedById: 'user-2',
      dispatchedById: null,
      receivedById: null,
      rejectedById: null,
      rejectedReason: null,
      approvedAt: new Date('2026-02-01T10:00:00.000Z'),
      dispatchedAt: null,
      receivedAt: null,
      closedAt: null,
      createdAt: new Date('2026-02-01T09:00:00.000Z'),
      updatedAt: new Date('2026-02-01T09:00:00.000Z'),
      fromBranch: { name: 'Main' },
      toBranch: { name: 'Ikeja' },
      lines: [
        {
          id: 'line-1',
          productId: 'product-1',
          sourceBatchId: 'batch-1',
          destinationBatchId: null,
          quantity: dec(10),
          receivedQuantity: dec(0),
          damagedQuantity: dec(0),
          product: { name: 'Paracetamol 500mg' },
          sourceBatch: {
            batchNumber: 'B-01',
            expiryDate: new Date('2027-01-31T00:00:00.000Z'),
            unit: 'tablet',
          },
        },
      ],
      ...overrides,
    };
  }

  const rejection = async (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => error,
    );

  beforeEach(async () => {
    jest.resetAllMocks();
    branches = {
      b1: { id: 'b1', name: 'Main', status: 'ACTIVE' },
      b2: { id: 'b2', name: 'Ikeja', status: 'ACTIVE' },
    };
    prismaMock.branch.findFirst.mockImplementation(
      async ({ where }: { where: { id: string } }) => branches[where.id] ?? null,
    );
    prismaMock.organization.findUnique.mockResolvedValue({ requireTransferApproval: false });
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(prismaMock),
    );
    branchAccessMock.assertAccess.mockResolvedValue(undefined);
    branchAccessMock.allowedBranchIds.mockResolvedValue(['b1', 'b2']);

    const moduleRef = await Test.createTestingModule({
      providers: [
        TransfersService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: BranchAccessService, useValue: branchAccessMock },
        { provide: AuditService, useValue: auditMock },
      ],
    }).compile();
    service = moduleRef.get(TransfersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const input = {
      fromBranchId: 'b1',
      toBranchId: 'b2',
      lines: [{ sourceBatchId: 'batch-1', quantity: 4 }],
    };

    beforeEach(() => {
      prismaMock.batch.findMany.mockResolvedValue([
        { id: 'batch-1', productId: 'product-1', batchNumber: 'B-01', balance: { quantity: dec(10) } },
      ]);
      prismaMock.stockTransfer.create.mockResolvedValue(transferRow());
    });

    it('refuses a transfer that starts and ends in the same branch', async () => {
      const error = await rejection(service.create(actor, { ...input, toBranchId: 'b1' }));

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(prismaMock.stockTransfer.create).not.toHaveBeenCalled();
    });

    it('refuses an inactive branch on either side', async () => {
      branches.b1.status = 'INACTIVE';

      const error = await rejection(service.create(actor, input));

      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'BRANCH_INACTIVE',
      });
    });

    it('only looks for batches inside the source branch', async () => {
      prismaMock.batch.findMany.mockResolvedValue([]);

      const error = await rejection(service.create(actor, input));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(prismaMock.batch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org-1',
            branchId: 'b1',
            id: { in: ['batch-1'] },
          },
        }),
      );
    });

    it('refuses to move more units than the batch holds', async () => {
      prismaMock.batch.findMany.mockResolvedValue([
        { id: 'batch-1', productId: 'product-1', batchNumber: 'B-01', balance: { quantity: dec(3) } },
      ]);

      const error = await rejection(service.create(actor, input));

      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
      });
    });

    it('auto-approves when the organisation does not require approval', async () => {
      await service.create(actor, input);

      expect(prismaMock.stockTransfer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: TransferStatus.APPROVED,
            approvedById: 'user-1',
            fromBranchId: 'b1',
            toBranchId: 'b2',
          }),
        }),
      );
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'TRANSFER_CREATED', branchId: 'b1' }),
      );
    });

    it('waits for a second person when approval is required', async () => {
      prismaMock.organization.findUnique.mockResolvedValue({ requireTransferApproval: true });

      await service.create(actor, input);

      expect(prismaMock.stockTransfer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: TransferStatus.PENDING_APPROVAL,
            approvedById: null,
          }),
        }),
      );
    });

    it('keeps a draft when the caller saves instead of submitting', async () => {
      await service.create(actor, { ...input, submit: false });

      expect(prismaMock.stockTransfer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: TransferStatus.DRAFT }),
        }),
      );
    });

    it('refuses to take stock out of a branch the caller cannot reach', async () => {
      branchAccessMock.assertAccess.mockRejectedValue(
        new ForbiddenException({ code: 'BRANCH_FORBIDDEN', message: 'nope' }),
      );

      const error = await rejection(service.create(actor, input));

      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'BRANCH_FORBIDDEN',
      });
      expect(prismaMock.stockTransfer.create).not.toHaveBeenCalled();
    });
  });

  describe('approval', () => {
    it('refuses self-approval', async () => {
      prismaMock.stockTransfer.findFirst.mockResolvedValue(
        transferRow({ status: TransferStatus.PENDING_APPROVAL, requestedById: 'user-1' }),
      );

      const error = await rejection(service.approve(actor, 't-1'));

      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(prismaMock.stockTransfer.update).not.toHaveBeenCalled();
    });

    it('approves a request raised by someone else', async () => {
      prismaMock.stockTransfer.findFirst.mockResolvedValue(
        transferRow({ status: TransferStatus.PENDING_APPROVAL, requestedById: 'user-2' }),
      );
      prismaMock.stockTransfer.update.mockResolvedValue(
        transferRow({ status: TransferStatus.APPROVED }),
      );

      const approved = await service.approve(actor, 't-1');

      expect(approved.data.status).toBe(TransferStatus.APPROVED);
      expect(prismaMock.stockTransfer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: TransferStatus.APPROVED,
            approvedById: 'user-1',
          }),
        }),
      );
    });

    it('cannot approve a transfer that is not waiting', async () => {
      prismaMock.stockTransfer.findFirst.mockResolvedValue(transferRow());

      const error = await rejection(service.approve(actor, 't-1'));

      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });
  });

  describe('dispatch', () => {
    beforeEach(() => {
      prismaMock.stockTransfer.findFirst.mockResolvedValue(transferRow());
      prismaMock.batchBalance.findFirst.mockResolvedValue({ quantity: dec(10) });
      prismaMock.batchBalance.updateMany.mockResolvedValue({ count: 1 });
      prismaMock.batch.findFirst.mockResolvedValue(null);
      prismaMock.batch.create.mockResolvedValue({ id: 'batch-2' });
      prismaMock.stockTransfer.update.mockResolvedValue(
        transferRow({ status: TransferStatus.IN_TRANSIT }),
      );
    });

    it('takes the units out of the source exactly once', async () => {
      await service.dispatch(actor, 't-1');

      expect(prismaMock.batchBalance.updateMany).toHaveBeenCalledWith({
        where: { batchId: 'batch-1', quantity: { gte: dec(10) } },
        data: { quantity: { decrement: dec(10) }, version: { increment: 1 } },
      });
      expect(prismaMock.stockMovement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          branchId: 'b1',
          type: 'TRANSFER_OUT',
          quantityDelta: dec(-10),
          previousQuantity: dec(10),
          newQuantity: dec(0),
          idempotencyKey: 'transfer:t-1:line-1:out',
        }),
      });
      expect(prismaMock.stockTransfer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: TransferStatus.IN_TRANSIT }),
        }),
      );
    });

    it('creates the destination batch so the branch tracks its own expiry', async () => {
      await service.dispatch(actor, 't-1');

      expect(prismaMock.batch.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: 'org-1',
          branchId: 'b2',
          productId: 'product-1',
          batchNumber: 'B-01',
        }),
      });
      expect(prismaMock.stockTransferLine.update).toHaveBeenCalledWith({
        where: { id: 'line-1' },
        data: { destinationBatchId: 'batch-2' },
      });
    });

    it('reuses the destination batch when it already exists', async () => {
      prismaMock.batch.findFirst.mockResolvedValue({ id: 'batch-existing' });

      await service.dispatch(actor, 't-1');

      expect(prismaMock.batch.create).not.toHaveBeenCalled();
      expect(prismaMock.stockTransferLine.update).toHaveBeenCalledWith({
        where: { id: 'line-1' },
        data: { destinationBatchId: 'batch-existing' },
      });
    });

    it('refuses to dispatch when the balance changed underneath', async () => {
      prismaMock.batchBalance.updateMany.mockResolvedValue({ count: 0 });

      const error = await rejection(service.dispatch(actor, 't-1'));

      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'INSUFFICIENT_STOCK',
      });
      expect(prismaMock.stockMovement.create).not.toHaveBeenCalled();
      expect(prismaMock.stockTransfer.update).not.toHaveBeenCalled();
    });

    it('only dispatches an approved transfer', async () => {
      prismaMock.stockTransfer.findFirst.mockResolvedValue(
        transferRow({ status: TransferStatus.IN_TRANSIT }),
      );

      const error = await rejection(service.dispatch(actor, 't-1'));

      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('receive', () => {
    beforeEach(() => {
      prismaMock.stockTransfer.findFirst.mockResolvedValue(
        transferRow({
          status: TransferStatus.IN_TRANSIT,
          lines: [
            {
              ...transferRow().lines[0],
              destinationBatchId: 'batch-2',
            },
          ],
        }),
      );
      prismaMock.stockMovement.findUnique.mockResolvedValue(null);
      prismaMock.batchBalance.findFirst.mockResolvedValue({ quantity: dec(0) });
      prismaMock.batchBalance.upsert.mockResolvedValue({});
      prismaMock.stockTransfer.update.mockResolvedValue(
        transferRow({ status: TransferStatus.RECEIVED }),
      );
    });

    it('receives the good units and writes off the damaged ones', async () => {
      // The destination starts empty and every movement updates its balance,
      // the way the real ledger does between the two writes.
      let destinationBalance = 0;
      prismaMock.batchBalance.findFirst.mockImplementation(async () => ({
        quantity: dec(destinationBalance),
      }));
      prismaMock.batchBalance.upsert.mockImplementation(
        async ({ create, update }: { create?: { quantity: unknown }; update?: { quantity: unknown } }) => {
          destinationBalance = Number(create?.quantity ?? update?.quantity);
          return {};
        },
      );

      await service.receive(actor, 't-1', {
        lines: [{ lineId: 'line-1', receivedQuantity: 8, damagedQuantity: 2 }],
      });

      const movements = prismaMock.stockMovement.create.mock.calls.map(
        (call) => call[0].data as Record<string, unknown>,
      );
      expect(movements).toEqual([
        expect.objectContaining({
          branchId: 'b2',
          type: 'TRANSFER_IN',
          quantityDelta: dec(10),
          idempotencyKey: 'transfer:t-1:line-1:in',
        }),
        expect.objectContaining({
          branchId: 'b2',
          type: 'ADJUSTMENT',
          quantityDelta: dec(-2),
          idempotencyKey: 'transfer:t-1:line-1:damage',
        }),
      ]);
      expect(prismaMock.stockTransferLine.update).toHaveBeenCalledWith({
        where: { id: 'line-1' },
        data: { receivedQuantity: dec(8), damagedQuantity: dec(2) },
      });
      expect(prismaMock.stockTransfer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: TransferStatus.RECEIVED }),
        }),
      );
    });

    it('receives every line in full when no quantities are given', async () => {
      await service.receive(actor, 't-1', {});

      expect(prismaMock.stockMovement.create).toHaveBeenCalledTimes(1);
      expect(prismaMock.stockMovement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: 'TRANSFER_IN', quantityDelta: dec(10) }),
      });
    });

    it('is idempotent: a movement already written is not written again', async () => {
      prismaMock.stockMovement.findUnique.mockResolvedValue({ id: 'movement-1' });

      await service.receive(actor, 't-1', {});

      expect(prismaMock.stockMovement.create).not.toHaveBeenCalled();
      expect(prismaMock.batchBalance.upsert).not.toHaveBeenCalled();
    });

    it('refuses more units than were dispatched', async () => {
      const error = await rejection(
        service.receive(actor, 't-1', {
          lines: [{ lineId: 'line-1', receivedQuantity: 9, damagedQuantity: 2 }],
        }),
      );

      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(prismaMock.stockMovement.create).not.toHaveBeenCalled();
    });

    it('only receives a transfer in transit', async () => {
      prismaMock.stockTransfer.findFirst.mockResolvedValue(transferRow());

      const error = await rejection(service.receive(actor, 't-1', {}));

      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('refuses receipt at a branch the caller cannot reach', async () => {
      branchAccessMock.assertAccess.mockRejectedValue(
        new ForbiddenException({ code: 'BRANCH_FORBIDDEN', message: 'nope' }),
      );

      const error = await rejection(service.receive(actor, 't-1', {}));

      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'BRANCH_FORBIDDEN',
      });
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('cancellation', () => {
    it('cancels a transfer that has not left the branch', async () => {
      prismaMock.stockTransfer.findFirst.mockResolvedValue(
        transferRow({ status: TransferStatus.PENDING_APPROVAL }),
      );
      prismaMock.stockTransfer.update.mockResolvedValue(
        transferRow({ status: TransferStatus.CANCELLED }),
      );

      const cancelled = await service.cancel(actor, 't-1');

      expect(cancelled.data.status).toBe(TransferStatus.CANCELLED);
    });

    it('refuses to cancel stock that is already in transit', async () => {
      prismaMock.stockTransfer.findFirst.mockResolvedValue(
        transferRow({ status: TransferStatus.IN_TRANSIT }),
      );

      const error = await rejection(service.cancel(actor, 't-1'));

      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      expect(prismaMock.stockTransfer.update).not.toHaveBeenCalled();
    });
  });

  describe('visibility', () => {
    it('lists only transfers touching the branches in scope', async () => {
      prismaMock.stockTransfer.findMany.mockResolvedValue([]);

      await service.findAll(actor, ['b1'], { direction: 'out', limit: 20 });

      expect(prismaMock.stockTransfer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org-1',
            fromBranchId: { in: ['b1'] },
          },
          take: 20,
        }),
      );
    });

    it('hides a transfer between branches the caller cannot reach', async () => {
      prismaMock.stockTransfer.findFirst.mockResolvedValue(null);

      const error = await rejection(service.findOne(actor, ['b1'], 't-9'));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(prismaMock.stockTransfer.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 't-9',
            organizationId: 'org-1',
            OR: [{ fromBranchId: { in: ['b1'] } }, { toBranchId: { in: ['b1'] } }],
          },
        }),
      );
    });

    it('refuses a transfer that touches neither of the caller branches', async () => {
      prismaMock.stockTransfer.findFirst.mockResolvedValue(transferRow());
      branchAccessMock.allowedBranchIds.mockResolvedValue(['b3']);

      const error = await rejection(service.cancel(actor, 't-1'));

      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'BRANCH_FORBIDDEN',
      });
    });
  });
});

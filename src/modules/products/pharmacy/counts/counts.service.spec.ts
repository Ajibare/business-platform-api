import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../../database/prisma.service';
import { CountsService } from './counts.service';

describe('CountsService', () => {
  let service: CountsService;

  const prismaMock = {
    stockCount: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    stockCountLine: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    batch: { findFirst: jest.fn(), findMany: jest.fn() },
    batchBalance: { findFirst: jest.fn(), upsert: jest.fn() },
    stockMovement: { create: jest.fn() },
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        CountsService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    service = moduleRef.get(CountsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('creates a draft count with snapshot lines', async () => {
    prismaMock.stockCount.create.mockResolvedValue({
      id: 'count-1',
      organizationId: 'org-1',
      status: 'DRAFT',
      scope: 'ALL',
      startedAt: new Date(),
      closedAt: null,
      counterId: 'user-1',
      approverId: null,
      lines: [],
    });
    prismaMock.batch.findMany.mockResolvedValue([{ id: 'batch-1', productId: 'prod-1' }]);
    prismaMock.batchBalance.findFirst.mockResolvedValue({ quantity: { toNumber: () => 10 } });
    prismaMock.stockCount.findUnique.mockResolvedValue({
      id: 'count-1',
      organizationId: 'org-1',
      status: 'DRAFT',
      scope: 'ALL',
      startedAt: new Date(),
      closedAt: null,
      counterId: 'user-1',
      approverId: null,
      lines: [
        {
          id: 'line-1',
          countId: 'count-1',
          batchId: 'batch-1',
          productId: 'prod-1',
          recordedQuantity: { toNumber: () => 10 },
          countedQuantity: { toNumber: () => 0 },
          variance: { toNumber: () => -10 },
          note: null,
          versionAtCount: new Date(),
        },
      ],
    });

    const result = await service.create('org-1', 'branch-1', 'user-1', { scope: 'ALL' });

    expect(result.id).toBe('count-1');
    expect(result.status).toBe('DRAFT');
    expect(result.lines).toHaveLength(1);
    expect(prismaMock.stockCountLine.create).toHaveBeenCalledTimes(1);
  });

  it('adds a counted line and computes variance', async () => {
    prismaMock.stockCount.findFirst.mockResolvedValue({ id: 'count-1', status: 'DRAFT' });
    prismaMock.batch.findFirst.mockResolvedValue({ id: 'batch-1', productId: 'prod-1' });
    prismaMock.stockCountLine.findFirst.mockResolvedValue({
      id: 'line-1',
      countId: 'count-1',
      batchId: 'batch-1',
      productId: 'prod-1',
      recordedQuantity: { toNumber: () => 10 },
      countedQuantity: { toNumber: () => 0 },
      variance: { toNumber: () => -10 },
      note: null,
      versionAtCount: new Date(),
    });
    prismaMock.stockCountLine.update.mockResolvedValue({
      id: 'line-1',
      countId: 'count-1',
      batchId: 'batch-1',
      productId: 'prod-1',
      recordedQuantity: { toNumber: () => 10 },
      countedQuantity: { toNumber: () => 12 },
      variance: { toNumber: () => 2 },
      note: null,
      versionAtCount: new Date(),
    });

    const result = await service.addLine('org-1', ['branch-1'], 'count-1', {
      batchId: 'batch-1',
      countedQuantity: 12,
      note: 'physical count',
    });

    expect(result.countedQuantity).toBe(12);
    expect(result.variance).toBe(2);
  });

  it('rejects adding a line to a submitted count', async () => {
    prismaMock.stockCount.findFirst.mockResolvedValue({ id: 'count-1', status: 'SUBMITTED' });

    await expect(
      service.addLine('org-1', ['branch-1'], 'count-1', { batchId: 'batch-1', countedQuantity: 12 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects approving a draft count', async () => {
    prismaMock.stockCount.findFirst.mockResolvedValue({ id: 'count-1', status: 'DRAFT', lines: [] });

    await expect(service.approve('org-1', ['branch-1'], 'count-1', 'user-2')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('approves a submitted count and records an adjustment movement', async () => {
    prismaMock.stockCount.findFirst.mockResolvedValue({
      id: 'count-1',
      status: 'SUBMITTED',
      lines: [
        {
          id: 'line-1',
          countId: 'count-1',
          batchId: 'batch-1',
          productId: 'prod-1',
          recordedQuantity: { toNumber: () => 10 },
          countedQuantity: { toNumber: () => 12 },
          variance: { toNumber: () => 2 },
          note: null,
          versionAtCount: new Date(),
        },
      ],
    });
    prismaMock.stockMovement.create.mockResolvedValue({ id: 'movement-1' });
    prismaMock.batchBalance.findFirst.mockResolvedValue({ quantity: { toNumber: () => 10 }, version: 1 });
    prismaMock.batchBalance.upsert.mockResolvedValue({});
    prismaMock.stockCount.update.mockResolvedValue({
      id: 'count-1',
      organizationId: 'org-1',
      status: 'APPROVED',
      scope: 'ALL',
      startedAt: new Date(),
      closedAt: new Date(),
      counterId: 'user-1',
      approverId: 'user-2',
      lines: [],
    });

    const result = await service.approve('org-1', ['branch-1'], 'count-1', 'user-2');

    expect(result.status).toBe('APPROVED');
    expect(prismaMock.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.batchBalance.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects approving an unknown count', async () => {
    prismaMock.stockCount.findFirst.mockResolvedValue(null);

    await expect(service.approve('org-1', ['branch-1'], 'missing', 'user-2')).rejects.toThrow(
      NotFoundException,
    );
  });
});

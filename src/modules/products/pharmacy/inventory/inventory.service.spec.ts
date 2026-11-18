import { BadRequestException, HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../../database/prisma.service';
import { InventoryService } from './inventory.service';
import { CreateMovementDto } from './dto/create-movement.dto';

describe('InventoryService', () => {
  let service: InventoryService;

  const prismaMock = {
    batch: { findFirst: jest.fn() },
    stockMovement: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    batchBalance: { findFirst: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    service = moduleRef.get(InventoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('rejects adjustments without a reason', async () => {
    prismaMock.batch.findFirst.mockResolvedValue({ id: 'batch-1', organizationId: 'org-1' });
    await expect(
      service.create('org-1', 'branch-1', 'user-1', {
        batchId: 'batch-1',
        type: 'ADJUSTMENT',
        quantityDelta: 5,
        idempotencyKey: 'adj-1',
      } as CreateMovementDto),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects movements that would drive the balance negative', async () => {
    prismaMock.batch.findFirst.mockResolvedValue({ id: 'batch-1', organizationId: 'org-1' });
    prismaMock.batchBalance.findFirst.mockResolvedValue({ quantity: { toNumber: () => 2 } });
    prismaMock.stockMovement.findUnique.mockResolvedValue(null);

    await expect(
      service.create('org-1', 'branch-1', 'user-1', {
        batchId: 'batch-1',
        type: 'ISSUE',
        quantityDelta: -5,
        idempotencyKey: 'issue-1',
      } as CreateMovementDto),
    ).rejects.toThrow(HttpException);
  });
});

import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../../database/prisma.service';
import { BatchesService } from './batches.service';

describe('BatchesService', () => {
  let service: BatchesService;

  const prismaMock = {
    product: { findFirst: jest.fn() },
    batch: { findFirst: jest.fn(), create: jest.fn() },
    stockMovement: { findUnique: jest.fn(), create: jest.fn() },
    batchBalance: { findFirst: jest.fn(), upsert: jest.fn() },
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        BatchesService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    service = moduleRef.get(BatchesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('returns not found when the medicine does not exist', async () => {
    prismaMock.product.findFirst.mockResolvedValue(null);

    await expect(
      service.create('org-1', 'branch-1', 'user-1', {
        medicineId: 'med-1',
        quantity: 5,
        idempotencyKey: 'opening-1',
      }),
    ).rejects.toThrow(NotFoundException);
  });
});

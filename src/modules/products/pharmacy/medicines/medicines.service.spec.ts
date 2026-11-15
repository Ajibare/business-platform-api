import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../../database/prisma.service';
import { MedicinesService } from './medicines.service';

describe('MedicinesService', () => {
  let service: MedicinesService;

  const prismaMock = {
    product: { findFirst: jest.fn(), create: jest.fn(), count: jest.fn() },
    batchBalance: { findFirst: jest.fn() },
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        MedicinesService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    service = moduleRef.get(MedicinesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('creates a medicine for the organisation', async () => {
    prismaMock.product.findFirst.mockResolvedValue(null);
    prismaMock.product.create.mockResolvedValue({
      id: 'med-1',
      organizationId: 'org-1',
      name: 'Paracetamol',
      normalizedName: 'paracetamol',
      brand: null,
      strength: null,
      dosageForm: null,
      packSize: null,
      unit: 'tablet',
      reorderThreshold: null,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prismaMock.batchBalance.findFirst.mockResolvedValue({ quantity: { toNumber: () => 0 } });

    const result = await service.create('org-1', 'user-1', {
      name: 'Paracetamol',
      unit: 'tablet',
    });

    expect(prismaMock.product.create).toHaveBeenCalled();
    expect(result.id).toBe('med-1');
  });

  it('rejects a duplicate product name within the organisation', async () => {
    prismaMock.product.findFirst.mockResolvedValue({
      id: 'med-1',
      name: 'Paracetamol',
    });

    await expect(
      service.create('org-1', 'user-1', { name: 'Paracetamol', unit: 'tablet' }),
    ).rejects.toThrow(ConflictException);
  });
});

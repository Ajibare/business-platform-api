import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../../database/prisma.service';
import { BarcodesService } from '../barcodes/barcodes.service';
import { MedicinesService } from './medicines.service';

describe('MedicinesService', () => {
  let service: MedicinesService;

  const prismaMock = {
    product: { findFirst: jest.fn(), create: jest.fn(), count: jest.fn() },
    batchBalance: { findFirst: jest.fn() },
  };

  const barcodesMock = { assertAvailable: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        MedicinesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: BarcodesService, useValue: barcodesMock },
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

  it('creates a medicine with a normalised barcode', async () => {
    prismaMock.product.findFirst.mockResolvedValue(null);
    prismaMock.product.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'med-2',
      ...data,
      reorderThreshold: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    prismaMock.batchBalance.findFirst.mockResolvedValue(null);

    const result = await service.create('org-1', 'user-1', {
      name: 'Ibuprofen',
      unit: 'tablet',
      barcode: ' 0123456789012 ',
    });

    expect(barcodesMock.assertAvailable).toHaveBeenCalledWith('org-1', '0123456789012');
    expect(result.barcode).toBe('0123456789012');
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

import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../../database/prisma.service';
import { SuppliersService } from './suppliers.service';

describe('SuppliersService', () => {
  let service: SuppliersService;

  const prismaMock = {
    supplier: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SuppliersService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    service = moduleRef.get(SuppliersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('creates a supplier', async () => {
    prismaMock.supplier.create.mockResolvedValue({
      id: 'supplier-1',
      organizationId: 'org-1',
      name: 'Acme Pharma',
      phone: '08012345678',
      email: 'sales@acme.test',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.create('org-1', { name: 'Acme Pharma', phone: '08012345678', email: 'sales@acme.test' });

    expect(result.id).toBe('supplier-1');
    expect(result.name).toBe('Acme Pharma');
    expect(prismaMock.supplier.create).toHaveBeenCalledTimes(1);
  });

  it('lists suppliers with pagination meta', async () => {
    prismaMock.supplier.findMany.mockResolvedValue([
      {
        id: 'supplier-1',
        organizationId: 'org-1',
        name: 'Acme Pharma',
        phone: null,
        email: null,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    prismaMock.supplier.count.mockResolvedValue(1);

    const result = await service.findAll('org-1', { limit: 10, offset: 0 });

    expect(result.data).toHaveLength(1);
    expect(result.meta).toEqual({ total: 1, limit: 10, offset: 0 });
  });

  it('returns not found for an unknown supplier', async () => {
    prismaMock.supplier.findFirst.mockResolvedValue(null);

    await expect(service.findOne('org-1', 'missing')).rejects.toThrow(NotFoundException);
  });

  it('rejects updating an unknown supplier', async () => {
    prismaMock.supplier.findFirst.mockResolvedValue(null);

    await expect(service.update('org-1', 'missing', { name: 'New name' })).rejects.toThrow(NotFoundException);
  });

  it('updates a supplier', async () => {
    prismaMock.supplier.findFirst.mockResolvedValue({
      id: 'supplier-1',
      organizationId: 'org-1',
      name: 'Acme Pharma',
      phone: null,
      email: null,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prismaMock.supplier.update.mockResolvedValue({
      id: 'supplier-1',
      organizationId: 'org-1',
      name: 'Acme Pharma Ltd',
      phone: '08012345678',
      email: null,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.update('org-1', 'supplier-1', { name: 'Acme Pharma Ltd', phone: '08012345678' });

    expect(result.name).toBe('Acme Pharma Ltd');
    expect(result.phone).toBe('08012345678');
  });
});

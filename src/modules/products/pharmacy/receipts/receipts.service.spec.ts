import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../../database/prisma.service';
import { ReceiptsService } from './receipts.service';

describe('ReceiptsService', () => {
  let service: ReceiptsService;

  const prismaMock = {
    product: { findFirst: jest.fn() },
    supplier: { findFirst: jest.fn() },
    stockReceipt: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    batch: { create: jest.fn() },
    stockMovement: { create: jest.fn() },
    batchBalance: { findFirst: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReceiptsService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();
    service = moduleRef.get(ReceiptsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('creates a draft receipt with lines', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ id: 'prod-1', name: 'Paracetamol', unit: 'tablet' });
    prismaMock.stockReceipt.create.mockResolvedValue({
      id: 'receipt-1',
      organizationId: 'org-1',
      supplierId: null,
      externalReference: null,
      status: 'DRAFT',
      receivedAt: new Date(),
      actorId: 'user-1',
      lines: [
        {
          id: 'line-1',
          receiptId: 'receipt-1',
          productId: 'prod-1',
          batchNumber: 'B-1',
          expiryDate: null,
          unitCost: { toNumber: () => 12.5 },
          sellingPrice: null,
          quantity: { toNumber: () => 100 },
        },
      ],
    });

    const result = await service.create('org-1', 'branch-1', 'user-1', {
      lines: [{ productId: 'prod-1', batchNumber: 'B-1', quantity: 100, unitCost: 12.5 }],
    });

    expect(result.id).toBe('receipt-1');
    expect(result.status).toBe('DRAFT');
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].quantity).toBe(100);
  });

  it('rejects creating a receipt for an unknown medicine', async () => {
    prismaMock.product.findFirst.mockResolvedValue(null);

    await expect(
      service.create('org-1', 'branch-1', 'user-1', { lines: [{ productId: 'missing', quantity: 10 }] }),
    ).rejects.toThrow(NotFoundException);
  });

  it('confirms a draft receipt and records movements and balances', async () => {
    prismaMock.stockReceipt.findFirst.mockResolvedValue({
      id: 'receipt-1',
      organizationId: 'org-1',
      supplierId: null,
      externalReference: null,
      status: 'DRAFT',
      receivedAt: new Date(),
      actorId: 'user-1',
      lines: [
        {
          id: 'line-1',
          receiptId: 'receipt-1',
          productId: 'prod-1',
          batchNumber: 'B-1',
          expiryDate: null,
          unitCost: { toNumber: () => 12.5 },
          sellingPrice: null,
          quantity: { toNumber: () => 100 },
        },
      ],
    });
    prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      const tx = {
        product: { findFirst: jest.fn().mockResolvedValue({ id: 'prod-1', name: 'Paracetamol', unit: 'tablet' }) },
        batch: { create: jest.fn().mockResolvedValue({ id: 'batch-1' }) },
        stockMovement: { create: jest.fn().mockResolvedValue({ id: 'movement-1' }) },
        batchBalance: { findFirst: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
        stockReceipt: {
          update: jest.fn().mockResolvedValue({
            id: 'receipt-1',
            organizationId: 'org-1',
            supplierId: null,
            externalReference: null,
            status: 'CONFIRMED',
            receivedAt: new Date(),
            actorId: 'user-1',
            lines: [
              {
                id: 'line-1',
                receiptId: 'receipt-1',
                productId: 'prod-1',
                batchNumber: 'B-1',
                expiryDate: null,
                unitCost: { toNumber: () => 12.5 },
                sellingPrice: null,
                quantity: { toNumber: () => 100 },
              },
            ],
          }),
        },
      };
      return callback(tx);
    });

    const result = await service.confirm('org-1', ['branch-1'], 'receipt-1', 'user-1');

    expect(result.status).toBe('CONFIRMED');
    expect(prismaMock.$transaction).toHaveBeenCalled();
  });

  it('rejects confirming a non-draft receipt', async () => {
    prismaMock.stockReceipt.findFirst.mockResolvedValue({ id: 'receipt-1', status: 'CONFIRMED', lines: [] });

    await expect(service.confirm('org-1', ['branch-1'], 'receipt-1', 'user-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects confirming an unknown receipt', async () => {
    prismaMock.stockReceipt.findFirst.mockResolvedValue(null);

    await expect(service.confirm('org-1', ['branch-1'], 'missing', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
  });
});

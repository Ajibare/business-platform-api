import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../../database/prisma.service';
import { AuditService } from '../../../platform/audit/audit.service';
import { BulkMedicinesService } from './bulk-medicines.service';
import { BulkCreateMedicinesDto } from './dto/bulk-create-medicines.dto';

describe('BulkMedicinesService', () => {
  let service: BulkMedicinesService;

  const txMock = {
    product: { create: jest.fn() },
    batch: { create: jest.fn() },
    stockMovement: { create: jest.fn() },
    batchBalance: { create: jest.fn() },
    stockReceipt: { create: jest.fn(), update: jest.fn() },
  };

  const prismaMock = {
    organization: { findUnique: jest.fn() },
    product: { findMany: jest.fn() },
    supplier: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };

  const auditMock = { record: jest.fn() };

  const dto = (rows: BulkCreateMedicinesDto['rows']): BulkCreateMedicinesDto => ({ rows });

  beforeEach(async () => {
    jest.clearAllMocks();
    prismaMock.organization.findUnique.mockResolvedValue({ timezone: 'Africa/Lagos' });
    prismaMock.product.findMany.mockResolvedValue([]);
    prismaMock.supplier.findMany.mockResolvedValue([]);
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: typeof txMock) => Promise<unknown>) => callback(txMock),
    );

    let created = 0;
    txMock.product.create.mockImplementation(async () => {
      created += 1;
      return {
        id: `med-${created}`,
        name: 'Paracetamol',
        unit: 'tablet',
        normalizedName: 'paracetamol',
        sku: null,
      };
    });
    txMock.batch.create.mockImplementation(async () => ({ id: `batch-${created}` }));
    txMock.stockMovement.create.mockResolvedValue({ id: 'movement-1' });
    txMock.batchBalance.create.mockResolvedValue({ id: 'balance-1' });
    txMock.stockReceipt.update.mockResolvedValue({ id: 'receipt-1' });
    txMock.stockReceipt.create.mockImplementation(async () => ({
      id: 'receipt-1',
      lines: [{ id: 'line-1' }],
    }));

    const moduleRef = await Test.createTestingModule({
      providers: [
        BulkMedicinesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditService, useValue: auditMock },
      ],
    }).compile();

    service = moduleRef.get(BulkMedicinesService);
  });

  it('creates a medicine together with its opening batch', async () => {
    const result = await service.createMany(
      'org-1',
      'user-1',
      dto([
        {
          name: 'Paracetamol',
          unit: 'tablet',
          batchNumber: 'B-1',
          quantity: 10,
          unitCost: 100,
          sellingPrice: 150,
          expiryDate: '2099-12-31',
        },
      ]),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      row: 1,
      name: 'Paracetamol',
      status: 'CREATED',
      medicineId: 'med-1',
      batchId: 'batch-1',
      quantity: 10,
      errors: [],
      warnings: [],
    });
    expect(result).toMatchObject({ totalRows: 1, created: 1, batchesAdded: 0, failed: 0 });

    // The opening stock is always written as movement plus balance.
    expect(txMock.stockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        batchId: 'batch-1',
        type: 'OPENING',
        quantityDelta: 10,
        previousQuantity: 0,
        newQuantity: 10,
        idempotencyKey: 'bulk:batch-1',
      }),
    });
    expect(txMock.batchBalance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ batchId: 'batch-1', quantity: 10, version: 1 }),
    });

    expect(auditMock.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MEDICINES_BULK_CREATED',
        metadata: { totalRows: 1, created: 1, batchesAdded: 0, failed: 0 },
      }),
    );
  });

  it('adds a second batch to a medicine repeated in the same request', async () => {
    prismaMock.product.findMany.mockResolvedValue([]);

    const result = await service.createMany(
      'org-1',
      'user-1',
      dto([
        { name: 'Paracetamol', unit: 'tablet', batchNumber: 'B-1', quantity: 5 },
        { name: 'Paracetamol', unit: 'tablet', batchNumber: 'B-2', quantity: 7 },
      ]),
    );

    // The medicine is created once; the second row only opens another batch.
    expect(txMock.product.create).toHaveBeenCalledTimes(1);
    expect(txMock.batch.create).toHaveBeenCalledTimes(2);
    expect(result.rows.map((row) => row.status)).toEqual(['CREATED', 'BATCH_ADDED']);
    expect(result.rows[1]).toMatchObject({ medicineId: 'med-1', quantity: 7 });
    expect(result).toMatchObject({ created: 1, batchesAdded: 1, failed: 0 });
  });

  it('fails only the duplicate row and still saves the rest', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'med-1', name: 'Paracetamol', unit: 'tablet', normalizedName: 'paracetamol', sku: null },
    ]);

    const result = await service.createMany(
      'org-1',
      'user-1',
      dto([
        { name: 'Paracetamol', unit: 'tablet' },
        { name: 'Ibuprofen', unit: 'tablet' },
      ]),
    );

    // Repeating a medicine without batch details is rejected ...
    expect(result.rows[0].status).toBe('FAILED');
    expect(result.rows[0].errors[0]).toContain('already exists');
    // ... but the remaining rows are unaffected.
    expect(result.rows[1].status).toBe('CREATED');
    expect(result.rows[1].medicineId).toBe('med-1');
    expect(result).toMatchObject({ totalRows: 2, created: 1, failed: 1 });
  });

  it('rejects an unknown supplier instead of writing a receipt', async () => {
    prismaMock.supplier.findMany.mockResolvedValue([]);

    const result = await service.createMany(
      'org-1',
      'user-1',
      dto([
        {
          name: 'Paracetamol',
          unit: 'tablet',
          batchNumber: 'B-1',
          quantity: 3,
          supplierId: 'supplier-other-org',
        },
      ]),
    );

    expect(result.rows[0].status).toBe('FAILED');
    expect(result.rows[0].errors[0]).toContain('supplier was not found');
    expect(txMock.stockReceipt.create).not.toHaveBeenCalled();
  });

  it('books the opening stock through a confirmed supplier receipt', async () => {
    prismaMock.supplier.findMany.mockResolvedValue([{ id: 'supplier-1' }]);

    const result = await service.createMany(
      'org-1',
      'user-1',
      dto([
        {
          name: 'Paracetamol',
          unit: 'tablet',
          batchNumber: 'B-1',
          quantity: 4,
          unitCost: 100,
          supplierId: 'supplier-1',
        },
      ]),
    );

    expect(result.rows[0].status).toBe('CREATED');
    expect(txMock.stockReceipt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ supplierId: 'supplier-1', status: 'DRAFT' }),
      }),
    );
    expect(txMock.stockReceipt.update).toHaveBeenCalledWith({
      where: { id: 'receipt-1' },
      data: { status: 'CONFIRMED' },
    });
    expect(txMock.stockMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'RECEIPT', idempotencyKey: 'bulk:receipt-1:line-1' }),
    });
  });

  it('rejects a batch row without a positive quantity', async () => {
    const result = await service.createMany(
      'org-1',
      'user-1',
      dto([{ name: 'Paracetamol', unit: 'tablet', batchNumber: 'B-1' }]),
    );

    expect(result.rows[0].status).toBe('FAILED');
    expect(result.rows[0].errors[0]).toContain('Quantity must be greater than zero');
    expect(txMock.product.create).not.toHaveBeenCalled();
  });

  it('rejects an expiry date that is not a real calendar date', async () => {
    const result = await service.createMany(
      'org-1',
      'user-1',
      dto([{ name: 'Paracetamol', unit: 'tablet', batchNumber: 'B-1', quantity: 1, expiryDate: '2099-02-31' }]),
    );

    expect(result.rows[0].status).toBe('FAILED');
    expect(result.rows[0].errors[0]).toContain('not a real calendar date');
  });

  it('rejects a SKU that already belongs to another medicine', async () => {
    prismaMock.product.findMany.mockResolvedValue([
      { id: 'med-1', name: 'Ibuprofen', unit: 'tablet', normalizedName: 'ibuprofen', sku: 'SKU-1' },
    ]);

    const result = await service.createMany(
      'org-1',
      'user-1',
      dto([{ name: 'Paracetamol', unit: 'tablet', sku: 'SKU-1' }]),
    );

    expect(result.rows[0].status).toBe('FAILED');
    expect(result.rows[0].errors[0]).toContain('SKU SKU-1 is already used');
  });

  it('warns about expired batches and loss-making prices without blocking the save', async () => {
    const result = await service.createMany(
      'org-1',
      'user-1',
      dto([
        {
          name: 'Paracetamol',
          unit: 'tablet',
          batchNumber: 'B-1',
          quantity: 6,
          unitCost: 100,
          sellingPrice: 50,
          expiryDate: '2020-01-01',
        },
      ]),
    );

    expect(result.rows[0].status).toBe('CREATED');
    expect(result.rows[0].warnings).toEqual([
      'This batch is already expired and cannot be sold.',
      'The selling price is below the purchase price.',
    ]);
  });

  it('reports the last row as the position of a failed row', async () => {
    const result = await service.createMany(
      'org-1',
      'user-1',
      dto([
        { name: 'Paracetamol', unit: 'tablet' },
        { name: 'Ibuprofen', unit: 'tablet' },
        { name: '', unit: 'tablet' },
      ]),
    );

    expect(result.rows.map((row) => row.status)).toEqual(['CREATED', 'CREATED', 'FAILED']);
    expect(result.rows[2].row).toBe(3);
    expect(result.rows[2].errors[0]).toContain('Medicine name is required');
  });
});

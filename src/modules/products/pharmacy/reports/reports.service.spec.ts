import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { ExpiryService } from '../expiry/expiry.service';
import { ReportsService } from './reports.service';

describe('ReportsService', () => {
  let service: ReportsService;

  const prismaMock = {
    product: { findMany: jest.fn() },
    batchBalance: { findMany: jest.fn() },
    organization: { findUnique: jest.fn() },
    branch: { findMany: jest.fn() },
    sale: { findMany: jest.fn() },
    saleReturn: { findMany: jest.fn() },
    stockMovement: { findMany: jest.fn() },
  };

  const expiryMock = {
    findNear: jest.fn(),
    findExpired: jest.fn(),
    findUnknown: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ExpiryService, useValue: expiryMock },
      ],
    }).compile();
    service = moduleRef.get(ReportsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('builds a dashboard summary', async () => {
    prismaMock.product.findMany.mockResolvedValue([]);
    prismaMock.batchBalance.findMany.mockResolvedValue([]);
    expiryMock.findNear.mockResolvedValue({ data: [] });
    expiryMock.findExpired.mockResolvedValue({ data: [] });
    expiryMock.findUnknown.mockResolvedValue({ data: [] });

    const summary = await service.getDashboard('org-1', ['branch-1'], 30);

    expect(summary.data.outOfStock).toBe(0);
    expect(summary.data.lowStock).toBe(0);
  });

  /**
   * Consolidated reporting only ever adds up branches it was given, and a
   * per-branch row only ever counts that branch's own sales and stock.
   */
  describe('getBranchComparison', () => {
    const dec = (value: number) => new Prisma.Decimal(value);

    beforeEach(() => {
      prismaMock.organization.findUnique.mockResolvedValue({
        timezone: 'Africa/Lagos',
        currency: 'NGN',
      });
      prismaMock.branch.findMany.mockResolvedValue([
        { id: 'branch-1', name: 'Main', code: 'MAIN', status: 'ACTIVE' },
        { id: 'branch-2', name: 'Ikeja', code: 'IKJ', status: 'ACTIVE' },
      ]);
      prismaMock.product.findMany.mockResolvedValue([]);
      prismaMock.sale.findMany.mockResolvedValue([
        {
          branchId: 'branch-1',
          revenue: dec(100),
          subtotal: dec(100),
          discountTotal: dec(0),
          unitCount: dec(2),
          costTotal: dec(60),
        },
        {
          branchId: 'branch-2',
          revenue: dec(250),
          subtotal: dec(250),
          discountTotal: dec(0),
          unitCount: dec(5),
          costTotal: dec(150),
        },
      ]);
      prismaMock.saleReturn.findMany.mockResolvedValue([
        { amount: dec(10), sale: { branchId: 'branch-1' } },
      ]);
      prismaMock.stockMovement.findMany.mockResolvedValue([
        { branchId: 'branch-1', type: 'TRANSFER_IN', quantityDelta: dec(5) },
        { branchId: 'branch-2', type: 'TRANSFER_OUT', quantityDelta: dec(-5) },
      ]);
      prismaMock.batchBalance.findMany.mockResolvedValue([
        {
          quantity: dec(10),
          batch: {
            branchId: 'branch-1',
            productId: 'product-1',
            unitCost: dec(2),
            expiryDate: new Date('2028-01-01T00:00:00.000Z'),
          },
        },
        {
          quantity: dec(4),
          batch: {
            branchId: 'branch-2',
            productId: 'product-1',
            unitCost: dec(3),
            expiryDate: new Date('2028-01-01T00:00:00.000Z'),
          },
        },
      ]);
    });

    it('keeps each branch on its own figures', async () => {
      const comparison = await service.getBranchComparison('org-1', [
        'branch-1',
        'branch-2',
      ]);

      const [main, ikeja] = comparison.data.branches;
      expect(main.sales).toMatchObject({ transactions: 1, revenue: 100, netSales: 90 });
      expect(main.stock).toMatchObject({ quantity: 10, value: 20 });
      expect(main.movements.transferredIn).toBe(5);

      expect(ikeja.sales).toMatchObject({ transactions: 1, revenue: 250, netSales: 250 });
      expect(ikeja.stock).toMatchObject({ quantity: 4, value: 12 });
      expect(ikeja.movements.transferredOut).toBe(5);
    });

    it('adds the branches into organisation totals', async () => {
      const comparison = await service.getBranchComparison('org-1', [
        'branch-1',
        'branch-2',
      ]);

      expect(comparison.data.totals.sales.revenue).toBe(350);
      expect(comparison.data.totals.sales.netSales).toBe(340);
      expect(comparison.data.totals.stock.quantity).toBe(14);
      expect(comparison.data.consolidated).toBe(true);
    });

    it('marks a single-branch view as not consolidated', async () => {
      prismaMock.branch.findMany.mockResolvedValue([
        { id: 'branch-1', name: 'Main', code: 'MAIN', status: 'ACTIVE' },
      ]);

      const comparison = await service.getBranchComparison('org-1', ['branch-1']);

      expect(comparison.data.consolidated).toBe(false);
      expect(comparison.data.branches).toHaveLength(1);
      expect(comparison.data.branches[0].stock.quantity).toBe(10);
    });

    it('only asks the database for the branches in scope of the organisation', async () => {
      await service.getBranchComparison('org-1', ['branch-1']);

      expect(prismaMock.branch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org-1', id: { in: ['branch-1'] } },
        }),
      );
      expect(prismaMock.sale.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org-1',
            branchId: { in: ['branch-1'] },
          }),
        }),
      );
      expect(prismaMock.batchBalance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org-1', batch: { branchId: { in: ['branch-1'] } } },
        }),
      );
    });
  });
});

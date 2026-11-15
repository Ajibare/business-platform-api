import { Test } from '@nestjs/testing';
import { PrismaService } from '../../../../database/prisma.service';
import { ExpiryService } from '../expiry/expiry.service';
import { ReportsService } from './reports.service';

describe('ReportsService', () => {
  let service: ReportsService;

  const prismaMock = {
    product: { findMany: jest.fn() },
    batchBalance: { findMany: jest.fn() },
  };

  const expiryMock = {
    findNear: jest.fn(),
    findExpired: jest.fn(),
    findUnknown: jest.fn(),
  };

  beforeEach(async () => {
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

    const summary = await service.getDashboard('org-1', 30);

    expect(summary.data.outOfStock).toBe(0);
    expect(summary.data.lowStock).toBe(0);
  });
});

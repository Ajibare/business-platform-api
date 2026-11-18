import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BranchStatus, MembershipStatus, Role } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { BranchAccessService, type RequestActor } from './branch-access.service';
import { BranchesService } from './branches.service';

/**
 * Branch management for one organisation. Every case here runs against the
 * organisation in the actor, so a branch of another pharmacy is simply not
 * found rather than refused.
 */
describe('BranchesService', () => {
  let service: BranchesService;

  const prismaMock = {
    branch: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    branchStaff: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
      upsert: jest.fn(),
    },
    membership: { findUnique: jest.fn(), findMany: jest.fn() },
    batchBalance: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };

  const branchAccessMock = {
    allowedBranchIds: jest.fn(),
    assertAccess: jest.fn(),
  };

  const auditMock = { record: jest.fn() };

  const actor: RequestActor = {
    userId: 'owner-1',
    organizationId: 'org-1',
    role: Role.OWNER,
    permissions: new Set(['branch:all', 'branch:manage']),
  };

  function branchRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'b1',
      organizationId: 'org-1',
      name: 'Main',
      code: 'MAIN',
      address: null,
      phone: null,
      email: null,
      status: BranchStatus.ACTIVE,
      isDefault: true,
      managerUserId: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      manager: null,
      _count: { staff: 0, batches: 0 },
      ...overrides,
    };
  }

  const rejection = async (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: unknown) => error,
    );

  beforeEach(async () => {
    jest.resetAllMocks();
    branchAccessMock.allowedBranchIds.mockResolvedValue(['b1']);
    branchAccessMock.assertAccess.mockResolvedValue(undefined);
    prismaMock.batchBalance.findMany.mockResolvedValue([]);
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(prismaMock),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        BranchesService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: BranchAccessService, useValue: branchAccessMock },
        { provide: AuditService, useValue: auditMock },
      ],
    }).compile();
    service = moduleRef.get(BranchesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('normalises the code and rejects one already used in the organisation', async () => {
      prismaMock.branch.findFirst.mockResolvedValue({ id: 'b9', code: 'MAIN' });

      const error = await rejection(
        service.create(actor, { name: 'Second', code: ' main ' }),
      );

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'BRANCH_CODE_TAKEN',
        field: 'code',
      });
      expect(prismaMock.branch.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: 'org-1', code: 'MAIN' }),
        }),
      );
      expect(prismaMock.branch.create).not.toHaveBeenCalled();
    });

    it('makes the first branch the default so single-branch keeps working', async () => {
      prismaMock.branch.findFirst.mockResolvedValue(null);
      prismaMock.branch.count.mockResolvedValue(0);
      prismaMock.branch.create.mockResolvedValue(branchRow());

      const created = await service.create(actor, { name: ' Main ', code: 'main' });

      expect(prismaMock.branch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ code: 'MAIN', name: 'Main', isDefault: true }),
        }),
      );
      expect(created.data).toMatchObject({ code: 'MAIN', isDefault: true });
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'BRANCH_CREATED', branchId: 'b1' }),
      );
    });

    it('does not steal the default from the existing branch', async () => {
      prismaMock.branch.findFirst.mockResolvedValue(null);
      prismaMock.branch.count.mockResolvedValue(2);
      prismaMock.branch.create.mockResolvedValue(branchRow({ id: 'b2', isDefault: false }));

      await service.create(actor, { name: 'Ikeja', code: 'IKJ' });

      expect(prismaMock.branch.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isDefault: false }),
        }),
      );
    });

    it('refuses a manager who is not an active member of the organisation', async () => {
      prismaMock.branch.findFirst.mockResolvedValue(null);
      prismaMock.membership.findUnique.mockResolvedValue(null);

      const error = await rejection(
        service.create(actor, { name: 'Ikeja', code: 'IKJ', managerUserId: 'stranger' }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'INVALID_STAFF',
      });
      expect(prismaMock.membership.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId_userId: { organizationId: 'org-1', userId: 'stranger' },
          },
        }),
      );
    });
  });

  describe('findOne', () => {
    it('does not see a branch that belongs to another organisation', async () => {
      prismaMock.branch.findFirst.mockResolvedValue(null);

      const error = await rejection(service.findOne(actor, 'foreign-branch'));

      expect(error).toBeInstanceOf(NotFoundException);
      expect(prismaMock.branch.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'foreign-branch', organizationId: 'org-1' },
        }),
      );
    });

    it('reports stock per branch instead of adding branches together', async () => {
      prismaMock.branch.findFirst.mockResolvedValue(branchRow());
      prismaMock.branchStaff.findMany.mockResolvedValue([]);
      prismaMock.batchBalance.findMany.mockResolvedValue([
        { quantity: 12, batch: { branchId: 'b1' } },
        { quantity: 8, batch: { branchId: 'b1' } },
      ]);

      const detail = await service.findOne(actor, 'b1');

      expect(detail.data.stockUnits).toBe(20);
      expect(prismaMock.batchBalance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org-1', batch: { branchId: { in: ['b1'] } } },
        }),
      );
    });
  });

  describe('setStatus', () => {
    it('keeps at least one branch active', async () => {
      prismaMock.branch.findFirst.mockResolvedValue(branchRow());
      prismaMock.branch.count.mockResolvedValue(1);

      const error = await rejection(service.setStatus(actor, 'b1', BranchStatus.INACTIVE));

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'LAST_ACTIVE_BRANCH',
      });
      expect(prismaMock.branch.update).not.toHaveBeenCalled();
    });

    it('deactivates a branch when another stays active', async () => {
      prismaMock.branch.findFirst.mockResolvedValue(branchRow());
      prismaMock.branch.count.mockResolvedValue(2);
      prismaMock.branch.update.mockResolvedValue(
        branchRow({ status: BranchStatus.INACTIVE }),
      );

      const updated = await service.setStatus(actor, 'b1', BranchStatus.INACTIVE);

      expect(updated.data.status).toBe(BranchStatus.INACTIVE);
      expect(auditMock.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'BRANCH_DEACTIVATED' }),
      );
    });
  });

  describe('assignStaff', () => {
    it('refuses people who are not active members of this organisation', async () => {
      prismaMock.branch.findFirst.mockResolvedValue({
        id: 'b1',
        status: BranchStatus.ACTIVE,
        name: 'Main',
      });
      prismaMock.membership.findMany.mockResolvedValue([]);

      const error = await rejection(
        service.assignStaff(actor, 'b1', { userIds: ['user-9'] }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'INVALID_STAFF',
      });
      expect(prismaMock.branchStaff.deleteMany).not.toHaveBeenCalled();
    });

    it('replaces the assignment list, removing anyone left out', async () => {
      prismaMock.branch.findFirst.mockResolvedValue({
        id: 'b1',
        status: BranchStatus.ACTIVE,
        name: 'Main',
      });
      prismaMock.membership.findMany.mockResolvedValue([
        { userId: 'user-1' },
        { userId: 'user-2' },
      ]);

      const result = await service.assignStaff(actor, 'b1', {
        userIds: ['user-1', 'user-2'],
      });

      expect(result.data).toEqual({ branchId: 'b1', userIds: ['user-1', 'user-2'] });
      expect(prismaMock.branchStaff.deleteMany).toHaveBeenCalledWith({
        where: { branchId: 'b1', userId: { notIn: ['user-1', 'user-2'] } },
      });
      expect(prismaMock.branchStaff.createMany).toHaveBeenCalledWith({
        data: [
          { branchId: 'b1', userId: 'user-1' },
          { branchId: 'b1', userId: 'user-2' },
        ],
        skipDuplicates: true,
      });
    });

    it('refuses to assign anyone to an inactive branch', async () => {
      prismaMock.branch.findFirst.mockResolvedValue({
        id: 'b1',
        status: BranchStatus.INACTIVE,
        name: 'Main',
      });

      const error = await rejection(
        service.assignStaff(actor, 'b1', { userIds: ['user-1'] }),
      );

      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'BRANCH_INACTIVE',
      });
    });
  });

  describe('removeStaff', () => {
    it('clears the manager when the manager is the person removed', async () => {
      prismaMock.branch.findFirst.mockResolvedValue({
        id: 'b1',
        managerUserId: 'user-1',
      });

      await service.removeStaff(actor, 'b1', 'user-1');

      expect(prismaMock.branchStaff.deleteMany).toHaveBeenCalledWith({
        where: { branchId: 'b1', userId: 'user-1' },
      });
      expect(prismaMock.branch.update).toHaveBeenCalledWith({
        where: { id: 'b1' },
        data: { managerUserId: null },
      });
    });

    it('leaves the manager untouched when someone else is removed', async () => {
      prismaMock.branch.findFirst.mockResolvedValue({
        id: 'b1',
        managerUserId: 'user-1',
      });

      await service.removeStaff(actor, 'b1', 'user-2');

      expect(prismaMock.branch.update).not.toHaveBeenCalled();
    });
  });

  describe('assignManager', () => {
    it('assigns the manager to the branch as well', async () => {
      prismaMock.branch.findFirst.mockResolvedValue({ id: 'b1' });
      prismaMock.membership.findUnique.mockResolvedValue({
        active: true,
        status: MembershipStatus.ACTIVE,
      });
      prismaMock.branch.update.mockResolvedValue(branchRow({ managerUserId: 'user-1' }));

      const updated = await service.assignManager(actor, 'b1', 'user-1');

      expect(prismaMock.branchStaff.upsert).toHaveBeenCalledWith({
        where: { branchId_userId: { branchId: 'b1', userId: 'user-1' } },
        create: { branchId: 'b1', userId: 'user-1' },
        update: {},
      });
      expect(updated.data.managerUserId).toBe('user-1');
    });
  });
});

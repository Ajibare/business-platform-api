import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { PermissionKey } from '../permissions/permission-catalogue';
import {
  ALL_BRANCHES,
  BranchAccessService,
  type RequestActor,
} from './branch-access.service';

/**
 * The branch hint a page sends is only ever a request. These tests pin down the
 * server side of that contract: a hint is honoured when it is inside the
 * member's assignments, refused when it is not, and the organisation always
 * comes from the token rather than the request.
 */
describe('BranchAccessService', () => {
  let service: BranchAccessService;

  const prismaMock = {
    membership: { findUnique: jest.fn() },
    user: { findUnique: jest.fn() },
    branch: { findMany: jest.fn(), findFirst: jest.fn() },
    branchStaff: { findMany: jest.fn() },
  };

  const permissionsMock = {
    getEffectivePermissions: jest.fn(),
  };

  const actor = (
    permissions: PermissionKey[],
    overrides: Partial<RequestActor> = {},
  ): RequestActor => ({
    userId: 'user-1',
    organizationId: 'org-1',
    role: Role.PHARMACIST,
    permissions: new Set(permissions),
    ...overrides,
  });

  /** Assignments for a member without organisation-wide access. */
  const assignedTo = (...branchIds: string[]) => {
    prismaMock.branchStaff.findMany.mockResolvedValue(
      branchIds.map((branchId) => ({ branchId })),
    );
  };

  const expectCode = async (
    promise: Promise<unknown>,
    status: number,
    code: string,
  ): Promise<void> => {
    const error = await promise.then(
      () => null,
      (rejection: unknown) => rejection,
    );
    expect(error).toBeInstanceOf(Error);
    const exception = error as ForbiddenException;
    expect(exception.getStatus()).toBe(status);
    expect(exception.getResponse()).toMatchObject({ code });
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        BranchAccessService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: PermissionsService, useValue: permissionsMock },
      ],
    }).compile();
    service = moduleRef.get(BranchAccessService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('resolveActor', () => {
    it('takes the organisation from the token, never from the request body', async () => {
      prismaMock.membership.findUnique.mockResolvedValue({
        role: Role.CASHIER,
        active: true,
      });
      prismaMock.user.findUnique.mockResolvedValue({ status: UserStatus.ACTIVE });
      permissionsMock.getEffectivePermissions.mockResolvedValue(
        new Set<PermissionKey>(['sale:record']),
      );

      const resolved = await service.resolveActor({
        user: { sub: 'user-1', organisationId: 'org-token' },
        organisationId: 'org-forged',
      });

      expect(prismaMock.membership.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId_userId: { organizationId: 'org-token', userId: 'user-1' },
          },
        }),
      );
      expect(resolved.organizationId).toBe('org-token');
    });

    it('refuses a request without an organisation claim', async () => {
      await expectCode(
        service.resolveActor({ user: { sub: 'user-1' } }),
        403,
        'FORBIDDEN',
      );
      expect(prismaMock.membership.findUnique).not.toHaveBeenCalled();
    });

    it('refuses an organisation the member does not belong to', async () => {
      // The organisation may come from the guard-set claim, but membership is
      // still checked, so a claim pointing at another pharmacy gets nothing.
      prismaMock.membership.findUnique.mockResolvedValue(null);
      prismaMock.user.findUnique.mockResolvedValue({ status: UserStatus.ACTIVE });

      await expectCode(
        service.resolveActor({ user: { sub: 'user-1' }, organisationId: 'other-org' }),
        403,
        'FORBIDDEN',
      );
      expect(permissionsMock.getEffectivePermissions).not.toHaveBeenCalled();
    });

    it('refuses an inactive membership', async () => {
      prismaMock.membership.findUnique.mockResolvedValue({
        role: Role.PHARMACIST,
        active: false,
      });
      prismaMock.user.findUnique.mockResolvedValue({ status: UserStatus.ACTIVE });

      await expectCode(
        service.resolveActor({ user: { sub: 'user-1', organisationId: 'org-1' } }),
        403,
        'FORBIDDEN',
      );
    });

    it('refuses a suspended account', async () => {
      prismaMock.membership.findUnique.mockResolvedValue({
        role: Role.PHARMACIST,
        active: true,
      });
      prismaMock.user.findUnique.mockResolvedValue({ status: UserStatus.SUSPENDED });

      await expectCode(
        service.resolveActor({ user: { sub: 'user-1', organisationId: 'org-1' } }),
        403,
        'ACCOUNT_INACTIVE',
      );
    });
  });

  describe('allowedBranchIds', () => {
    it('returns every organisation branch for organisation-wide members', async () => {
      prismaMock.branch.findMany.mockResolvedValue([{ id: 'b1' }, { id: 'b2' }]);

      const ids = await service.allowedBranchIds(actor(['branch:all']));

      expect(ids).toEqual(['b1', 'b2']);
      expect(prismaMock.branch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: 'org-1' } }),
      );
      expect(prismaMock.branchStaff.findMany).not.toHaveBeenCalled();
    });

    it('returns only the assignments and stays inside the organisation', async () => {
      assignedTo('b1');

      const ids = await service.allowedBranchIds(actor(['sale:record']));

      expect(ids).toEqual(['b1']);
      expect(prismaMock.branchStaff.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user-1',
            branch: { organizationId: 'org-1' },
          },
        }),
      );
    });
  });

  describe('resolveScope', () => {
    it('honours a branch the member is assigned to', async () => {
      assignedTo('b1', 'b2');

      const scope = await service.resolveScope(actor(['sale:record']), 'b2');

      expect(scope).toMatchObject({
        branchId: 'b2',
        branchIds: ['b2'],
        consolidated: false,
        organisationWide: false,
      });
    });

    it('refuses a branch the member is not assigned to', async () => {
      assignedTo('b1');

      await expectCode(
        service.resolveScope(actor(['sale:record']), 'b2'),
        403,
        'BRANCH_FORBIDDEN',
      );
    });

    it('refuses a branch belonging to another organisation', async () => {
      // The assignment query only returns branches inside the actor's
      // organisation, so a foreign id can never appear in the allowed list.
      assignedTo();

      await expectCode(
        service.resolveScope(actor(['sale:record']), 'other-org-branch'),
        403,
        'BRANCH_FORBIDDEN',
      );
    });

    it('allows consolidation for organisation-wide members', async () => {
      prismaMock.branch.findMany.mockResolvedValue([{ id: 'b1' }, { id: 'b2' }]);

      const scope = await service.resolveScope(actor(['branch:all']), ALL_BRANCHES);

      expect(scope).toMatchObject({
        branchId: null,
        branchIds: ['b1', 'b2'],
        consolidated: true,
        organisationWide: true,
      });
    });

    it('allows consolidation across several assignments', async () => {
      assignedTo('b1', 'b2');

      const scope = await service.resolveScope(actor(['sale:read']), ALL_BRANCHES);

      expect(scope.consolidated).toBe(true);
      expect(scope.branchIds).toEqual(['b1', 'b2']);
    });

    it('refuses consolidation for a member with a single branch', async () => {
      assignedTo('b1');

      await expectCode(
        service.resolveScope(actor(['sale:read']), ALL_BRANCHES),
        403,
        'BRANCH_FORBIDDEN',
      );
    });

    it('falls back to the default branch when no branch was requested', async () => {
      assignedTo('b1', 'b2');
      prismaMock.branch.findFirst.mockResolvedValue({ id: 'b2' });

      const scope = await service.resolveScope(actor(['sale:record']));

      expect(scope.branchId).toBe('b2');
      expect(scope.branchIds).toEqual(['b2']);
      expect(scope.consolidated).toBe(false);
    });

    it('falls back to a reachable branch when the default is not assigned', async () => {
      assignedTo('b1');
      prismaMock.branch.findFirst.mockResolvedValue({ id: 'b2' });

      const scope = await service.resolveScope(actor(['sale:record']));

      expect(scope.branchId).toBe('b1');
    });

    it('leaves the scope empty when the member has no branch at all', async () => {
      assignedTo();

      const scope = await service.resolveScope(actor(['sale:record']));

      expect(scope.branchId).toBeNull();
      expect(scope.branchIds).toEqual([]);
    });
  });

  describe('writableBranchId', () => {
    it('refuses a consolidated scope, because a write needs one branch', async () => {
      await expectCode(
        service.writableBranchId(actor(['sale:record']), {
          branchId: null,
          branchIds: ['b1', 'b2'],
          allowedBranchIds: ['b1', 'b2'],
          consolidated: true,
          organisationWide: true,
        }),
        403,
        'BRANCH_REQUIRED',
      );
    });

    it('refuses an inactive branch', async () => {
      prismaMock.branch.findFirst.mockResolvedValue({ status: 'INACTIVE' });

      await expectCode(
        service.writableBranchId(actor(['sale:record']), {
          branchId: 'b1',
          branchIds: ['b1'],
          allowedBranchIds: ['b1'],
          consolidated: false,
          organisationWide: false,
        }),
        403,
        'BRANCH_INACTIVE',
      );
    });

    it('returns the branch when it is active in the organisation', async () => {
      prismaMock.branch.findFirst.mockResolvedValue({ status: 'ACTIVE' });

      const branchId = await service.writableBranchId(actor(['sale:record']), {
        branchId: 'b1',
        branchIds: ['b1'],
        allowedBranchIds: ['b1'],
        consolidated: false,
        organisationWide: false,
      });

      expect(branchId).toBe('b1');
      expect(prismaMock.branch.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'b1', organizationId: 'org-1' },
        }),
      );
    });
  });

  describe('requestedBranch', () => {
    it('prefers the header over the query parameter', () => {
      const value = service.requestedBranch({
        headers: { 'x-branch-id': 'b1' },
        query: { branchId: 'b2' },
      });
      expect(value).toBe('b1');
    });

    it('reads the query parameter when no header is present', () => {
      expect(service.requestedBranch({ query: { branchId: 'b2' } })).toBe('b2');
    });

    it('returns null when nothing was requested', () => {
      expect(service.requestedBranch({ headers: {}, query: {} })).toBeNull();
    });
  });

  describe('scopeFor', () => {
    it('reuses the scope a guard already resolved', async () => {
      const cached = {
        branchId: 'b1',
        branchIds: ['b1'],
        allowedBranchIds: ['b1'],
        consolidated: false,
        organisationWide: false,
      };

      const scope = await service.scopeFor({ branchScope: cached });

      expect(scope).toBe(cached);
      expect(prismaMock.membership.findUnique).not.toHaveBeenCalled();
    });
  });
});

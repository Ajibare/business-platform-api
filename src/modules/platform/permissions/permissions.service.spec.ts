import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PermissionEffect, Role } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { PERMISSION_KEYS } from './permission-catalogue';
import { PermissionsService } from './permissions.service';

/**
 * Permissions are the access control, so the resolution order matters: the
 * role's set comes first, the member's personal grants and denials are applied
 * on top, and the owner can never be locked out.
 */
describe('PermissionsService', () => {
  let service: PermissionsService;

  const prismaMock = {
    rolePermission: {
      count: jest.fn(),
      findMany: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    memberPermission: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: unknown) => Promise<unknown>) => callback(prismaMock),
    );
    prismaMock.rolePermission.count.mockResolvedValue(1);
    prismaMock.rolePermission.createMany.mockResolvedValue({ count: 0 });
    prismaMock.memberPermission.createMany.mockResolvedValue({ count: 0 });

    const moduleRef = await Test.createTestingModule({
      providers: [PermissionsService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();
    service = moduleRef.get(PermissionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getEffectivePermissions', () => {
    it('gives the owner the whole catalogue without reading the database', async () => {
      const permissions = await service.getEffectivePermissions(
        'org-1',
        'user-1',
        Role.OWNER,
      );

      expect(permissions.size).toBe(PERMISSION_KEYS.length);
      expect(permissions.has('staff:permissions')).toBe(true);
      expect(prismaMock.rolePermission.findMany).not.toHaveBeenCalled();
    });

    it('applies a personal grant on top of the role', async () => {
      prismaMock.rolePermission.findMany.mockResolvedValue([
        { permission: 'product:read' },
        { permission: 'sale:read' },
      ]);
      prismaMock.memberPermission.findMany.mockResolvedValue([
        { permission: 'inventory:read', effect: PermissionEffect.GRANT },
      ]);

      const permissions = await service.getEffectivePermissions(
        'org-1',
        'user-1',
        Role.CASHIER,
      );

      expect(permissions.has('product:read')).toBe(true);
      expect(permissions.has('inventory:read')).toBe(true);
    });

    it('lets a personal denial remove a permission the role allows', async () => {
      prismaMock.rolePermission.findMany.mockResolvedValue([
        { permission: 'product:read' },
        { permission: 'sale:void' },
      ]);
      prismaMock.memberPermission.findMany.mockResolvedValue([
        { permission: 'sale:void', effect: PermissionEffect.DENY },
      ]);

      const permissions = await service.getEffectivePermissions(
        'org-1',
        'user-1',
        Role.PHARMACIST,
      );

      expect(permissions.has('product:read')).toBe(true);
      expect(permissions.has('sale:void')).toBe(false);
    });

    it('ignores rows that are not in the catalogue', async () => {
      prismaMock.rolePermission.findMany.mockResolvedValue([
        { permission: 'product:read' },
        { permission: 'made:up' },
      ]);
      prismaMock.memberPermission.findMany.mockResolvedValue([]);

      const permissions = await service.getEffectivePermissions(
        'org-1',
        'user-1',
        Role.PHARMACIST,
      );

      expect([...permissions]).toEqual(['product:read']);
    });
  });

  describe('setRolePermissions', () => {
    it('refuses to edit the owner role', async () => {
      const error = await service
        .setRolePermissions('org-1', Role.OWNER, ['branch:all'])
        .then(
          () => null,
          (rejection: unknown) => rejection,
        );

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(prismaMock.rolePermission.deleteMany).not.toHaveBeenCalled();
    });

    it('replaces the role set and drops unknown keys', async () => {
      await service.setRolePermissions('org-1', Role.CASHIER, [
        'sale:record',
        'sale:record',
        'not:a:permission',
      ]);

      expect(prismaMock.rolePermission.deleteMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', role: Role.CASHIER },
      });
      expect(prismaMock.rolePermission.createMany).toHaveBeenCalledWith({
        data: [{ organizationId: 'org-1', role: Role.CASHIER, permission: 'sale:record' }],
        skipDuplicates: true,
      });
    });
  });

  describe('ensureRoleDefaults', () => {
    it('seeds the catalogue the first time the organisation is seen', async () => {
      prismaMock.rolePermission.count.mockResolvedValue(0);

      await service.ensureRoleDefaults('org-1');

      expect(prismaMock.rolePermission.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicates: true }),
      );
      const seeded = prismaMock.rolePermission.createMany.mock.calls[0][0].data as {
        permission: string;
      }[];
      expect(seeded.some((row) => row.permission === 'branch:all')).toBe(true);
    });

    it('never re-seeds over an administrator who emptied a role', async () => {
      prismaMock.rolePermission.count.mockResolvedValue(3);

      await service.ensureRoleDefaults('org-1');

      expect(prismaMock.rolePermission.createMany).not.toHaveBeenCalled();
    });
  });

  describe('setMemberOverrides', () => {
    it('keeps a grant when the same key is also denied', async () => {
      prismaMock.memberPermission.findMany.mockResolvedValue([
        { permission: 'inventory:adjust', effect: PermissionEffect.GRANT },
      ]);

      await service.setMemberOverrides('org-1', 'user-1', {
        grants: ['inventory:adjust'],
        denies: ['inventory:adjust', 'sale:void'],
      });

      expect(prismaMock.memberPermission.deleteMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', userId: 'user-1' },
      });
      const rows = prismaMock.memberPermission.createMany.mock.calls[0][0].data as {
        permission: string;
        effect: PermissionEffect;
      }[];
      expect(rows).toEqual([
        {
          organizationId: 'org-1',
          userId: 'user-1',
          permission: 'inventory:adjust',
          effect: PermissionEffect.GRANT,
        },
        {
          organizationId: 'org-1',
          userId: 'user-1',
          permission: 'sale:void',
          effect: PermissionEffect.DENY,
        },
      ]);
    });

    it('clears every override when nothing is sent', async () => {
      prismaMock.memberPermission.findMany.mockResolvedValue([]);

      await service.setMemberOverrides('org-1', 'user-1', {});

      expect(prismaMock.memberPermission.deleteMany).toHaveBeenCalled();
      expect(prismaMock.memberPermission.createMany).not.toHaveBeenCalled();
    });
  });

  describe('describe', () => {
    it('marks the owner as the only non-editable role', () => {
      const catalogue = service.describe().data;

      const editable = catalogue.roles.filter((role) => role.editable).map((role) => role.role);
      expect(editable).not.toContain(Role.OWNER);
      expect(catalogue.permissions.length).toBe(PERMISSION_KEYS.length);
    });
  });
});

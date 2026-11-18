import { ForbiddenException, Injectable } from '@nestjs/common';
import { PermissionEffect, Role } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import {
  isPermissionKey,
  PERMISSION_CATALOGUE,
  PERMISSION_KEYS,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_LABELS,
  sanitisePermissions,
  type PermissionKey,
} from './permission-catalogue';

export interface RolePermissions {
  role: Role;
  label: string;
  /** The owner role always holds every permission and cannot be edited. */
  editable: boolean;
  permissions: string[];
}

export interface MemberOverride {
  permission: string;
  effect: PermissionEffect;
}

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The catalogue plus the default set of each role, for the permissions screen. */
  describe() {
    return {
      data: {
        permissions: PERMISSION_CATALOGUE,
        roles: (Object.values(Role) as Role[]).map((role) => ({
          role,
          label: ROLE_LABELS[role],
          editable: role !== Role.OWNER,
          defaults: [...ROLE_DEFAULT_PERMISSIONS[role]],
        })),
      },
    };
  }

  /**
   * Copies the catalogue defaults into the organisation the first time they are
   * needed. Guarded by an organisation-wide count so an administrator who
   * deliberately empties one role is never overruled by a re-seed.
   */
  async ensureRoleDefaults(organizationId: string): Promise<void> {
    const existing = await this.prisma.rolePermission.count({ where: { organizationId } });
    if (existing > 0) return;

    const data = (Object.entries(ROLE_DEFAULT_PERMISSIONS) as [Role, readonly PermissionKey[]][]).flatMap(
      ([role, permissions]) =>
        permissions.map((permission) => ({ organizationId, role, permission })),
    );

    if (data.length === 0) return;
    await this.prisma.rolePermission.createMany({ data, skipDuplicates: true });
  }

  async getRoleMatrix(organizationId: string): Promise<{ data: RolePermissions[] }> {
    await this.ensureRoleDefaults(organizationId);

    const rows = await this.prisma.rolePermission.findMany({
      where: { organizationId },
      select: { role: true, permission: true },
    });

    const byRole = new Map<Role, string[]>();
    for (const row of rows) {
      const bucket = byRole.get(row.role);
      if (bucket) bucket.push(row.permission);
      else byRole.set(row.role, [row.permission]);
    }

    return {
      data: (Object.values(Role) as Role[]).map((role) => ({
        role,
        label: ROLE_LABELS[role],
        editable: role !== Role.OWNER,
        permissions: (role === Role.OWNER ? [...PERMISSION_KEYS] : (byRole.get(role) ?? [])).sort(),
      })),
    };
  }

  /** Replaces the permission set of a role. Unknown keys are dropped. */
  async setRolePermissions(
    organizationId: string,
    role: Role,
    permissions: readonly string[],
  ): Promise<{ data: { role: Role; permissions: string[] } }> {
    if (role === Role.OWNER) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'The owner role always keeps every permission and cannot be edited.',
      });
    }

    await this.ensureRoleDefaults(organizationId);
    const sanitised = sanitisePermissions(permissions);

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { organizationId, role } });
      if (sanitised.length > 0) {
        await tx.rolePermission.createMany({
          data: sanitised.map((permission) => ({ organizationId, role, permission })),
          skipDuplicates: true,
        });
      }
    });

    return { data: { role, permissions: [...sanitised].sort() } };
  }

  async getMemberOverrides(
    organizationId: string,
    userId: string,
  ): Promise<{ data: MemberOverride[] }> {
    const rows = await this.prisma.memberPermission.findMany({
      where: { organizationId, userId },
      select: { permission: true, effect: true },
      orderBy: { permission: 'asc' },
    });
    return { data: rows };
  }

  /**
   * Replaces a member's personal grants and denials. A grant adds one
   * permission on top of the role; a denial removes one the role would allow.
   */
  async setMemberOverrides(
    organizationId: string,
    userId: string,
    input: { grants?: readonly string[]; denies?: readonly string[] },
  ): Promise<{ data: MemberOverride[] }> {
    const grants = sanitisePermissions(input.grants ?? []);
    const denies = sanitisePermissions(input.denies ?? []).filter((key) => !grants.includes(key));

    const data = [
      ...grants.map((permission) => ({
        organizationId,
        userId,
        permission,
        effect: PermissionEffect.GRANT,
      })),
      ...denies.map((permission) => ({
        organizationId,
        userId,
        permission,
        effect: PermissionEffect.DENY,
      })),
    ];

    await this.prisma.$transaction(async (tx) => {
      await tx.memberPermission.deleteMany({ where: { organizationId, userId } });
      if (data.length > 0) {
        await tx.memberPermission.createMany({ data, skipDuplicates: true });
      }
    });

    return this.getMemberOverrides(organizationId, userId);
  }

  /**
   * The permissions a member actually holds: their role's set with the
   * member's personal grants and denials applied on top.
   *
   * The owner is resolved to the full catalogue without touching the database,
   * so an organisation can never lock its owner out.
   */
  async getEffectivePermissions(
    organizationId: string,
    userId: string,
    role: Role,
  ): Promise<Set<PermissionKey>> {
    if (role === Role.OWNER) {
      return new Set<PermissionKey>(PERMISSION_KEYS);
    }

    await this.ensureRoleDefaults(organizationId);

    const [roleRows, overrides] = await Promise.all([
      this.prisma.rolePermission.findMany({
        where: { organizationId, role },
        select: { permission: true },
      }),
      this.prisma.memberPermission.findMany({
        where: { organizationId, userId },
        select: { permission: true, effect: true },
      }),
    ]);

    const effective = new Set<PermissionKey>();
    for (const row of roleRows) {
      if (isPermissionKey(row.permission)) effective.add(row.permission);
    }

    for (const override of overrides) {
      if (!isPermissionKey(override.permission)) continue;
      if (override.effect === PermissionEffect.DENY) effective.delete(override.permission);
      else effective.add(override.permission);
    }

    return effective;
  }

  /**
   * Copy the role defaults into a brand new organisation. Called when a
   * pharmacy is registered so the matrix exists before anyone opens it.
   */
  async seedForNewOrganisation(organizationId: string): Promise<void> {
    await this.ensureRoleDefaults(organizationId);
  }
}

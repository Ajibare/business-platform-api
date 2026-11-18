import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BranchStatus, MembershipStatus, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../permissions/permissions.service';
import { BranchAccessService, type RequestActor } from '../branches/branch-access.service';
import { ASSIGNABLE_ROLES, StaffListQueryDto, UpdateStaffDto } from './dto/staff.dto';

export interface StaffBranchSummary {
  id: string;
  name: string;
  code: string;
}

export interface StaffRecord {
  userId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: Role;
  status: MembershipStatus;
  statusReason: string | null;
  active: boolean;
  lastLoginAt: Date | null;
  branches: StaffBranchSummary[];
  joinedAt: Date;
  updatedAt: Date;
}

export interface StaffDetailRecord extends StaffRecord {
  permissions: string[];
  permissionOverrides: { permission: string; effect: string }[];
  managedBranchIds: string[];
}

const STAFF_SELECT = {
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      lastLoginAt: true,
      status: true,
      branchAssignments: {
        select: { branch: { select: { id: true, name: true, code: true } } },
        orderBy: { branch: { name: 'asc' as const } },
      },
      managedBranches: { select: { id: true } },
    },
  },
} satisfies Prisma.MembershipSelect;

type MembershipWithUser = Prisma.MembershipGetPayload<{ select: typeof STAFF_SELECT }>;

/**
 * Staff management.
 *
 * Everything here is scoped to one organisation read from the token, never from
 * the request. A membership row is the source of truth for access, so
 * suspending or removing someone ends their access on the next request without
 * deleting the history they created.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
    private readonly branchAccess: BranchAccessService,
    private readonly auditService: AuditService,
  ) {}

  async findAll(actor: RequestActor, query: StaffListQueryDto): Promise<{ data: StaffRecord[] }> {
    const search = query.search?.trim();
    const where: Prisma.MembershipWhereInput = {
      organizationId: actor.organizationId,
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.branchId
        ? { user: { branchAssignments: { some: { branchId: query.branchId } } } }
        : {}),
      ...(search
        ? {
            user: {
              ...(query.branchId
                ? { branchAssignments: { some: { branchId: query.branchId } } }
                : {}),
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { email: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const memberships = await this.prisma.membership.findMany({
      where,
      select: { ...STAFF_SELECT, role: true, status: true, statusReason: true, active: true, createdAt: true, updatedAt: true },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(Math.max(query.limit ?? 100, 1), 200),
    });

    return { data: memberships.map((membership) => this.toRecord(membership)) };
  }

  async findOne(actor: RequestActor, userId: string): Promise<{ data: StaffDetailRecord }> {
    const membership = await this.requireMembership(actor.organizationId, userId);
    const [effective, overrides] = await Promise.all([
      this.permissionsService.getEffectivePermissions(actor.organizationId, userId, membership.role),
      this.permissionsService.getMemberOverrides(actor.organizationId, userId),
    ]);

    return {
      data: {
        ...this.toRecord(membership),
        permissions: [...effective].sort(),
        permissionOverrides: overrides.data,
        managedBranchIds: membership.user.managedBranches.map((branch) => branch.id),
      },
    };
  }

  /**
   * Edits a member's details, role and branch assignments. Ownership is never
   * handed over here: an owner is changed outside the staff screen.
   */
  async update(
    actor: RequestActor,
    userId: string,
    dto: UpdateStaffDto,
  ): Promise<{ data: StaffDetailRecord }> {
    const membership = await this.requireMembership(actor.organizationId, userId);

    if (dto.role && dto.role !== membership.role) {
      if (membership.role === Role.OWNER) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'The owner role cannot be changed. Transfer ownership instead.',
        });
      }
      if (!ASSIGNABLE_ROLES.includes(dto.role)) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Choose a role that can be assigned to staff.',
          field: 'role',
        });
      }
      if (actor.userId === userId) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'You cannot change your own role.',
        });
      }
    }

    const branchIds = dto.branchIds ? [...new Set(dto.branchIds.map((id) => id.trim()).filter(Boolean))] : null;
    if (branchIds) {
      await this.assertBranches(actor.organizationId, branchIds);
    }

    const userData: Prisma.UserUpdateInput = {};
    if (dto.name !== undefined) userData.name = dto.name.trim();
    if (dto.phone !== undefined) {
      const phone = dto.phone.trim();
      if (!phone) {
        userData.phone = null;
      } else {
        const taken = await this.prisma.user.findFirst({
          where: { phone, NOT: { id: userId } },
          select: { id: true },
        });
        if (taken) {
          throw new ConflictException({
            code: 'PHONE_TAKEN',
            message: 'Another account already uses this phone number.',
            field: 'phone',
          });
        }
        userData.phone = phone;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      if (Object.keys(userData).length > 0) {
        await tx.user.update({ where: { id: userId }, data: userData });
      }
      if (dto.role && dto.role !== membership.role) {
        await tx.membership.update({
          where: { organizationId_userId: { organizationId: actor.organizationId, userId } },
          data: { role: dto.role },
        });
      }
      if (branchIds) {
        await tx.branchStaff.deleteMany({
          where: {
            userId,
            branch: { organizationId: actor.organizationId },
            branchId: { notIn: branchIds },
          },
        });
        if (branchIds.length > 0) {
          await tx.branchStaff.createMany({
            data: branchIds.map((branchId) => ({ branchId, userId })),
            skipDuplicates: true,
          });
        }
      }
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'STAFF_UPDATED',
      entityType: 'Membership',
      entityId: userId,
      metadata: {
        roleFrom: membership.role,
        roleTo: dto.role ?? membership.role,
        branchCount: branchIds ? branchIds.length : undefined,
      },
    });

    return this.findOne(actor, userId);
  }

  /**
   * Suspends, deactivates or restores a member. Sessions are revoked when access
   * ends so an open browser cannot keep working on a stale token.
   */
  async setStatus(
    actor: RequestActor,
    userId: string,
    status: MembershipStatus,
    reason?: string,
  ): Promise<{ data: StaffRecord }> {
    const membership = await this.requireMembership(actor.organizationId, userId);

    if (actor.userId === userId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You cannot change your own access.',
      });
    }
    if (membership.role === Role.OWNER && actor.role !== Role.OWNER) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Only the owner can change another owner’s access.',
      });
    }
    if (status !== MembershipStatus.ACTIVE && membership.role === Role.OWNER) {
      const owners = await this.prisma.membership.count({
        where: {
          organizationId: actor.organizationId,
          role: Role.OWNER,
          active: true,
          status: MembershipStatus.ACTIVE,
        },
      });
      if (owners <= 1) {
        throw new BadRequestException({
          code: 'LAST_OWNER',
          message: 'The organisation needs at least one active owner.',
        });
      }
    }

    const active = status === MembershipStatus.ACTIVE;
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.membership.update({
        where: { organizationId_userId: { organizationId: actor.organizationId, userId } },
        data: { status, active, statusReason: active ? null : reason?.trim() || null },
        select: {
          ...STAFF_SELECT,
          role: true,
          status: true,
          statusReason: true,
          active: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!active) {
        await tx.authSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      return row;
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action:
        status === MembershipStatus.ACTIVE
          ? 'STAFF_ACTIVATED'
          : status === MembershipStatus.SUSPENDED
            ? 'STAFF_SUSPENDED'
            : 'STAFF_DEACTIVATED',
      entityType: 'Membership',
      entityId: userId,
      metadata: { reason: reason?.trim() || null },
    });

    return { data: this.toRecord(updated) };
  }

  /**
   * Removes a member's access to this organisation. Stock, sales and audit rows
   * they created stay untouched, and the membership is kept as history.
   */
  async remove(actor: RequestActor, userId: string, reason?: string): Promise<{ data: StaffRecord }> {
    const membership = await this.requireMembership(actor.organizationId, userId);

    if (actor.userId === userId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You cannot remove your own access.',
      });
    }
    if (membership.role === Role.OWNER) {
      throw new BadRequestException({
        code: 'OWNER_PROTECTED',
        message: 'Transfer ownership before removing an owner.',
      });
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.branchStaff.deleteMany({
        where: { userId, branch: { organizationId: actor.organizationId } },
      });
      await tx.branch.updateMany({
        where: { organizationId: actor.organizationId, managerUserId: userId },
        data: { managerUserId: null },
      });
      await tx.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      return tx.membership.update({
        where: { organizationId_userId: { organizationId: actor.organizationId, userId } },
        data: {
          status: MembershipStatus.DEACTIVATED,
          active: false,
          statusReason: reason?.trim() || 'Access removed by an administrator',
        },
        select: {
          ...STAFF_SELECT,
          role: true,
          status: true,
          statusReason: true,
          active: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: 'STAFF_REMOVED',
      entityType: 'Membership',
      entityId: userId,
      metadata: { reason: reason?.trim() || null, role: membership.role },
    });

    return { data: this.toRecord(updated) };
  }

  /** What one member has done, newest first, limited to branches the caller may read. */
  async activity(actor: RequestActor, userId: string, limit = 50) {
    await this.requireMembership(actor.organizationId, userId);
    const branchIds = await this.branchAccess.allowedBranchIds(actor);

    const logs = await this.prisma.auditLog.findMany({
      where: {
        organizationId: actor.organizationId,
        actorId: userId,
        ...(branchIds.length > 0
          ? { OR: [{ branchId: null }, { branchId: { in: branchIds } }] }
          : { branchId: null }),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });

    return {
      data: logs.map((log) => ({
        id: log.id,
        branchId: log.branchId,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        metadata: log.metadata,
        createdAt: log.createdAt,
      })),
    };
  }

  // ------------------------------------------------------------------ internals

  private async requireMembership(
    organizationId: string,
    userId: string,
  ): Promise<MembershipWithUser & { role: Role; status: MembershipStatus; statusReason: string | null; active: boolean; createdAt: Date; updatedAt: Date }> {
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: {
        ...STAFF_SELECT,
        role: true,
        status: true,
        statusReason: true,
        active: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!membership) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'This person is not a member of your organisation.',
      });
    }
    return membership;
  }

  private async assertBranches(organizationId: string, branchIds: string[]): Promise<void> {
    if (branchIds.length === 0) return;
    const branches = await this.prisma.branch.findMany({
      where: { organizationId, id: { in: branchIds } },
      select: { id: true, status: true },
    });
    if (branches.length !== branchIds.length) {
      throw new BadRequestException({
        code: 'INVALID_BRANCH',
        message: 'One of the selected branches does not belong to this organisation.',
        field: 'branchIds',
      });
    }
    if (branches.some((branch) => branch.status !== BranchStatus.ACTIVE)) {
      throw new BadRequestException({
        code: 'BRANCH_INACTIVE',
        message: 'Staff can only be assigned to active branches.',
        field: 'branchIds',
      });
    }
  }

  private toRecord(
    membership: MembershipWithUser & {
      role: Role;
      status: MembershipStatus;
      statusReason: string | null;
      active: boolean;
      createdAt: Date;
      updatedAt: Date;
    },
  ): StaffRecord {
    return {
      userId: membership.user.id,
      name: membership.user.name,
      email: membership.user.email,
      phone: membership.user.phone,
      role: membership.role,
      status: membership.status,
      statusReason: membership.statusReason,
      active: membership.active,
      lastLoginAt: membership.user.lastLoginAt,
      branches: membership.user.branchAssignments.map((assignment) => assignment.branch),
      joinedAt: membership.createdAt,
      updatedAt: membership.updatedAt,
    };
  }
}

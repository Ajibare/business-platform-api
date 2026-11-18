import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BranchStatus, MembershipStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { BranchAccessService, type RequestActor } from './branch-access.service';
import {
  AssignBranchStaffDto,
  CreateBranchDto,
  UpdateBranchDto,
} from './dto/branch.dto';

export interface BranchRecord {
  id: string;
  name: string;
  code: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  status: BranchStatus;
  isDefault: boolean;
  managerUserId: string | null;
  managerName: string | null;
  staffCount: number;
  batchCount: number;
  stockUnits: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BranchStaffRecord {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  memberStatus: MembershipStatus;
  isManager: boolean;
  assignedAt: Date;
}

const BRANCH_INCLUDE = {
  manager: { select: { id: true, name: true, email: true } },
  _count: { select: { staff: true, batches: true } },
} satisfies Prisma.BranchInclude;

type BranchWithRelations = Prisma.BranchGetPayload<{ include: typeof BRANCH_INCLUDE }>;

@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly branchAccess: BranchAccessService,
    private readonly auditService: AuditService,
  ) {}

  /** Every branch the caller may reach, with the numbers the list needs. */
  async findAll(actor: RequestActor): Promise<{ data: BranchRecord[] }> {
    const allowed = await this.branchAccess.allowedBranchIds(actor);
    if (allowed.length === 0) return { data: [] };

    const branches = await this.prisma.branch.findMany({
      where: { organizationId: actor.organizationId, id: { in: allowed } },
      include: BRANCH_INCLUDE,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    const units = await this.stockUnits(actor.organizationId, branches.map((branch) => branch.id));

    return {
      data: branches.map((branch) => this.toRecord(branch, units.get(branch.id) ?? 0)),
    };
  }

  async findOne(actor: RequestActor, id: string): Promise<{
    data: BranchRecord & { staff: BranchStaffRecord[] };
  }> {
    await this.branchAccess.assertAccess(actor, id);

    const branch = await this.prisma.branch.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: BRANCH_INCLUDE,
    });
    if (!branch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Branch not found.' });
    }

    const assignments = await this.prisma.branchStaff.findMany({
      where: { branchId: branch.id },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            memberships: {
              where: { organizationId: actor.organizationId },
              select: { role: true, status: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const units = await this.stockUnits(actor.organizationId, [branch.id]);

    return {
      data: {
        ...this.toRecord(branch, units.get(branch.id) ?? 0),
        staff: assignments.map((assignment) => ({
          userId: assignment.user.id,
          name: assignment.user.name,
          email: assignment.user.email,
          role: assignment.user.memberships[0]?.role ?? 'READ_ONLY',
          memberStatus: assignment.user.memberships[0]?.status ?? MembershipStatus.DEACTIVATED,
          isManager: branch.managerUserId === assignment.user.id,
          assignedAt: assignment.createdAt,
        })),
      },
    };
  }

  async create(actor: RequestActor, dto: CreateBranchDto): Promise<{ data: BranchRecord }> {
    const code = this.normaliseCode(dto.code);
    await this.assertCodeAvailable(actor.organizationId, code);

    const managerUserId = dto.managerUserId ? dto.managerUserId.trim() : null;
    if (managerUserId) {
      await this.assertMember(actor.organizationId, managerUserId);
    }

    const existing = await this.prisma.branch.count({
      where: { organizationId: actor.organizationId },
    });

    const branch = await this.prisma.branch.create({
      data: {
        organizationId: actor.organizationId,
        name: dto.name.trim(),
        code,
        address: dto.address?.trim() || null,
        phone: dto.phone?.trim() || null,
        email: dto.email?.trim() || null,
        managerUserId,
        // The first branch takes over as the default so single-branch
        // workspaces keep working exactly as before.
        isDefault: existing === 0,
        staff: managerUserId ? { create: [{ userId: managerUserId }] } : undefined,
      },
      include: BRANCH_INCLUDE,
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      branchId: branch.id,
      actorId: actor.userId,
      action: 'BRANCH_CREATED',
      entityType: 'Branch',
      entityId: branch.id,
      metadata: { name: branch.name, code: branch.code },
    });

    return { data: this.toRecord(branch, 0) };
  }

  async update(
    actor: RequestActor,
    id: string,
    dto: UpdateBranchDto,
  ): Promise<{ data: BranchRecord }> {
    await this.branchAccess.assertAccess(actor, id);
    const branch = await this.prisma.branch.findFirst({
      where: { id, organizationId: actor.organizationId },
      select: { id: true, code: true },
    });
    if (!branch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Branch not found.' });
    }

    const data: Prisma.BranchUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();

    if (dto.code !== undefined) {
      const code = this.normaliseCode(dto.code);
      if (code !== branch.code) {
        await this.assertCodeAvailable(actor.organizationId, code, branch.id);
        data.code = code;
      }
    }

    for (const field of ['address', 'phone', 'email'] as const) {
      if (dto[field] === undefined) continue;
      const value = dto[field];
      data[field] = value === null ? null : value.trim() || null;
    }

    const updated = await this.prisma.branch.update({
      where: { id: branch.id },
      data,
      include: BRANCH_INCLUDE,
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      branchId: updated.id,
      actorId: actor.userId,
      action: 'BRANCH_UPDATED',
      entityType: 'Branch',
      entityId: updated.id,
      metadata: { changed: Object.keys(data) },
    });

    const units = await this.stockUnits(actor.organizationId, [updated.id]);
    return { data: this.toRecord(updated, units.get(updated.id) ?? 0) };
  }

  /**
   * Activates or deactivates a branch. A branch never holds the organisation's
   * only active location, because recording stock and sales would have no home.
   */
  async setStatus(
    actor: RequestActor,
    id: string,
    status: BranchStatus,
  ): Promise<{ data: BranchRecord }> {
    await this.branchAccess.assertAccess(actor, id);
    const branch = await this.prisma.branch.findFirst({
      where: { id, organizationId: actor.organizationId },
      include: BRANCH_INCLUDE,
    });
    if (!branch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Branch not found.' });
    }

    if (status === BranchStatus.INACTIVE) {
      const active = await this.prisma.branch.count({
        where: { organizationId: actor.organizationId, status: BranchStatus.ACTIVE },
      });
      if (active <= 1 && branch.status === BranchStatus.ACTIVE) {
        throw new BadRequestException({
          code: 'LAST_ACTIVE_BRANCH',
          message: 'Keep at least one branch active so stock and sales have a location.',
        });
      }
    }

    const updated = await this.prisma.branch.update({
      where: { id: branch.id },
      data: { status },
      include: BRANCH_INCLUDE,
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      branchId: updated.id,
      actorId: actor.userId,
      action: status === BranchStatus.ACTIVE ? 'BRANCH_ACTIVATED' : 'BRANCH_DEACTIVATED',
      entityType: 'Branch',
      entityId: updated.id,
      metadata: { name: updated.name },
    });

    const units = await this.stockUnits(actor.organizationId, [updated.id]);
    return { data: this.toRecord(updated, units.get(updated.id) ?? 0) };
  }

  /** Sets or clears the branch manager. The manager is always assigned too. */
  async assignManager(
    actor: RequestActor,
    id: string,
    managerUserId: string | null,
  ): Promise<{ data: BranchRecord }> {
    await this.branchAccess.assertAccess(actor, id);
    const branch = await this.prisma.branch.findFirst({
      where: { id, organizationId: actor.organizationId },
      select: { id: true },
    });
    if (!branch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Branch not found.' });
    }

    if (managerUserId) {
      await this.assertMember(actor.organizationId, managerUserId);
      await this.prisma.branchStaff.upsert({
        where: { branchId_userId: { branchId: branch.id, userId: managerUserId } },
        create: { branchId: branch.id, userId: managerUserId },
        update: {},
      });
    }

    const updated = await this.prisma.branch.update({
      where: { id: branch.id },
      data: { managerUserId },
      include: BRANCH_INCLUDE,
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      branchId: updated.id,
      actorId: actor.userId,
      action: managerUserId ? 'BRANCH_MANAGER_ASSIGNED' : 'BRANCH_MANAGER_CLEARED',
      entityType: 'Branch',
      entityId: updated.id,
      metadata: { managerUserId },
    });

    const units = await this.stockUnits(actor.organizationId, [updated.id]);
    return { data: this.toRecord(updated, units.get(updated.id) ?? 0) };
  }

  /**
   * Replaces the staff assigned to a branch. Everyone listed must be an active
   * member of the organisation; anyone left out loses access to this branch.
   */
  async assignStaff(
    actor: RequestActor,
    id: string,
    dto: AssignBranchStaffDto,
  ): Promise<{ data: { branchId: string; userIds: string[] } }> {
    await this.branchAccess.assertAccess(actor, id);
    const branch = await this.prisma.branch.findFirst({
      where: { id, organizationId: actor.organizationId },
      select: { id: true, status: true, name: true },
    });
    if (!branch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Branch not found.' });
    }
    if (branch.status !== BranchStatus.ACTIVE) {
      throw new BadRequestException({
        code: 'BRANCH_INACTIVE',
        message: 'Activate this branch before assigning staff to it.',
      });
    }

    const userIds = [...new Set(dto.userIds.map((value) => value.trim()).filter(Boolean))];
    if (userIds.length > 0) {
      const members = await this.prisma.membership.findMany({
        where: {
          organizationId: actor.organizationId,
          userId: { in: userIds },
          active: true,
          status: MembershipStatus.ACTIVE,
        },
        select: { userId: true },
      });
      if (members.length !== userIds.length) {
        throw new BadRequestException({
          code: 'INVALID_STAFF',
          message: 'One of the selected people is not an active member of this organisation.',
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.branchStaff.deleteMany({
        where: { branchId: branch.id, userId: { notIn: userIds } },
      });
      if (userIds.length > 0) {
        await tx.branchStaff.createMany({
          data: userIds.map((userId) => ({ branchId: branch.id, userId })),
          skipDuplicates: true,
        });
      }
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      branchId: branch.id,
      actorId: actor.userId,
      action: 'BRANCH_STAFF_UPDATED',
      entityType: 'Branch',
      entityId: branch.id,
      metadata: { staffCount: userIds.length },
    });

    return { data: { branchId: branch.id, userIds } };
  }

  async removeStaff(
    actor: RequestActor,
    id: string,
    userId: string,
  ): Promise<{ data: { branchId: string; userId: string } }> {
    await this.branchAccess.assertAccess(actor, id);
    const branch = await this.prisma.branch.findFirst({
      where: { id, organizationId: actor.organizationId },
      select: { id: true, managerUserId: true },
    });
    if (!branch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Branch not found.' });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.branchStaff.deleteMany({ where: { branchId: branch.id, userId } });
      if (branch.managerUserId === userId) {
        await tx.branch.update({ where: { id: branch.id }, data: { managerUserId: null } });
      }
    });

    await this.auditService.record({
      organizationId: actor.organizationId,
      branchId: branch.id,
      actorId: actor.userId,
      action: 'BRANCH_STAFF_REMOVED',
      entityType: 'Branch',
      entityId: branch.id,
      metadata: { userId },
    });

    return { data: { branchId: branch.id, userId } };
  }

  // ------------------------------------------------------------------ internals

  private normaliseCode(raw: string): string {
    return raw.trim().toUpperCase();
  }

  private async assertCodeAvailable(
    organizationId: string,
    code: string,
    exceptBranchId?: string,
  ): Promise<void> {
    const existing = await this.prisma.branch.findFirst({
      where: {
        organizationId,
        code,
        ...(exceptBranchId ? { id: { not: exceptBranchId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'BRANCH_CODE_TAKEN',
        message: `Branch code ${code} is already used in this organisation.`,
        field: 'code',
      });
    }
  }

  /** A manager or assignee must be an active member of the same organisation. */
  private async assertMember(organizationId: string, userId: string): Promise<void> {
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { active: true, status: true },
    });
    if (!membership || !membership.active || membership.status !== MembershipStatus.ACTIVE) {
      throw new BadRequestException({
        code: 'INVALID_STAFF',
        message: 'Choose an active member of this organisation.',
        field: 'managerUserId',
      });
    }
  }

  /** Units held per branch, never added across branches. */
  private async stockUnits(organizationId: string, branchIds: string[]): Promise<Map<string, number>> {
    const units = new Map<string, number>();
    if (branchIds.length === 0) return units;

    const balances = await this.prisma.batchBalance.findMany({
      where: { organizationId, batch: { branchId: { in: branchIds } } },
      select: { quantity: true, batch: { select: { branchId: true } } },
    });

    for (const balance of balances) {
      const branchId = balance.batch.branchId;
      units.set(branchId, (units.get(branchId) ?? 0) + this.toQuantity(balance.quantity));
    }
    return units;
  }

  private toRecord(branch: BranchWithRelations, stockUnits: number): BranchRecord {
    return {
      id: branch.id,
      name: branch.name,
      code: branch.code,
      address: branch.address,
      phone: branch.phone,
      email: branch.email,
      status: branch.status,
      isDefault: branch.isDefault,
      managerUserId: branch.managerUserId,
      managerName: branch.manager?.name ?? branch.manager?.email ?? null,
      staffCount: branch._count.staff,
      batchCount: branch._count.batches,
      stockUnits,
      createdAt: branch.createdAt,
      updatedAt: branch.updatedAt,
    };
  }

  private toQuantity(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
  }
}

import { ForbiddenException, Injectable } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import type { PermissionKey } from '../permissions/permission-catalogue';

/** Who is making the request, resolved from the token rather than the body. */
export interface RequestActor {
  userId: string;
  organizationId: string;
  role: Role;
  permissions: Set<PermissionKey>;
}

/**
 * The branches a single request may touch.
 *
 * `branchId` is the one branch a write belongs to; it is null when the request
 * asks for a consolidated view or the member has no branch at all.
 */
export interface BranchScope {
  branchId: string | null;
  /** Branches that may be read. Always non-empty for a member with access. */
  branchIds: string[];
  allowedBranchIds: string[];
  consolidated: boolean;
  organisationWide: boolean;
}

/** The value that asks for every branch at once. */
export const ALL_BRANCHES = 'all';

interface RequestLike {
  user?: { sub?: string; organisationId?: string };
  organisationId?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  actor?: RequestActor;
  branchScope?: BranchScope;
}

@Injectable()
export class BranchAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
  ) {}

  /**
   * Resolves the caller from the verified token claims. The organisation always
   * comes from the token: a body or query value is never trusted.
   */
  async resolveActor(request: RequestLike): Promise<RequestActor> {
    if (request.actor) return request.actor;

    const userId = request.user?.sub;
    const organizationId = request.user?.organisationId ?? request.organisationId;

    if (!userId || !organizationId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Organisation context is missing for the authenticated user.',
      });
    }

    const [membership, user] = await Promise.all([
      this.prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        select: { role: true, active: true },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } }),
    ]);

    if (!membership || !membership.active) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'User is not an active member of the organisation.',
      });
    }

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException({
        code: 'ACCOUNT_INACTIVE',
        message: 'This account is not active. Ask an administrator to restore access.',
      });
    }

    const permissions = await this.permissionsService.getEffectivePermissions(
      organizationId,
      userId,
      membership.role,
    );

    const actor: RequestActor = {
      userId,
      organizationId,
      role: membership.role,
      permissions,
    };
    request.actor = actor;
    return actor;
  }

  /** Every branch the actor may reach, with no regard to the request. */
  async allowedBranchIds(actor: RequestActor): Promise<string[]> {
    if (actor.permissions.has('branch:all')) {
      const all = await this.prisma.branch.findMany({
        where: { organizationId: actor.organizationId },
        select: { id: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      });
      return all.map((branch) => branch.id);
    }

    const assignments = await this.prisma.branchStaff.findMany({
      where: {
        userId: actor.userId,
        branch: { organizationId: actor.organizationId },
      },
      select: { branchId: true },
      orderBy: { branch: { name: 'asc' } },
    });
    return assignments.map((assignment) => assignment.branchId);
  }

  /** The branch new records land in when the caller did not name one. */
  async defaultBranchId(organizationId: string): Promise<string | null> {
    const branch = await this.prisma.branch.findFirst({
      where: { organizationId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    return branch?.id ?? null;
  }

  /**
   * Works out which branches a request covers.
   *
   * `requested` comes from the `X-Branch-Id` header or the `branchId` query
   * parameter and is only ever a hint: it must appear in the actor's allowed
   * list or the request is rejected.
   */
  async resolveScope(
    actor: RequestActor,
    requested?: string | null,
  ): Promise<BranchScope> {
    const allowedBranchIds = await this.allowedBranchIds(actor);
    const organisationWide = actor.permissions.has('branch:all');
    const value = typeof requested === 'string' ? requested.trim() : '';

    if (value && value !== ALL_BRANCHES) {
      if (!allowedBranchIds.includes(value)) {
        throw new ForbiddenException({
          code: 'BRANCH_FORBIDDEN',
          message: 'You do not have access to this branch.',
        });
      }
      return {
        branchId: value,
        branchIds: [value],
        allowedBranchIds,
        consolidated: false,
        organisationWide,
      };
    }

    if (value === ALL_BRANCHES) {
      if (!organisationWide && allowedBranchIds.length < 2) {
        throw new ForbiddenException({
          code: 'BRANCH_FORBIDDEN',
          message: 'You do not have permission to view every branch.',
        });
      }
      return {
        branchId: null,
        branchIds: allowedBranchIds,
        allowedBranchIds,
        consolidated: true,
        organisationWide,
      };
    }

    const fallback = await this.defaultBranchId(actor.organizationId);
    const branchId = fallback && allowedBranchIds.includes(fallback)
      ? fallback
      : (allowedBranchIds[0] ?? null);

    return {
      branchId,
      branchIds: branchId ? [branchId] : [],
      allowedBranchIds,
      consolidated: false,
      organisationWide,
    };
  }

  /** Reads the branch hint from the request without trusting it. */
  requestedBranch(request: RequestLike): string | null {
    const header = request.headers?.['x-branch-id'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim();

    const fromQuery = request.query?.branchId;
    if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();

    return null;
  }

  /** Resolves the scope for a request, reusing the value a guard already set. */
  async scopeFor(request: RequestLike): Promise<BranchScope> {
    if (request.branchScope) return request.branchScope;
    const actor = await this.resolveActor(request);
    const scope = await this.resolveScope(actor, this.requestedBranch(request));
    request.branchScope = scope;
    return scope;
  }

  /**
   * A concrete branch for a write. Consolidated requests must name one, and the
   * branch has to be active before stock or sales can be recorded against it.
   */
  async writableBranchId(actor: RequestActor, scope: BranchScope): Promise<string> {
    if (!scope.branchId) {
      throw new ForbiddenException({
        code: 'BRANCH_REQUIRED',
        message: 'Choose a branch before recording this action.',
      });
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: scope.branchId, organizationId: actor.organizationId },
      select: { status: true },
    });

    if (!branch || branch.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'BRANCH_INACTIVE',
        message: 'This branch is not active. Activate it before recording stock or sales.',
      });
    }

    return scope.branchId;
  }

  /** Confirms the actor may reach a named branch, for one-off checks. */
  async assertAccess(actor: RequestActor, branchId: string): Promise<void> {
    const allowed = await this.allowedBranchIds(actor);
    if (!allowed.includes(branchId)) {
      throw new ForbiddenException({
        code: 'BRANCH_FORBIDDEN',
        message: 'You do not have access to this branch.',
      });
    }
  }
}

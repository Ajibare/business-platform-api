import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { BranchStatus, InvitationStatus, Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../notifications/email.service';
import type { PermissionKey } from '../permissions/permission-catalogue';
import { AuthRequestLike, clientKey } from './auth-context';
import { INVITATION_TTL_DAYS, PASSWORD_HASH_ROUNDS } from './auth.constants';
import { AuthService, AuthSessionResult } from './auth.service';
import { assessPassword, generateOpaqueToken, hashSecret, normalizeEmail, normalizePhone } from './auth.utils';
import { AcceptInvitationDto, CreateInvitationDto, InvitableRole } from './dto/invitation.dto';
import { RateLimitService } from './rate-limit.service';

export interface InvitationPreview {
  organizationName: string;
  role: Role;
  email: string | null;
  phone: string | null;
  hasAccount: boolean;
  expiresAt: string;
  branchNames: string[];
}

interface InvitationContext {
  userId: string;
  organisationId: string;
  role: Role;
  /** What the inviter may do; inviting is authorised by permission, not by role name. */
  permissions: Set<PermissionKey>;
}

const PREVIEW_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly rateLimit: RateLimitService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ workspace

  async roleOf(userId: string, organisationId: string): Promise<Role> {
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId: organisationId, userId } },
      select: { role: true, active: true },
    });
    if (!membership?.active) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You do not have access to this workspace.',
      });
    }
    return membership.role;
  }

  async create(
    context: InvitationContext,
    dto: CreateInvitationDto,
  ) {
    this.assertCanInvite(context, dto.role);
    const branches = await this.resolveBranches(context.organisationId, dto.branchIds);

    const email = dto.email ? normalizeEmail(dto.email) : null;
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    if (!email && !phone) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Enter an email address or a phone number to invite.',
      });
    }
    if (!email) {
      // There is no SMS transport configured, so a phone-only invite could never
      // be delivered. Failing loudly is better than a silent dead invitation.
      throw new BadRequestException({
        code: 'CHANNEL_UNAVAILABLE',
        message: 'Invitations are currently delivered by email. Add the email address to invite this person.',
        field: 'email',
      });
    }
    if (dto.phone && !phone) {
      throw new BadRequestException({
        code: 'INVALID_PHONE',
        message: 'Enter a Nigerian mobile number, for example 0803 123 4567.',
        field: 'phone',
      });
    }

    const existingMember = await this.prisma.membership.findFirst({
      where: {
        organizationId: context.organisationId,
        user: { OR: [{ email }, ...(phone ? [{ phone }] : [])] },
      },
      select: { userId: true, active: true },
    });
    if (existingMember?.active) {
      throw new ConflictException({
        code: 'ALREADY_MEMBER',
        message: 'This person is already a member of your workspace.',
      });
    }

    // One live invitation per contact per workspace.
    await this.prisma.staffInvitation.updateMany({
      where: {
        organizationId: context.organisationId,
        status: 'PENDING',
        OR: [{ email }, ...(phone ? [{ phone }] : [])],
      },
      data: { status: 'REVOKED' },
    });

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const invitation = await this.prisma.staffInvitation.create({
      data: {
        organizationId: context.organisationId,
        email,
        phone,
        role: dto.role as Role,
        status: 'PENDING',
        tokenHash: hashSecret(token),
        expiresAt,
        invitedById: context.userId,
        branches: branches.length
          ? { create: branches.map((branch) => ({ branchId: branch.id })) }
          : undefined,
      },
      include: { organization: { select: { name: true } } },
    });

    const inviteUrl = `${this.webAppUrl()}/invite/${token}`;
    const delivered = await this.email.sendTransactional({
      to: email,
      subject: `You are invited to ${invitation.organization.name} on Pharmacy Stock Intelligence`,
      text: [
        `You have been invited to join ${invitation.organization.name} as ${this.roleLabel(dto.role)}.`,
        ...(branches.length > 0
          ? [`You will be working from ${branches.map((branch) => branch.name).join(', ')}.`]
          : []),
        '',
        `Accept the invitation here. The link expires in ${INVITATION_TTL_DAYS} days and can only be used once:`,
        '',
        inviteUrl,
        '',
        'If you were not expecting this invitation you can ignore this email.',
      ].join('\n'),
    });

    await this.audit.record({
      organizationId: context.organisationId,
      actorId: context.userId,
      action: 'STAFF_INVITED',
      entityType: 'StaffInvitation',
      entityId: invitation.id,
      metadata: { email, role: dto.role, delivered, branchIds: branches.map((branch) => branch.id) },
    });

    return {
      data: {
        id: invitation.id,
        email: invitation.email,
        phone: invitation.phone,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt.toISOString(),
        delivered,
        branchIds: branches.map((branch) => branch.id),
        ...(this.previewEnabled() ? { devInviteUrl: inviteUrl } : {}),
      },
    };
  }

  async list(context: InvitationContext) {
    const invitations = await this.prisma.staffInvitation.findMany({
      where: { organizationId: context.organisationId },
      include: { branches: { select: { branchId: true, branch: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return {
      data: invitations.map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        phone: invitation.phone,
        role: invitation.role,
        status: this.effectiveStatus(invitation.status, invitation.expiresAt),
        expiresAt: invitation.expiresAt.toISOString(),
        acceptedAt: invitation.acceptedAt ? invitation.acceptedAt.toISOString() : null,
        branchIds: invitation.branches.map((row) => row.branchId),
        branchNames: invitation.branches.map((row) => row.branch.name),
        resendCount: invitation.resendCount,
        lastSentAt: invitation.lastSentAt ? invitation.lastSentAt.toISOString() : null,
        createdAt: invitation.createdAt.toISOString(),
      })),
    };
  }

  async revoke(context: InvitationContext, invitationId: string) {
    const invitation = await this.prisma.staffInvitation.findFirst({
      where: { id: invitationId, organizationId: context.organisationId },
    });
    if (!invitation) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invitation not found.' });
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException({
        code: 'INVITATION_NOT_PENDING',
        message: 'This invitation can no longer be revoked.',
      });
    }

    await this.prisma.staffInvitation.update({
      where: { id: invitation.id },
      data: { status: 'REVOKED' },
    });
    await this.audit.record({
      organizationId: context.organisationId,
      actorId: context.userId,
      action: 'INVITATION_REVOKED',
      entityType: 'StaffInvitation',
      entityId: invitation.id,
      metadata: { email: invitation.email },
    });

    return { data: { id: invitation.id, status: 'REVOKED' } };
  }

  /**
   * Sends a fresh link for a pending invitation. Replacing the token hash means
   * the previous link stops working, so a leaked email cannot be replayed.
   */
  async resend(context: InvitationContext, invitationId: string) {
    this.assertCanManage(context);

    const invitation = await this.prisma.staffInvitation.findFirst({
      where: { id: invitationId, organizationId: context.organisationId },
      include: {
        organization: { select: { name: true } },
        branches: { select: { branch: { select: { name: true } } } },
      },
    });
    if (!invitation) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invitation not found.' });
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException({
        code: 'INVITATION_NOT_PENDING',
        message: 'Only a pending invitation can be sent again.',
      });
    }
    if (!invitation.email) {
      throw new BadRequestException({
        code: 'CHANNEL_UNAVAILABLE',
        message: 'This invitation has no email address to send to.',
      });
    }

    const token = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const now = new Date();
    await this.prisma.staffInvitation.update({
      where: { id: invitation.id },
      data: {
        tokenHash: hashSecret(token),
        expiresAt,
        resendCount: { increment: 1 },
        lastSentAt: now,
      },
    });

    const inviteUrl = `${this.webAppUrl()}/invite/${token}`;
    const branchNames = invitation.branches.map((row) => row.branch.name);
    const delivered = await this.email.sendTransactional({
      to: invitation.email,
      subject: `Reminder: your invitation to ${invitation.organization.name}`,
      text: [
        `You have been invited to join ${invitation.organization.name} as ${this.roleLabel(invitation.role as InvitableRole)}.`,
        ...(branchNames.length > 0 ? [`You will be working from ${branchNames.join(', ')}.`] : []),
        '',
        `Accept the invitation here. The link expires in ${INVITATION_TTL_DAYS} days and can only be used once:`,
        '',
        inviteUrl,
      ].join('\n'),
    });

    await this.audit.record({
      organizationId: context.organisationId,
      actorId: context.userId,
      action: 'INVITATION_RESENT',
      entityType: 'StaffInvitation',
      entityId: invitation.id,
      metadata: { email: invitation.email, delivered, branchNames },
    });

    return {
      data: {
        id: invitation.id,
        email: invitation.email,
        expiresAt: expiresAt.toISOString(),
        delivered,
        ...(this.previewEnabled() ? { devInviteUrl: inviteUrl } : {}),
      },
    };
  }

  // -------------------------------------------------------------------- public

  async preview(rawToken: string, request: AuthRequestLike): Promise<{ data: InvitationPreview }> {
    this.rateLimit.assertAllowed(
      `invitation-preview:${clientKey(request)}`,
      PREVIEW_LIMIT.limit,
      PREVIEW_LIMIT.windowMs,
      'Too many invitation lookups. Please try again shortly.',
    );

    const invitation = await this.findUsable(rawToken);
    const contacts = [
      ...(invitation.email ? [{ email: invitation.email }] : []),
      ...(invitation.phone ? [{ phone: invitation.phone }] : []),
    ];
    const hasAccount =
      contacts.length > 0
        ? await this.prisma.user.findFirst({ where: { OR: contacts }, select: { id: true } })
        : null;

    return {
      data: {
        organizationName: invitation.organization.name,
        role: invitation.role,
        email: invitation.email,
        phone: invitation.phone,
        hasAccount: Boolean(hasAccount),
        expiresAt: invitation.expiresAt.toISOString(),
        branchNames: invitation.branches.map((row) => row.branch.name),
      },
    };
  }

  /**
   * Accepting creates the account only when the invitee does not have one yet.
   * The membership role always comes from the invitation row, never from the
   * request, and the workspace is always the inviting workspace.
   */
  async acceptNewAccount(
    rawToken: string,
    dto: AcceptInvitationDto,
    request: AuthRequestLike,
  ): Promise<AuthSessionResult> {
    const invitation = await this.findUsable(rawToken);

    if (!invitation.email) {
      throw new BadRequestException({
        code: 'CHANNEL_UNAVAILABLE',
        message: 'This invitation cannot be accepted online. Ask the workspace owner to send a new one.',
      });
    }
    if (dto.confirmPassword !== undefined && dto.confirmPassword !== dto.password) {
      throw new BadRequestException({
        code: 'PASSWORD_MISMATCH',
        message: 'The two passwords do not match.',
        field: 'confirmPassword',
      });
    }

    const assessment = assessPassword(dto.password, {
      email: invitation.email,
      name: dto.name,
    });
    if (!assessment.valid) {
      throw new BadRequestException({
        code: 'WEAK_PASSWORD',
        message: assessment.issues[0],
        field: 'password',
        details: { issues: assessment.issues },
      });
    }

    const contactFilters = [
      { email: invitation.email },
      ...(invitation.phone ? [{ phone: invitation.phone }] : []),
    ];
    const existing = await this.prisma.user.findFirst({
      where: { OR: contactFilters },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'ACCOUNT_EXISTS',
        message: 'An account already exists for this invitation. Sign in to accept it.',
      });
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_HASH_ROUNDS);
    const now = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: dto.name.trim(),
          email: invitation.email,
          phone: invitation.phone,
          passwordHash,
          status: 'ACTIVE',
          emailVerifiedAt: now,
          // The invitation was delivered to the email address; nothing was sent
          // to the phone, so it stays unverified.
          phoneVerifiedAt: null,
          passwordChangedAt: now,
        },
      });

      await this.createMembership(tx, invitation.organizationId, user.id, invitation.role);
      await this.assignInvitedBranches(tx, user.id, invitation.branches);
      await tx.staffInvitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedById: user.id, acceptedAt: now },
      });

      return user;
    });

    await this.audit.record({
      organizationId: invitation.organizationId,
      actorId: created.id,
      action: 'INVITATION_ACCEPTED',
      entityType: 'StaffInvitation',
      entityId: invitation.id,
      metadata: { role: invitation.role, email: invitation.email },
    });

    return this.auth.establishSession(created.id, invitation.organizationId, request);
  }

  /** Accepting while signed in. The signed-in contact must match the invitation. */
  async acceptExisting(userId: string, rawToken: string, request: AuthRequestLike) {
    const invitation = await this.findUsable(rawToken);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, phone: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        code: 'INVALID_SESSION',
        message: 'Your session has ended. Please sign in again.',
      });
    }

    const matchesEmail = Boolean(invitation.email) && invitation.email === user.email;
    const matchesPhone = Boolean(invitation.phone) && invitation.phone === user.phone;
    if (!matchesEmail && !matchesPhone) {
      throw new ForbiddenException({
        code: 'INVITATION_MISMATCH',
        message: 'This invitation was sent to a different email address or phone number.',
      });
    }

    const existingMembership = await this.prisma.membership.findUnique({
      where: {
        organizationId_userId: { organizationId: invitation.organizationId, userId: user.id },
      },
    });
    if (existingMembership?.active) {
      throw new ConflictException({
        code: 'ALREADY_MEMBER',
        message: 'You are already a member of this workspace.',
      });
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.createMembership(tx, invitation.organizationId, user.id, invitation.role);
      await this.assignInvitedBranches(tx, user.id, invitation.branches);
      await tx.staffInvitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedById: user.id, acceptedAt: now },
      });
    });

    await this.audit.record({
      organizationId: invitation.organizationId,
      actorId: user.id,
      action: 'INVITATION_ACCEPTED',
      entityType: 'StaffInvitation',
      entityId: invitation.id,
      metadata: { role: invitation.role },
    });

    return this.auth.establishSession(user.id, invitation.organizationId, request);
  }

  // ----------------------------------------------------------------- internals

  private async createMembership(
    tx: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
    role: Role,
  ): Promise<void> {
    const existing = await tx.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    if (existing) {
      await tx.membership.update({
        where: { organizationId_userId: { organizationId, userId } },
        data: { role, active: true },
      });
      return;
    }
    await tx.membership.create({ data: { organizationId, userId, role, active: true } });
  }

  private async findUsable(
    rawToken: string,
  ) {
    const token = rawToken?.trim();
    if (!token) {
      throw new BadRequestException({
        code: 'INVALID_INVITATION',
        message: 'This invitation link is not valid.',
      });
    }

    const invitation = await this.prisma.staffInvitation.findFirst({
      where: { tokenHash: hashSecret(token) },
      include: {
        organization: { select: { name: true } },
        branches: { select: { branchId: true, branch: { select: { name: true } } } },
      },
    });

    if (!invitation) {
      throw new NotFoundException({
        code: 'INVALID_INVITATION',
        message: 'This invitation link is not valid.',
      });
    }
    if (invitation.status === 'REVOKED') {
      throw new BadRequestException({
        code: 'INVITATION_REVOKED',
        message: 'This invitation was cancelled. Ask the workspace owner for a new one.',
      });
    }
    if (invitation.status === 'ACCEPTED') {
      throw new BadRequestException({
        code: 'INVITATION_ALREADY_ACCEPTED',
        message: 'This invitation has already been accepted. Sign in to continue.',
      });
    }
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'INVITATION_EXPIRED',
        message: 'This invitation has expired. Ask the workspace owner for a new one.',
      });
    }

    return invitation;
  }

  /** Confirms the branches exist in this organisation and are still active. */
  private async resolveBranches(organizationId: string, branchIds?: string[]) {
    const ids = [...new Set((branchIds ?? []).map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return [] as { id: string; name: string }[];

    const branches = await this.prisma.branch.findMany({
      where: { organizationId, id: { in: ids } },
      select: { id: true, name: true, status: true },
    });
    if (branches.length !== ids.length) {
      throw new BadRequestException({
        code: 'INVALID_BRANCH',
        message: 'One of the selected branches does not belong to this organisation.',
        field: 'branchIds',
      });
    }
    if (branches.some((branch) => branch.status !== BranchStatus.ACTIVE)) {
      throw new BadRequestException({
        code: 'BRANCH_INACTIVE',
        message: 'Staff can only be invited to an active branch.',
        field: 'branchIds',
      });
    }
    return branches;
  }

  /** Gives the new member the branches that were recorded on the invitation. */
  private async assignInvitedBranches(
    tx: Prisma.TransactionClient,
    userId: string,
    branches: { branchId: string }[],
  ): Promise<void> {
    if (branches.length === 0) return;
    await tx.branchStaff.createMany({
      data: branches.map((row) => ({ branchId: row.branchId, userId })),
      skipDuplicates: true,
    });
  }

  private assertCanManage(context: InvitationContext): void {
    if (!context.permissions.has('staff:manage')) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You do not have permission to manage staff invitations.',
      });
    }
  }

  /**
   * Inviting is authorised by permission, never by role name. Handing out
   * administrator access also needs the permission-configuration right, so only
   * the owner can create another administrator.
   */
  private assertCanInvite(context: InvitationContext, invitedRole: InvitableRole): void {
    this.assertCanManage(context);
    if (invitedRole === 'ADMIN' && !context.permissions.has('staff:permissions')) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Only the owner can invite an administrator.',
      });
    }
  }

  private effectiveStatus(status: InvitationStatus, expiresAt: Date): InvitationStatus | 'EXPIRED' {
    if (status === 'PENDING' && expiresAt.getTime() <= Date.now()) return 'EXPIRED';
    return status;
  }

  private roleLabel(role: InvitableRole): string {
    switch (role) {
      case 'ADMIN':
        return 'an Administrator';
      case 'BRANCH_MANAGER':
      case 'MANAGER':
        return 'a Branch manager';
      case 'PHARMACIST':
        return 'a Pharmacist';
      case 'INVENTORY_OFFICER':
      case 'INVENTORY_STAFF':
        return 'an Inventory officer';
      case 'CASHIER':
        return 'a Cashier';
      default:
        return 'Read-only access';
    }
  }

  private previewEnabled(): boolean {
    return process.env.NODE_ENV !== 'production' && this.email.activeTransport === 'log';
  }

  private webAppUrl(): string {
    return (
      process.env.APP_WEB_URL ??
      process.env.CORS_ORIGINS?.split(',')[0]?.trim() ??
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }
}

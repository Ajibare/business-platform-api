import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InvitationStatus, Prisma, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../notifications/email.service';
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
}

interface InvitationContext {
  userId: string;
  organisationId: string;
  role: Role;
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
    this.assertCanInvite(context.role, dto.role);

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
      },
      include: { organization: { select: { name: true } } },
    });

    const inviteUrl = `${this.webAppUrl()}/invite/${token}`;
    const delivered = await this.email.sendTransactional({
      to: email,
      subject: `You are invited to ${invitation.organization.name} on Pharmacy Stock Intelligence`,
      text: [
        `You have been invited to join ${invitation.organization.name} as ${this.roleLabel(dto.role)}.`,
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
      metadata: { email, role: dto.role, delivered },
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
        ...(this.previewEnabled() ? { devInviteUrl: inviteUrl } : {}),
      },
    };
  }

  async list(context: InvitationContext) {
    const invitations = await this.prisma.staffInvitation.findMany({
      where: { organizationId: context.organisationId },
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
      include: { organization: { select: { name: true } } },
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

  private assertCanInvite(actorRole: Role, invitedRole: InvitableRole): void {
    if (actorRole === 'OWNER') return;
    if (actorRole === 'MANAGER' && (invitedRole === 'INVENTORY_STAFF' || invitedRole === 'READ_ONLY')) {
      return;
    }
    throw new ForbiddenException({
      code: 'FORBIDDEN',
      message: 'You do not have permission to invite that role.',
    });
  }

  private effectiveStatus(status: InvitationStatus, expiresAt: Date): InvitationStatus | 'EXPIRED' {
    if (status === 'PENDING' && expiresAt.getTime() <= Date.now()) return 'EXPIRED';
    return status;
  }

  private roleLabel(role: InvitableRole): string {
    switch (role) {
      case 'MANAGER':
        return 'a Manager';
      case 'INVENTORY_STAFF':
        return 'Inventory staff';
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

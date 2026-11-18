import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../notifications/email.service';
import { PermissionsService } from '../permissions/permissions.service';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  GENERIC_LOGIN_ERROR,
  GENERIC_RESET_MESSAGE,
  LOGIN_LOCK_MINUTES,
  LOGIN_MAX_FAILED_ATTEMPTS,
  PASSWORD_HASH_ROUNDS,
  PASSWORD_RESET_TTL_MINUTES,
  VERIFICATION_CODE_TTL_MINUTES,
  VERIFICATION_MAX_ATTEMPTS,
  VERIFICATION_MAX_RESENDS,
  VERIFICATION_RESEND_COOLDOWN_SECONDS,
} from './auth.constants';
import { AuthRequestLike, assertTrustedOrigin, clientKey, describeRequest } from './auth-context';
import { ForgotPasswordDto, ResetPasswordDto } from './dto/password-recovery.dto';
import { RegisterDto } from './dto/register.dto';
import { LegacySignInDto, SignInDto } from './dto/sign-in.dto';
import { ResendVerificationDto, VerifyRegistrationDto } from './dto/verify-registration.dto';
import { buildOnboardingSummary, OnboardingSummary } from './onboarding-summary';
import { RateLimitService } from './rate-limit.service';
import { SessionService } from './session.service';
import {
  assessPassword,
  generateOpaqueToken,
  generateVerificationCode,
  hashSecret,
  maskEmail,
  maskPhone,
  normalizeEmail,
  normalizeIdentifier,
  normalizePhone,
  randomSuffix,
  safeEqual,
  slugify,
} from './auth.utils';

const EMAIL_VERIFICATION_LIMIT = { limit: 6, windowMs: 15 * 60 * 1000 };
const SIGN_IN_LIMIT = { limit: 20, windowMs: 5 * 60 * 1000 };
const REGISTER_LIMIT = { limit: 6, windowMs: 15 * 60 * 1000 };
const PASSWORD_RESET_LIMIT = { limit: 6, windowMs: 15 * 60 * 1000 };

const RATE_LIMIT_MESSAGES = {
  register: 'Too many registration attempts. Please wait a few minutes and try again.',
  verify: 'Too many verification attempts. Please wait a few minutes and try again.',
  signIn: 'Too many sign-in attempts from this network. Please wait a few minutes and try again.',
  reset: 'Too many password reset attempts. Please wait a few minutes and try again.',
};

export interface AuthPayload {
  sub: string;
  email: string | null;
  organisationId: string;
  sid: string;
}

export interface AuthResult {
  accessToken: string;
  tokenType: 'Bearer';
  expiresInSeconds: number;
  profile: AuthProfile;
}

export interface AuthSessionResult {
  /** Body returned to the client. The refresh token is deliberately absent. */
  payload: AuthResult;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface AuthProfile {
  user: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    status: string;
    emailVerified: boolean;
    phoneVerified: boolean;
    createdAt: string;
  };
  organisation: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    phone: string | null;
    address: string | null;
    outletProfile: string | null;
    nearExpiryWarningDays: number;
    defaultUnit: string | null;
    defaultMinStockLevel: number | null;
    onboardingCompletedAt: string | null;
  };
  membership: { role: string; active: boolean; status: string };
  /**
   * The permission keys this member holds, so the interface can show only the
   * destinations they may actually use.
   */
  permissions: string[];
  /** Branches the member may work in; the switcher is built from this list. */
  branches: { id: string; name: string; code: string; isDefault: boolean }[];
  onboarding: OnboardingSummary;
  /** Where the client should land after authentication. */
  nextPath: string;
}

export interface RegistrationChallenge {
  email: string;
  phone: string | null;
  verificationRequired: true;
  expiresInMinutes: number;
  resendAvailableInSeconds: number;
  remainingResends: number;
  /** Only present outside production when the log email transport is active. */
  devCode?: string;
}

interface SessionContext {
  user: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
  };
  organisationId: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private dummyHashPromise: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly sessions: SessionService,
    private readonly rateLimit: RateLimitService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly permissionsService: PermissionsService,
  ) {}

  // ---------------------------------------------------------------- registration

  /**
   * Step one of sign-up. Nothing that can log in is created yet: the workspace
   * and the Owner account are only written once the six-digit code is verified,
   * so an abandoned form cannot squat on an email address or a workspace slug.
   */
  async register(dto: RegisterDto, request: AuthRequestLike): Promise<RegistrationChallenge> {
    const email = normalizeEmail(dto.email);
    const phone = dto.phone ? normalizePhone(dto.phone) : null;

    if (dto.phone && !phone) {
      throw new BadRequestException({
        code: 'INVALID_PHONE',
        message: 'Enter a Nigerian mobile number, for example 0803 123 4567.',
        field: 'phone',
      });
    }
    if (dto.confirmPassword !== undefined && dto.confirmPassword !== dto.password) {
      throw new BadRequestException({
        code: 'PASSWORD_MISMATCH',
        message: 'The two passwords do not match.',
        field: 'confirmPassword',
      });
    }

    const assessment = assessPassword(dto.password, { email, name: dto.name });
    if (!assessment.valid) {
      throw new BadRequestException({
        code: 'WEAK_PASSWORD',
        message: assessment.issues[0],
        field: 'password',
        details: { issues: assessment.issues },
      });
    }

    this.rateLimit.assertAllowed(
      `register:${clientKey(request)}`,
      REGISTER_LIMIT.limit,
      REGISTER_LIMIT.windowMs,
      RATE_LIMIT_MESSAGES.register,
    );

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email }, ...(phone ? [{ phone }] : [])] },
      select: { email: true, phone: true },
    });
    if (existing) {
      throw existing.email === email
        ? new ConflictException({
            code: 'EMAIL_IN_USE',
            message: 'An account already exists for this email address. Try signing in instead.',
            field: 'email',
          })
        : new ConflictException({
            code: 'PHONE_IN_USE',
            message: 'An account already exists for this phone number. Try signing in instead.',
            field: 'phone',
          });
    }

    const pending = await this.prisma.pendingRegistration.findUnique({ where: { email } });
    const now = new Date();
    if (pending) {
      const retryAfter = this.resendCooldownRemaining(pending.lastSentAt, now);
      if (retryAfter > 0) {
        throw new HttpException(
          {
            code: 'VERIFICATION_JUST_SENT',
            message: `We have already sent a code. You can request another in ${retryAfter} seconds.`,
            retryAfterSeconds: retryAfter,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (pending.resendCount >= VERIFICATION_MAX_RESENDS) {
        throw new HttpException(
          {
            code: 'TOO_MANY_RESENDS',
            message: 'This email address has requested too many codes. Contact support or try again later.',
            retryAfterSeconds: this.resendCooldownRemaining(pending.lastSentAt, now),
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_HASH_ROUNDS);
    const code = generateVerificationCode();
    const codeExpiresAt = new Date(now.getTime() + VERIFICATION_CODE_TTL_MINUTES * 60 * 1000);
    const payload = {
      name: dto.name.trim(),
      email,
      phone,
      passwordHash,
      termsAcceptedAt: now,
      verificationCodeHash: hashSecret(code),
      codeExpiresAt,
      attempts: 0,
      lastSentAt: now,
      verifiedAt: null,
      userId: null,
    };

    if (pending) {
      await this.prisma.pendingRegistration.update({
        where: { id: pending.id },
        data: { ...payload, resendCount: pending.resendCount + 1 },
      });
    } else {
      try {
        await this.prisma.pendingRegistration.create({ data: { ...payload, resendCount: 0 } });
      } catch (error) {
        // Two submissions can pass the check above at the same time; the unique
        // index on `email` decides, and the loser gets a normal conflict instead
        // of an opaque 500.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException({
            code: 'EMAIL_IN_USE',
            message: 'An account already exists for this email address. Try signing in instead.',
            field: 'email',
          });
        }
        throw error;
      }
    }

    await this.deliverVerificationCode(email, payload.name, code);

    const challenge: RegistrationChallenge = {
      email: maskEmail(email),
      phone: phone ? maskPhone(phone) : null,
      verificationRequired: true,
      expiresInMinutes: VERIFICATION_CODE_TTL_MINUTES,
      resendAvailableInSeconds: VERIFICATION_RESEND_COOLDOWN_SECONDS,
      remainingResends: VERIFICATION_MAX_RESENDS - ((pending?.resendCount ?? 0) + 0),
    };
    if (this.verificationPreviewEnabled()) {
      challenge.devCode = code;
    }
    return challenge;
  }

  async resendVerification(
    dto: ResendVerificationDto,
    request: AuthRequestLike,
  ): Promise<{ sent: true; resendAvailableInSeconds: number; remainingResends: number }> {
    const email = normalizeEmail(dto.email);
    this.rateLimit.assertAllowed(
      `verify-resend:${clientKey(request)}`,
      EMAIL_VERIFICATION_LIMIT.limit,
      EMAIL_VERIFICATION_LIMIT.windowMs,
      RATE_LIMIT_MESSAGES.verify,
    );

    const pending = await this.prisma.pendingRegistration.findUnique({ where: { email } });
    if (!pending) {
      throw new BadRequestException({
        code: 'REGISTRATION_NOT_FOUND',
        message: 'We could not find a pending registration for this email. Start again to create an account.',
      });
    }

    const now = new Date();
    const retryAfter = this.resendCooldownRemaining(pending.lastSentAt, now);
    if (retryAfter > 0) {
      throw new HttpException(
        {
          code: 'VERIFICATION_JUST_SENT',
          message: `Please wait ${retryAfter} seconds before requesting another code.`,
          retryAfterSeconds: retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (pending.resendCount >= VERIFICATION_MAX_RESENDS) {
      throw new HttpException(
        {
          code: 'TOO_MANY_RESENDS',
          message: 'This email address has requested too many codes. Contact support or try again later.',
          retryAfterSeconds: VERIFICATION_RESEND_COOLDOWN_SECONDS,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = generateVerificationCode();
    await this.prisma.pendingRegistration.update({
      where: { id: pending.id },
      data: {
        verificationCodeHash: hashSecret(code),
        codeExpiresAt: new Date(now.getTime() + VERIFICATION_CODE_TTL_MINUTES * 60 * 1000),
        attempts: 0,
        resendCount: pending.resendCount + 1,
        lastSentAt: now,
      },
    });
    await this.deliverVerificationCode(pending.email, pending.name, code);

    return {
      sent: true,
      resendAvailableInSeconds: VERIFICATION_RESEND_COOLDOWN_SECONDS,
      remainingResends: VERIFICATION_MAX_RESENDS - (pending.resendCount + 1),
    };
  }

  /**
   * Step two of sign-up. Verifying the code is the moment the Owner account, the
   * single workspace, its membership and its onboarding record are created in a
   * single transaction. Submitting the same valid code again returns the session
   * for the already-created account instead of a second workspace.
   */
  async verifyRegistration(
    dto: VerifyRegistrationDto,
    request: AuthRequestLike,
  ): Promise<AuthSessionResult> {
    const email = normalizeEmail(dto.email);
    this.rateLimit.assertAllowed(
      `verify:${clientKey(request)}`,
      EMAIL_VERIFICATION_LIMIT.limit,
      EMAIL_VERIFICATION_LIMIT.windowMs,
      RATE_LIMIT_MESSAGES.verify,
    );

    const pending = await this.prisma.pendingRegistration.findUnique({ where: { email } });
    if (!pending) {
      throw new BadRequestException({
        code: 'REGISTRATION_NOT_FOUND',
        message: 'We could not find a pending registration for this email. Start again to create an account.',
      });
    }

    const now = new Date();
    if (!pending.verifiedAt && pending.codeExpiresAt.getTime() <= now.getTime()) {
      throw new BadRequestException({
        code: 'CODE_EXPIRED',
        message: 'That code has expired. Request a new one to continue.',
      });
    }

    const matches = safeEqual(hashSecret(dto.code.trim()), pending.verificationCodeHash);
    if (!matches) {
      const attempts = pending.attempts + 1;
      await this.prisma.pendingRegistration.update({
        where: { id: pending.id },
        data: { attempts },
      });
      if (attempts >= VERIFICATION_MAX_ATTEMPTS) {
        throw new HttpException(
          {
            code: 'TOO_MANY_ATTEMPTS',
            message: 'Too many incorrect codes. Request a new code to continue.',
            retryAfterSeconds: VERIFICATION_RESEND_COOLDOWN_SECONDS,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new BadRequestException({
        code: 'INVALID_CODE',
        message: 'That code is not correct. Check the six digits and try again.',
        details: { attemptsRemaining: VERIFICATION_MAX_ATTEMPTS - attempts },
      });
    }

    if (pending.verifiedAt && pending.userId) {
      const existing = await this.loadSessionContext(pending.userId);
      if (!existing) {
        throw new ForbiddenException({
          code: 'NO_WORKSPACE',
          message: 'This account is not linked to an active pharmacy workspace. Contact support.',
        });
      }
      return this.issueSessionResult(existing, request);
    }

    let context: SessionContext;
    try {
      context = await this.createWorkspaceFor(pending);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = String(error.meta?.target ?? '');
        throw new ConflictException({
          code: target.includes('phone') ? 'PHONE_IN_USE' : 'EMAIL_IN_USE',
          message: 'An account already exists for this contact. Try signing in instead.',
        });
      }
      throw error;
    }

    await this.audit.record({
      organizationId: context.organisationId,
      actorId: context.user.id,
      action: 'ORGANISATION_REGISTERED',
      entityType: 'Organization',
      entityId: context.organisationId,
      metadata: { ownerEmail: context.user.email },
    });

    return this.issueSessionResult(context, request);
  }

  // -------------------------------------------------------------------- sign in

  async signIn(
    dto: SignInDto | LegacySignInDto,
    request: AuthRequestLike,
  ): Promise<AuthSessionResult> {
    const identifier =
      'identifier' in dto && dto.identifier
        ? dto.identifier
        : ('email' in dto && dto.email) || ('phone' in dto && dto.phone) || '';
    if (!identifier.trim() || !dto.password) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: GENERIC_LOGIN_ERROR,
      });
    }

    this.rateLimit.assertAllowed(
      `signin:${clientKey(request)}`,
      SIGN_IN_LIMIT.limit,
      SIGN_IN_LIMIT.windowMs,
      RATE_LIMIT_MESSAGES.signIn,
    );

    const normalized = normalizeIdentifier(identifier);
    if (!normalized) {
      await this.wastePasswordComparison(dto.password);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: GENERIC_LOGIN_ERROR,
      });
    }

    const user = await this.prisma.user.findFirst({
      where:
        normalized.channel === 'email'
          ? { email: normalized.value }
          : { phone: normalized.value },
      include: {
        memberships: {
          where: { active: true },
          include: { organization: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!user?.passwordHash) {
      await this.wastePasswordComparison(dto.password);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: GENERIC_LOGIN_ERROR,
      });
    }

    if (user.status === 'DEACTIVATED') {
      throw new ForbiddenException({
        code: 'ACCOUNT_DEACTIVATED',
        message: 'This account has been deactivated. Contact your workspace owner.',
      });
    }

    const now = new Date();
    if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
      throw this.accountLocked(user.lockedUntil, now);
    }

    const passwordMatches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatches) {
      const attempts = user.failedLoginAttempts + 1;
      const locked = attempts >= LOGIN_MAX_FAILED_ATTEMPTS;
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: locked ? new Date(now.getTime() + LOGIN_LOCK_MINUTES * 60 * 1000) : null,
        },
      });
      if (locked) {
        throw this.accountLocked(new Date(now.getTime() + LOGIN_LOCK_MINUTES * 60 * 1000), now);
      }
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: GENERIC_LOGIN_ERROR,
        details: { attemptsRemaining: LOGIN_MAX_FAILED_ATTEMPTS - attempts },
      });
    }

    const membership = this.pickMembership(user.memberships);
    if (!membership) {
      throw new ForbiddenException({
        code: 'NO_WORKSPACE',
        message: 'This account is not linked to a pharmacy workspace yet. Ask an owner to invite you.',
      });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: now },
    });

    return this.issueSessionResult(
      {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
        },
        organisationId: membership.organizationId,
      },
      request,
    );
  }

  // ------------------------------------------------------------------- sessions

  async refresh(request: AuthRequestLike, cookieToken?: string | null): Promise<AuthSessionResult> {
    assertTrustedOrigin(request);
    const rotated = await this.sessions.rotate(cookieToken ?? '', describeRequest(request));
    if (!rotated.organisationId) {
      await this.sessions.revokeAllForUser(rotated.userId);
      throw new ForbiddenException({
        code: 'NO_WORKSPACE',
        message: 'This account is not linked to a pharmacy workspace.',
      });
    }

    const context = await this.loadSessionContext(rotated.userId);
    if (context === null) {
      await this.sessions.revokeAllForUser(rotated.userId);
      throw new UnauthorizedException({
        code: 'SESSION_REVOKED',
        message: 'Your access to this workspace has been removed. Please sign in again.',
      });
    }

    return this.issueSessionResult(context, request, {
      sessionId: rotated.sessionId,
      refreshToken: rotated.refreshToken,
      expiresAt: rotated.expiresAt,
    });
  }

  async signOut(request: AuthRequestLike, cookieToken?: string | null): Promise<{ signedOut: true }> {
    assertTrustedOrigin(request);
    await this.sessions.revokeByToken(cookieToken);
    return { signedOut: true };
  }

  async signOutAll(userId: string): Promise<{ signedOut: true }> {
    await this.sessions.revokeAllForUser(userId);
    return { signedOut: true };
  }

  async getProfile(userId: string, organisationId: string): Promise<AuthProfile> {
    return this.buildProfile(userId, organisationId);
  }

  /**
   * Starts a session for an account whose membership was just created by the
   * invitation flow. Kept public so invitations do not need to reimplement
   * token signing or the profile shape.
   */
  async establishSession(
    userId: string,
    organisationId: string,
    request: AuthRequestLike,
  ): Promise<AuthSessionResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, phone: true },
    });
    if (!user) {
      throw new UnauthorizedException({
        code: 'INVALID_SESSION',
        message: 'Your account could not be found. Please sign in again.',
      });
    }
    return this.issueSessionResult({ user, organisationId }, request);
  }

  // ----------------------------------------------------------- password recovery

  /**
   * Always answers with the same message so the endpoint cannot be used to
   * discover whether an email address or phone number has an account. A reset
   * link is only delivered to email because no SMS provider is configured.
   */
  async forgotPassword(
    dto: ForgotPasswordDto,
    request: AuthRequestLike,
  ): Promise<{ message: string }> {
    this.rateLimit.assertAllowed(
      `forgot:${clientKey(request)}`,
      PASSWORD_RESET_LIMIT.limit,
      PASSWORD_RESET_LIMIT.windowMs,
      RATE_LIMIT_MESSAGES.reset,
    );

    const normalized = normalizeIdentifier(dto.identifier ?? '');
    if (normalized?.channel === 'email') {
      const user = await this.prisma.user.findUnique({
        where: { email: normalized.value },
        select: { id: true, name: true, email: true, status: true },
      });
      if (user?.email && user.status === 'ACTIVE') {
        const token = generateOpaqueToken();
        const now = new Date();
        await this.prisma.passwordReset.deleteMany({
          where: { userId: user.id, consumedAt: null },
        });
        await this.prisma.passwordReset.create({
          data: {
            userId: user.id,
            tokenHash: hashSecret(token),
            expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000),
            requestedIp: describeRequest(request).ipAddress ?? null,
          },
        });
        const link = `${this.webAppUrl()}/reset-password?token=${encodeURIComponent(token)}`;
        await this.email.sendTransactional({
          to: user.email,
          subject: 'Reset your Pharmacy Stock Intelligence password',
          text: [
            `Hello${user.name ? ` ${user.name}` : ''},`,
            '',
            'We received a request to reset your password.',
            `Open this link to choose a new password. It expires in ${PASSWORD_RESET_TTL_MINUTES} minutes and can only be used once:`,
            '',
            link,
            '',
            'If you did not ask for this, you can ignore this email. Your password will not change.',
          ].join('\n'),
        });
      }
    }

    return { message: GENERIC_RESET_MESSAGE };
  }

  async resetPassword(dto: ResetPasswordDto, request: AuthRequestLike): Promise<{ message: string }> {
    this.rateLimit.assertAllowed(
      `reset:${clientKey(request)}`,
      PASSWORD_RESET_LIMIT.limit,
      PASSWORD_RESET_LIMIT.windowMs,
      RATE_LIMIT_MESSAGES.reset,
    );

    if (dto.confirmPassword !== undefined && dto.confirmPassword !== dto.password) {
      throw new BadRequestException({
        code: 'PASSWORD_MISMATCH',
        message: 'The two passwords do not match.',
        field: 'confirmPassword',
      });
    }

    const assessment = assessPassword(dto.password);
    if (!assessment.valid) {
      throw new BadRequestException({
        code: 'WEAK_PASSWORD',
        message: assessment.issues[0],
        field: 'password',
        details: { issues: assessment.issues },
      });
    }

    const reset = await this.prisma.passwordReset.findUnique({
      where: { tokenHash: hashSecret(dto.token) },
      include: { user: { select: { id: true, status: true } } },
    });
    if (!reset || reset.consumedAt || reset.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'INVALID_RESET_TOKEN',
        message: 'This password reset link is invalid or has expired. Request a new one.',
      });
    }
    if (reset.user.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'ACCOUNT_DEACTIVATED',
        message: 'This account has been deactivated. Contact your workspace owner.',
      });
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_HASH_ROUNDS);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: reset.userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      this.prisma.passwordReset.update({
        where: { id: reset.id },
        data: { consumedAt: new Date() },
      }),
    ]);

    // A password reset ends every existing session: whoever knew the old
    // password must not keep a live refresh token.
    await this.sessions.revokeAllForUser(reset.userId);

    const membership = await this.prisma.membership.findFirst({
      where: { userId: reset.userId, active: true },
      select: { organizationId: true },
    });
    if (membership) {
      await this.audit.record({
        organizationId: membership.organizationId,
        actorId: reset.userId,
        action: 'PASSWORD_RESET',
        entityType: 'User',
        entityId: reset.userId,
      });
    }

    return { message: 'Your password has been updated. Sign in with your new password.' };
  }

  // -------------------------------------------------------------------- internals

  private async createWorkspaceFor(pending: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    passwordHash: string;
  }): Promise<SessionContext> {
    const now = new Date();
    const baseSlug = slugify(pending.name) || 'pharmacy';
    const slug = `${baseSlug}-${randomSuffix(6)}`;

    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: pending.name,
          email: pending.email,
          phone: pending.phone,
          passwordHash: pending.passwordHash,
          status: 'ACTIVE',
          emailVerifiedAt: now,
          // Only the email address received a code. There is no SMS transport,
          // so the phone number is a sign-in identifier, not a verified contact.
          phoneVerifiedAt: null,
          passwordChangedAt: now,
        },
      });

      const organization = await tx.organization.create({
        data: {
          name: pending.name,
          slug,
          timezone: 'Africa/Lagos',
          currency: 'NGN',
          phone: pending.phone,
          nearExpiryWarningDays: 90,
        },
      });

      await tx.membership.create({
        data: { organizationId: organization.id, userId: user.id, role: 'OWNER' },
      });

      await tx.onboardingProgress.create({
        data: {
          organizationId: organization.id,
          currentStep: 1,
          completedSteps: [],
          status: 'IN_PROGRESS',
        },
      });

      await tx.pendingRegistration.update({
        where: { id: pending.id },
        data: { verifiedAt: now, userId: user.id },
      });

      return { user, organization };
    });

    return {
      user: {
        id: created.user.id,
        name: created.user.name,
        email: created.user.email,
        phone: created.user.phone,
      },
      organisationId: created.organization.id,
    };
  }

  private async loadSessionContext(userId: string): Promise<SessionContext | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        status: true,
        memberships: {
          where: { active: true },
          orderBy: { createdAt: 'asc' },
          select: { organizationId: true, role: true },
        },
      },
    });
    if (!user || user.status !== 'ACTIVE' || user.memberships.length === 0) return null;

    const membership =
      user.memberships.find((entry) => entry.role === 'OWNER') ?? user.memberships[0];

    return {
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
      organisationId: membership.organizationId,
    };
  }

  /** Owners get the workspace they run; everyone else falls back to their first active membership. */
  private pickMembership<T extends { role: string }>(memberships: T[]): T | null {
    if (memberships.length === 0) return null;
    return memberships.find((membership) => membership.role === 'OWNER') ?? memberships[0];
  }

  private async issueSessionResult(
    context: SessionContext,
    request: AuthRequestLike,
    existing?: { sessionId: string; refreshToken: string; expiresAt: Date },
  ): Promise<AuthSessionResult> {
    const session =
      existing ??
      (await this.sessions.create(
        context.user.id,
        context.organisationId,
        describeRequest(request),
      ));

    const accessToken = await this.jwtService.signAsync(
      {
        sub: context.user.id,
        email: context.user.email,
        organisationId: context.organisationId,
        sid: session.sessionId,
      } satisfies AuthPayload,
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    );

    const profile = await this.buildProfile(context.user.id, context.organisationId);
    return {
      payload: {
        accessToken,
        tokenType: 'Bearer',
        expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
        profile,
      },
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  private async buildProfile(userId: string, organisationId: string): Promise<AuthProfile> {
    const [user, organisation, membership, onboarding, staffCount, productCount] =
      await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            status: true,
            emailVerifiedAt: true,
            phoneVerifiedAt: true,
            createdAt: true,
          },
        }),
        this.prisma.organization.findUnique({ where: { id: organisationId } }),
        this.prisma.membership.findUnique({
          where: { organizationId_userId: { organizationId: organisationId, userId } },
          select: { role: true, active: true, status: true },
        }),
        this.prisma.onboardingProgress.findUnique({ where: { organizationId: organisationId } }),
        this.prisma.membership.count({ where: { organizationId: organisationId, active: true } }),
        this.prisma.product.count({ where: { organizationId: organisationId, active: true } }),
      ]);

    if (!user || !organisation || !membership?.active) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You do not have access to this workspace.',
      });
    }

    const permissions = await this.permissionsService.getEffectivePermissions(
      organisationId,
      userId,
      membership.role,
    );
    const branches = await this.branchesFor(organisationId, userId, permissions);

    const summary = buildOnboardingSummary({
      status: onboarding?.status,
      currentStep: onboarding?.currentStep,
      completedSteps: onboarding?.completedSteps,
      completedAt: onboarding?.completedAt,
      hasProfile: Boolean(organisation.outletProfile),
      hasStockSettings: Boolean(organisation.defaultUnit) || organisation.defaultMinStockLevel !== null,
      staffCount,
      productCount,
    });

    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        status: user.status,
        emailVerified: Boolean(user.emailVerifiedAt),
        phoneVerified: Boolean(user.phoneVerifiedAt),
        createdAt: user.createdAt.toISOString(),
      },
      organisation: {
        id: organisation.id,
        name: organisation.name,
        slug: organisation.slug,
        timezone: organisation.timezone,
        currency: organisation.currency,
        phone: organisation.phone,
        address: organisation.address,
        outletProfile: organisation.outletProfile,
        nearExpiryWarningDays: organisation.nearExpiryWarningDays,
        defaultUnit: organisation.defaultUnit,
        defaultMinStockLevel:
          organisation.defaultMinStockLevel !== null
            ? Number(organisation.defaultMinStockLevel)
            : null,
        onboardingCompletedAt: organisation.onboardingCompletedAt
          ? organisation.onboardingCompletedAt.toISOString()
          : null,
      },
      membership: { role: membership.role, active: membership.active, status: membership.status },
      permissions: [...permissions].sort(),
      branches,
      onboarding: summary,
      // Only the Owner can run the setup wizard; staff who join mid-setup go
      // straight to the dashboard instead of a step they cannot save.
      nextPath:
        summary.requiresSetup && membership.role === 'OWNER'
          ? '/onboarding/pharmacy-setup'
          : '/dashboard',
    };
  }

  /**
   * The branches a member can work in. `branch:all` opens every branch;
   * otherwise only the branches the member is assigned to are returned.
   */
  private async branchesFor(
    organizationId: string,
    userId: string,
    permissions: Set<string>,
  ): Promise<AuthProfile['branches']> {
    if (permissions.has('branch:all')) {
      return this.prisma.branch.findMany({
        where: { organizationId },
        select: { id: true, name: true, code: true, isDefault: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      });
    }

    const assignments = await this.prisma.branchStaff.findMany({
      where: { userId, branch: { organizationId } },
      select: { branch: { select: { id: true, name: true, code: true, isDefault: true } } },
      orderBy: { branch: { name: 'asc' } },
    });
    return assignments.map((assignment) => assignment.branch);
  }

  private accountLocked(until: Date, now: Date) {
    const minutes = Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
    return new HttpException(
      {
        code: 'ACCOUNT_LOCKED',
        message: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        retryAfterSeconds: minutes * 60,
      },
      HttpStatus.LOCKED,
    );
  }

  private resendCooldownRemaining(lastSentAt: Date, now: Date): number {
    const elapsedSeconds = Math.floor((now.getTime() - lastSentAt.getTime()) / 1000);
    return Math.max(0, VERIFICATION_RESEND_COOLDOWN_SECONDS - elapsedSeconds);
  }

  private async wastePasswordComparison(password: string): Promise<void> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = bcrypt.hash('unused-placeholder-password', PASSWORD_HASH_ROUNDS);
    }
    await bcrypt.compare(password, await this.dummyHashPromise).catch(() => false);
  }

  private async deliverVerificationCode(email: string, name: string, code: string): Promise<void> {
    const sent = await this.email.sendTransactional({
      to: email,
      subject: 'Your Pharmacy Stock Intelligence verification code',
      text: [
        `Hello ${name},`,
        '',
        `Your verification code is ${code}.`,
        `It expires in ${VERIFICATION_CODE_TTL_MINUTES} minutes. If you did not create an account, ignore this email.`,
      ].join('\n'),
    });

    if (!sent) {
      this.logger.warn(`Verification email for ${maskEmail(email)} could not be delivered.`);
    }
    if (this.verificationPreviewEnabled()) {
      this.logger.log(`[dev] Verification code for ${maskEmail(email)}: ${code}`);
    }
  }

  /**
   * True when the API cannot deliver real email and is running outside
   * production. The code is then echoed to the caller so the two-step flow can
   * be completed locally. This branch is impossible in production.
   */
  private verificationPreviewEnabled(): boolean {
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

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { hashSecret } from './auth.utils';

// @nestjs/jwt ships as ESM; the service only needs a signer for these tests.
jest.mock('@nestjs/jwt', () => ({
  JwtService: class {
    signAsync = jest.fn().mockResolvedValue('access-token');
    sign = jest.fn();
  },
}));

const PASSWORD = 'Harbour-Lantern-47';
const passwordHash = bcrypt.hashSync(PASSWORD, 4);

function buildPrismaMock() {
  const tx = {
    user: { create: jest.fn().mockResolvedValue({ id: 'user-1', name: 'Ada Obi', email: 'ada@pharmacy.ng', phone: null }) },
    organization: { create: jest.fn().mockResolvedValue({ id: 'org-1', name: 'Ada Obi', slug: 'ada-obi-ab12cd' }) },
    membership: { create: jest.fn(), findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
    onboardingProgress: { create: jest.fn() },
    pendingRegistration: { update: jest.fn() },
  };

  return {
    tx,
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    organization: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    membership: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
    },
    onboardingProgress: {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    pendingRegistration: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    passwordReset: {
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    product: { count: jest.fn().mockResolvedValue(0) },
    staffInvitation: { count: jest.fn().mockResolvedValue(0) },
    branch: { findMany: jest.fn().mockResolvedValue([]) },
    branchStaff: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(),
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  const jwt = { signAsync: jest.fn().mockResolvedValue('access-token'), sign: jest.fn() };
  const sessions = {
    create: jest.fn(),
    rotate: jest.fn(),
    revokeByToken: jest.fn(),
    revokeAllForUser: jest.fn(),
    revokeSession: jest.fn(),
  };
  const rateLimit = {
    assertAllowed: jest.fn().mockReturnValue({ allowed: true, remaining: 1, retryAfterSeconds: 0 }),
    reset: jest.fn(),
    consume: jest.fn(),
  };
  const email = { sendTransactional: jest.fn().mockResolvedValue(true), activeTransport: 'log' as const };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const permissions = {
    getEffectivePermissions: jest.fn().mockResolvedValue(new Set(['branch:all'])),
  };

  const request = { headers: {}, ip: '10.0.0.1', socket: {} };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = buildPrismaMock();
    prisma.$transaction.mockImplementation(async (callback: unknown) =>
      typeof callback === 'function'
        ? (callback as (client: unknown) => unknown)(prisma.tx)
        : Promise.all(callback as Promise<unknown>[]),
    );
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      name: 'Ada Obi',
      email: 'ada@pharmacy.ng',
      phone: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    prisma.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      name: 'Ada Obi Pharmacy',
      slug: 'ada-obi-ab12cd',
      timezone: 'Africa/Lagos',
      currency: 'NGN',
      phone: null,
      address: null,
      outletProfile: 'Community pharmacy',
      nearExpiryWarningDays: 90,
      defaultUnit: 'tablet',
      defaultMinStockLevel: null,
      onboardingCompletedAt: null,
    });
    prisma.membership.findUnique.mockResolvedValue({ role: 'OWNER', active: true, status: 'ACTIVE' });
    sessions.create.mockResolvedValue({
      sessionId: 'session-1',
      refreshToken: 'session-1.secret',
      expiresAt: new Date(Date.now() + 60_000),
    });

    service = new AuthService(
      prisma as never,
      jwt as never,
      sessions as never,
      rateLimit as never,
      email as never,
      audit as never,
      permissions as never,
    );
  });

  describe('register', () => {
    const validRequest = {
      name: 'Ada Obi',
      email: 'ada@pharmacy.ng',
      password: PASSWORD,
      termsAccepted: true,
    };

    it('rejects a weak password before touching the database', async () => {
      const error = await service
        .register({ ...validRequest, password: 'short' }, request)
        .catch((thrown) => thrown);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: 'WEAK_PASSWORD', field: 'password' });
      // The form lists every unmet rule, so the whole list has to survive.
      expect(error.getResponse().details.issues).toEqual(
        expect.arrayContaining(['Use at least 10 characters.']),
      );
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.pendingRegistration.create).not.toHaveBeenCalled();
    });

    it('rejects a password confirmation that does not match', async () => {
      const error = await service
        .register({ ...validRequest, confirmPassword: 'Something-Else-19' }, request)
        .catch((thrown) => thrown);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({
        code: 'PASSWORD_MISMATCH',
        field: 'confirmPassword',
      });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('rejects a phone number that is not a Nigerian mobile number', async () => {
      const error = await service
        .register({ ...validRequest, phone: '123456789' }, request)
        .catch((thrown) => thrown);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: 'INVALID_PHONE', field: 'phone' });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('reports an existing account instead of creating a second one', async () => {
      prisma.user.findFirst.mockResolvedValue({ email: 'ada@pharmacy.ng', phone: null });

      const error = await service.register(validRequest, request).catch((thrown) => thrown);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ code: 'EMAIL_IN_USE', field: 'email' });
      expect(prisma.pendingRegistration.create).not.toHaveBeenCalled();
    });

    it('answers 409 when two submissions race on the unique email index', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.pendingRegistration.findUnique.mockResolvedValue(null);
      prisma.pendingRegistration.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
          code: 'P2002',
          clientVersion: '6.16.0',
          meta: { target: ['email'] },
        }),
      );

      const error = await service.register(validRequest, request).catch((thrown) => thrown);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ code: 'EMAIL_IN_USE', field: 'email' });
    });

    it('lets a database connection failure reach the exception filter', async () => {
      prisma.user.findFirst.mockRejectedValue(
        new Prisma.PrismaClientInitializationError(
          'Authentication failed against database server at `localhost`.',
          'P1000',
          '6.16.0',
        ),
      );

      const error = await service.register(validRequest, request).catch((thrown) => thrown);

      // Not translated into a 4xx here: the global filter turns it into
      // 503 DATABASE_UNAVAILABLE and logs the connection hint.
      expect(error).toBeInstanceOf(Prisma.PrismaClientInitializationError);
      expect(prisma.pendingRegistration.create).not.toHaveBeenCalled();
    });

    it('stores a pending registration and masks the contact in the response', async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.pendingRegistration.findUnique.mockResolvedValue(null);
      prisma.pendingRegistration.create.mockResolvedValue({});

      const challenge = await service.register(
        {
          name: 'Ada Obi',
          email: 'ada@pharmacy.ng',
          phone: '08031234567',
          password: PASSWORD,
          termsAccepted: true,
        },
        request,
      );

      expect(prisma.pendingRegistration.create).toHaveBeenCalledTimes(1);
      const stored = prisma.pendingRegistration.create.mock.calls[0][0].data;
      expect(stored.email).toBe('ada@pharmacy.ng');
      expect(stored.phone).toBe('+2348031234567');
      expect(stored.verificationCodeHash).toHaveLength(64);
      expect(stored.passwordHash).not.toBe(PASSWORD);

      expect(challenge.email).toBe('ad**@pharmacy.ng');
      expect(challenge.phone).toBe('+234*******567');
      expect(challenge.verificationRequired).toBe(true);
      // In tests the log transport is active, so the code is echoed for local use.
      expect(challenge.devCode).toMatch(/^\d{6}$/);
    });
  });

  describe('verifyRegistration', () => {
    const pending = {
      id: 'pending-1',
      name: 'Ada Obi',
      email: 'ada@pharmacy.ng',
      phone: null,
      passwordHash,
      verifiedAt: null,
      userId: null,
      attempts: 0,
      codeExpiresAt: new Date(Date.now() + 60_000),
      verificationCodeHash: hashSecret('123456'),
    };

    it('counts a wrong code and reports the remaining attempts', async () => {
      prisma.pendingRegistration.findUnique.mockResolvedValue({ ...pending });

      const error = await service
        .verifyRegistration({ email: 'ada@pharmacy.ng', code: '000000' }, request)
        .catch((thrown) => thrown);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: 'INVALID_CODE' });
      expect(prisma.pendingRegistration.update).toHaveBeenCalledWith({
        where: { id: 'pending-1' },
        data: { attempts: 1 },
      });
    });

    it('creates the owner account, one workspace and the onboarding record', async () => {
      prisma.pendingRegistration.findUnique.mockResolvedValue({ ...pending });

      const result = await service.verifyRegistration(
        { email: 'ada@pharmacy.ng', code: '123456' },
        request,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.tx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'ada@pharmacy.ng',
          emailVerifiedAt: expect.any(Date),
          status: 'ACTIVE',
        }),
      });
      expect(prisma.tx.membership.create).toHaveBeenCalledWith({
        data: { organizationId: 'org-1', userId: 'user-1', role: 'OWNER' },
      });
      expect(prisma.tx.onboardingProgress.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ organizationId: 'org-1', currentStep: 1 }),
      });
      expect(prisma.tx.pendingRegistration.update).toHaveBeenCalledWith({
        where: { id: 'pending-1' },
        data: { verifiedAt: expect.any(Date), userId: 'user-1' },
      });

      expect(result.payload.accessToken).toBe('access-token');
      expect(result.refreshToken).toBe('session-1.secret');
      expect(result.payload.profile.membership.role).toBe('OWNER');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ORGANISATION_REGISTERED' }),
      );
    });

    it('leaves no account behind when the workspace transaction fails', async () => {
      prisma.pendingRegistration.findUnique.mockResolvedValue({ ...pending });
      prisma.tx.organization.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
          code: 'P2003',
          clientVersion: '6.16.0',
        }),
      );

      const error = await service
        .verifyRegistration({ email: 'ada@pharmacy.ng', code: '123456' }, request)
        .catch((thrown) => thrown);

      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      // The transaction rolled back, so no session and no audit row exist for a
      // sign-up that never completed.
      expect(sessions.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('does not create a second workspace when the same code is submitted again', async () => {
      prisma.pendingRegistration.findUnique.mockResolvedValue({
        ...pending,
        verifiedAt: new Date(),
        userId: 'user-1',
      });
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        name: 'Ada Obi',
        email: 'ada@pharmacy.ng',
        phone: null,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        phoneVerifiedAt: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        memberships: [{ organizationId: 'org-1', role: 'OWNER' }],
      });

      await service.verifyRegistration({ email: 'ada@pharmacy.ng', code: '123456' }, request);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.tx.user.create).not.toHaveBeenCalled();
    });
  });

  describe('signIn', () => {
    const baseUser = {
      id: 'user-1',
      name: 'Ada Obi',
      email: 'ada@pharmacy.ng',
      phone: null,
      passwordHash,
      status: 'ACTIVE',
      failedLoginAttempts: 0,
      lockedUntil: null,
      memberships: [{ organizationId: 'org-1', role: 'OWNER', organization: { id: 'org-1', name: 'Ada Obi Pharmacy' } }],
    };

    it('uses one generic message for unknown accounts', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      const error = await service
        .signIn({ identifier: 'nobody@pharmacy.ng', password: PASSWORD }, request)
        .catch((thrown) => thrown);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(error.getResponse()).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Incorrect email, phone number or password.',
      });
    });

    it('accepts a phone number as the identifier', async () => {
      prisma.user.findFirst.mockResolvedValue({ ...baseUser, phone: '+2348031234567' });

      const result = await service.signIn(
        { identifier: '0803 123 4567', password: PASSWORD },
        request,
      );

      expect(prisma.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { phone: '+2348031234567' } }),
      );
      expect(result.payload.profile.nextPath).toBe('/onboarding/pharmacy-setup');
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: expect.objectContaining({ failedLoginAttempts: 0, lockedUntil: null }),
      });
    });

    it('locks the account once the failure limit is reached', async () => {
      prisma.user.findFirst.mockResolvedValue({ ...baseUser, failedLoginAttempts: 4 });

      const error = await service
        .signIn({ identifier: 'ada@pharmacy.ng', password: 'WrongPassw0rd!' }, request)
        .catch((thrown) => thrown);

      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(423);
      expect((error as HttpException).getResponse()).toMatchObject({ code: 'ACCOUNT_LOCKED' });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: expect.objectContaining({
          failedLoginAttempts: 5,
          lockedUntil: expect.any(Date),
        }),
      });
    });

    it('refuses a deactivated account', async () => {
      prisma.user.findFirst.mockResolvedValue({ ...baseUser, status: 'DEACTIVATED' });

      await expect(
        service.signIn({ identifier: 'ada@pharmacy.ng', password: PASSWORD }, request),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('reports an active lockout without comparing the password', async () => {
      prisma.user.findFirst.mockResolvedValue({
        ...baseUser,
        lockedUntil: new Date(Date.now() + 5 * 60_000),
      });

      const error = await service
        .signIn({ identifier: 'ada@pharmacy.ng', password: PASSWORD }, request)
        .catch((thrown) => thrown);

      expect((error as HttpException).getStatus()).toBe(423);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('rejects an expired reset token', async () => {
      prisma.passwordReset.findUnique.mockResolvedValue({
        id: 'reset-1',
        userId: 'user-1',
        consumedAt: null,
        expiresAt: new Date(Date.now() - 1_000),
        user: { id: 'user-1', status: 'ACTIVE' },
      });

      const error = await service
        .resetPassword({ token: 'expired-token', password: PASSWORD }, request)
        .catch((thrown) => thrown);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: 'INVALID_RESET_TOKEN' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects a weak replacement password before loading the token', async () => {
      await expect(
        service.resetPassword({ token: 'tok', password: 'weak' }, request),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.passwordReset.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('forgotPassword', () => {
    it('answers identically for unknown accounts', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.forgotPassword({ identifier: 'nobody@pharmacy.ng' }, request);

      expect(result.message).toBe(
        'If an account exists for this email or phone, we have sent password-reset instructions.',
      );
      expect(email.sendTransactional).not.toHaveBeenCalled();
    });
  });
});

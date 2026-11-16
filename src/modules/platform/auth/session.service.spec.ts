import { UnauthorizedException } from '@nestjs/common';
import { hashSecret } from './auth.utils';
import { SessionService } from './session.service';

describe('SessionService', () => {
  const prisma = {
    authSession: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  let service: SessionService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.authSession.create.mockResolvedValue({});
    prisma.authSession.update.mockResolvedValue({});
    prisma.authSession.updateMany.mockResolvedValue({ count: 1 });
    service = new SessionService(prisma as never);
  });

  describe('create', () => {
    it('stores only a keyed hash of the refresh token', async () => {
      const session = await service.create('user-1', 'org-1', {
        ipAddress: '1.2.3.4',
        userAgent: 'jest',
      });

      expect(session.refreshToken.startsWith(`${session.sessionId}.`)).toBe(true);
      expect(session.refreshToken.length).toBeGreaterThan(session.sessionId.length + 20);
      const stored = prisma.authSession.create.mock.calls[0][0].data;
      expect(stored.refreshTokenHash).toBe(hashSecret(session.refreshToken));
      expect(stored.refreshTokenHash).not.toBe(session.refreshToken);
      expect(stored.ipAddress).toBe('1.2.3.4');
      expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('rotate', () => {
    it('rejects a malformed token without touching the database', async () => {
      await expect(service.rotate('not-a-token')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.authSession.findFirst).not.toHaveBeenCalled();
    });

    it('issues a replacement and revokes the presented session', async () => {
      prisma.authSession.findFirst.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        organisationId: 'org-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        userAgent: 'jest',
      });

      const rotated = await service.rotate('session-1.secret', { ipAddress: '1.2.3.4' });

      expect(rotated.userId).toBe('user-1');
      expect(rotated.organisationId).toBe('org-1');
      expect(rotated.sessionId).not.toBe('session-1');
      expect(prisma.authSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: expect.objectContaining({
          revokedAt: expect.any(Date),
          replacedBySessionId: rotated.sessionId,
        }),
      });
    });

    it('revokes every session when a rotated token is replayed', async () => {
      prisma.authSession.findFirst.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        organisationId: 'org-1',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(service.rotate('session-1.secret')).rejects.toMatchObject({
        response: { code: 'SESSION_REVOKED' },
      });
      expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('refuses an expired session', async () => {
      prisma.authSession.findFirst.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        organisationId: 'org-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1_000),
      });

      await expect(service.rotate('session-1.secret')).rejects.toMatchObject({
        response: { code: 'SESSION_EXPIRED' },
      });
      expect(prisma.authSession.create).not.toHaveBeenCalled();
    });

    it('refuses a session that is not linked to a workspace', async () => {
      prisma.authSession.findFirst.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        organisationId: null,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });

      await expect(service.rotate('session-1.secret')).rejects.toMatchObject({
        response: { code: 'NO_WORKSPACE' },
      });
    });
  });

  describe('revokeByToken', () => {
    it('ignores empty values', async () => {
      await service.revokeByToken(null);
      expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
    });

    it('revokes the matching live session', async () => {
      await service.revokeByToken('session-1.secret');
      expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'session-1',
          refreshTokenHash: hashSecret('session-1.secret'),
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });
});

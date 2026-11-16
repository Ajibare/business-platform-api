import { UnauthorizedException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { REFRESH_TOKEN_TTL_DAYS } from './auth.constants';
import { generateOpaqueToken, hashSecret } from './auth.utils';

export interface SessionMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface RotatedSession extends IssuedSession {
  userId: string;
  organisationId: string | null;
}

/**
 * Refresh tokens are opaque random strings of the form `<sessionId>.<secret>`.
 * Only a keyed hash of the whole value is stored, so a database leak cannot be
 * replayed. The session id prefix keeps lookup a single indexed query instead
 * of a table scan.
 */
@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    organisationId: string | null,
    meta: SessionMeta = {},
  ): Promise<IssuedSession> {
    const sessionId = generateOpaqueToken().slice(0, 24);
    const secret = generateOpaqueToken();
    const refreshToken = `${sessionId}.${secret}`;
    const expiresAt = this.expiryDate();

    await this.prisma.authSession.create({
      data: {
        id: sessionId,
        userId,
        organisationId,
        refreshTokenHash: hashSecret(refreshToken),
        expiresAt,
        userAgent: meta.userAgent?.slice(0, 255) ?? null,
        ipAddress: meta.ipAddress?.slice(0, 64) ?? null,
      },
    });

    return { sessionId, refreshToken, expiresAt };
  }

  /**
   * Validates a refresh token, revokes it and issues its successor in one step.
   * A token that is presented twice means the cookie leaked, so every session
   * for that user is revoked rather than silently minting a new pair.
   */
  async rotate(refreshToken: string, meta: SessionMeta = {}): Promise<RotatedSession> {
    const token = refreshToken?.trim();
    if (!token || !token.includes('.')) {
      throw new UnauthorizedException({
        code: 'INVALID_SESSION',
        message: 'Your session has ended. Please sign in again.',
      });
    }

    const sessionId = token.split('.')[0];
    const session = await this.prisma.authSession.findFirst({
      where: { id: sessionId, refreshTokenHash: hashSecret(token) },
    });

    if (!session) {
      throw new UnauthorizedException({
        code: 'INVALID_SESSION',
        message: 'Your session has ended. Please sign in again.',
      });
    }

    if (session.revokedAt) {
      await this.revokeAllForUser(session.userId);
      throw new UnauthorizedException({
        code: 'SESSION_REVOKED',
        message: 'Your session was revoked. Please sign in again.',
      });
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      await this.prisma.authSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException({
        code: 'SESSION_EXPIRED',
        message: 'Your session expired. Please sign in again.',
      });
    }

    if (!session.organisationId) {
      throw new UnauthorizedException({
        code: 'NO_WORKSPACE',
        message: 'Your account is not linked to a pharmacy workspace.',
      });
    }

    const replacement = await this.create(session.userId, session.organisationId, {
      ...meta,
      userAgent: meta.userAgent ?? session.userAgent,
    });

    await this.prisma.authSession.update({
      where: { id: session.id },
      data: {
        revokedAt: new Date(),
        lastUsedAt: new Date(),
        replacedBySessionId: replacement.sessionId,
      },
    });

    return {
      ...replacement,
      userId: session.userId,
      organisationId: session.organisationId,
    };
  }

  async revokeByToken(refreshToken: string | null | undefined): Promise<void> {
    const token = refreshToken?.trim();
    if (!token || !token.includes('.')) return;
    await this.prisma.authSession.updateMany({
      where: { id: token.split('.')[0], refreshTokenHash: hashSecret(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeSession(sessionId: string | null | undefined): Promise<void> {
    if (!sessionId) return;
    await this.prisma.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private expiryDate(): Date {
    return new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  }
}

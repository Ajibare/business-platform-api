import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../../database/prisma.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthTokenPayload {
  sub: string;
  email: string;
  organisationId: string;
  type?: string;
}

@Injectable()
export class AuthService {
  private readonly revokedRefreshTokens = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async signup(dto: SignupDto): Promise<AuthTokens> {
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash },
    });
    const organization = await this.prisma.organization.create({
      data: {
        name: dto.name,
        slug: dto.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      },
    });
    const organizationId = organization.id;
    if (!organizationId) {
      throw new Error('Failed to create organization');
    }
    await this.prisma.membership.create({
      data: {
        organizationId,
        userId: user.id,
        role: 'OWNER',
      },
    });
    return this.issueTokens(user.id, dto.email, organizationId);
  }

  async login(dto: LoginDto): Promise<AuthTokens> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { memberships: { where: { active: true } } },
    });
    if (!user?.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const organisationId = user.memberships?.[0]?.organizationId;
    if (!organisationId) {
      throw new UnauthorizedException('User has no active organisation');
    }
    return this.issueTokens(user.id, dto.email, organisationId);
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const payload = await this.verifyRefreshToken(refreshToken);
    return this.issueTokens(payload.sub, payload.email, payload.organisationId);
  }

  async logout(refreshToken: string): Promise<void> {
    this.revokedRefreshTokens.add(refreshToken);
  }

  private async issueTokens(
    userId: string,
    email: string,
    organisationId: string,
  ): Promise<AuthTokens> {
    const accessToken = this.jwtService.sign({
      sub: userId,
      email,
      organisationId,
    });
    const refreshToken = this.jwtService.sign(
      { sub: userId, email, organisationId, type: 'refresh' },
      { expiresIn: '7d' },
    );
    return { accessToken, refreshToken };
  }

  private async verifyRefreshToken(
    refreshToken: string,
  ): Promise<AuthTokenPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<AuthTokenPayload>(
        refreshToken,
      );
      if (payload.type !== 'refresh') {
        throw new UnauthorizedException('Invalid token type');
      }
      if (this.revokedRefreshTokens.has(refreshToken)) {
        throw new UnauthorizedException('Token revoked');
      }
      return payload;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException('Invalid refresh token');
    }
  }
}

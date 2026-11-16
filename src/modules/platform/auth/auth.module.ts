import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { ACCESS_TOKEN_TTL_SECONDS } from './auth.constants';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { RateLimitService } from './rate-limit.service';
import { SessionService } from './session.service';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'change-me-in-production',
      signOptions: { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    }),
    NotificationsModule,
    AuditModule,
  ],
  controllers: [AuthController, InvitationsController, OnboardingController],
  providers: [
    AuthService,
    SessionService,
    RateLimitService,
    InvitationsService,
    OnboardingService,
  ],
  exports: [AuthService],
})
export class AuthModule {}

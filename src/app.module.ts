import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './modules/platform/auth/auth.module';
import { AuditModule } from './modules/platform/audit/audit.module';
import { BillingModule } from './modules/platform/billing/billing.module';
import { DatabaseModule } from './database/database.module';
import { FilesModule } from './modules/platform/files/files.module';
import { MembershipsModule } from './modules/platform/memberships/memberships.module';
import { NotificationsModule } from './modules/platform/notifications/notifications.module';
import { OrganisationsModule } from './modules/platform/organisations/organisations.module';
import { PermissionsModule } from './modules/platform/permissions/permissions.module';
import { PharmacyModule } from './modules/products/pharmacy/pharmacy.module';
import { SubscriptionsModule } from './modules/platform/subscriptions/subscriptions.module';
import { UsersModule } from './modules/platform/users/users.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    UsersModule,
    OrganisationsModule,
    MembershipsModule,
    PermissionsModule,
    SubscriptionsModule,
    BillingModule,
    NotificationsModule,
    AuditModule,
    FilesModule,
    PharmacyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

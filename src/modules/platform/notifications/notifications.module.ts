import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { EmailService } from './email.service';
import { ExpiryRemindersService } from './expiry-reminders.service';
import { DailyReportService } from './daily-report.service';
import { NotificationScheduler } from './notification-scheduler.service';

@Module({
  imports: [AuditModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    EmailService,
    ExpiryRemindersService,
    DailyReportService,
    NotificationScheduler,
  ],
  exports: [NotificationsService, EmailService, ExpiryRemindersService, DailyReportService],
})
export class NotificationsModule {}

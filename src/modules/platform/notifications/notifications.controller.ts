import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { NotificationsService } from './notifications.service';
import { EmailService } from './email.service';
import { ExpiryRemindersService } from './expiry-reminders.service';
import { DailyReportService } from './daily-report.service';
import { UpdateNotificationPreferencesDto } from './dto/update-preferences.dto';
import { CreateNotificationRecipientDto } from './dto/create-recipient.dto';
import { UpdateNotificationRecipientDto } from './dto/update-recipient.dto';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';

@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly expiryRemindersService: ExpiryRemindersService,
    private readonly dailyReportService: DailyReportService,
  ) {}

  @Get()
  list(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Query() query: ListNotificationsDto,
  ) {
    return this.notificationsService.listNotifications(organizationId, userId, query);
  }

  @Get('unread-count')
  unreadCount(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.notificationsService.unreadCount(organizationId, userId);
  }

  @Get('capabilities')
  capabilities() {
    return {
      data: {
        inAppNotifications: true,
        emailNotifications: true,
        expiryReminders: true,
        salesNotificationsAvailable: true,
        dailySalesReports: true,
        emailTransport: this.emailService.activeTransport,
      },
    };
  }

  @Get('preferences')
  getPreferences(@CurrentUser('organisationId') organizationId: string) {
    return this.notificationsService
      .getPreferences(organizationId)
      .then((preferences) => ({ data: preferences }));
  }

  @Patch('preferences')
  @Roles(Role.OWNER, Role.MANAGER)
  async updatePreferences(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    const preferences = await this.notificationsService.updatePreferences(
      organizationId,
      userId,
      dto,
    );
    return { data: preferences };
  }

  /** Preview of the daily sales summary for the current or requested business day. */
  @Get('daily-report')
  @Roles(Role.OWNER, Role.MANAGER)
  async previewDailyReport(
    @CurrentUser('organisationId') organizationId: string,
    @Query('date') date?: string,
  ) {
    const report = await this.dailyReportService.buildReport(organizationId, date);
    return { data: report };
  }

  /** Sends the daily summary immediately, ignoring the configured delivery time. */
  @Post('daily-report/send')
  @Roles(Role.OWNER, Role.MANAGER)
  async sendDailyReport(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Body() body: { date?: string },
  ) {
    const result = await this.dailyReportService.sendNow(organizationId, userId, body?.date);
    return { data: result };
  }

  @Get('recipients')
  listRecipients(@CurrentUser('organisationId') organizationId: string) {
    return this.notificationsService.listRecipients(organizationId);
  }

  @Post('recipients')
  @Roles(Role.OWNER, Role.MANAGER)
  createRecipient(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateNotificationRecipientDto,
  ) {
    return this.notificationsService.createRecipient(organizationId, userId, dto);
  }

  @Patch('recipients/:id')
  @Roles(Role.OWNER, Role.MANAGER)
  updateRecipient(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateNotificationRecipientDto,
  ) {
    return this.notificationsService.updateRecipient(organizationId, userId, id, dto);
  }

  @Delete('recipients/:id')
  @Roles(Role.OWNER, Role.MANAGER)
  deactivateRecipient(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ) {
    return this.notificationsService.deactivateRecipient(organizationId, userId, id);
  }

  @Get('deliveries')
  @Roles(Role.OWNER, Role.MANAGER)
  listDeliveries(
    @CurrentUser('organisationId') organizationId: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.emailService.listDeliveries(
      organizationId,
      status || undefined,
      limit ? Number(limit) : 50,
    );
  }

  @Post('deliveries/:id/retry')
  @Roles(Role.OWNER, Role.MANAGER)
  retryDelivery(
    @CurrentUser('organisationId') organizationId: string,
    @Param('id') id: string,
  ) {
    return this.emailService.retryDelivery(organizationId, id);
  }

  @Post('read-all')
  markAllRead(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
  ) {
    return this.notificationsService.markAllRead(organizationId, userId);
  }

  @Post(':id/read')
  markRead(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ) {
    return this.notificationsService.markRead(organizationId, userId, id);
  }

  @Post('expiry-scan')
  @Roles(Role.OWNER, Role.MANAGER)
  async runExpiryScan(
    @CurrentUser('organisationId') organizationId: string,
    @CurrentUser('sub') userId: string,
  ) {
    const summary = await this.expiryRemindersService.runScan({
      organizationId,
      actorId: userId,
      trigger: 'manual',
    });
    return { data: summary };
  }
}

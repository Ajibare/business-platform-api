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
import { NotificationsService } from './notifications.service';
import { EmailService } from './email.service';
import { ExpiryRemindersService } from './expiry-reminders.service';
import { DailyReportService } from './daily-report.service';
import { UpdateNotificationPreferencesDto } from './dto/update-preferences.dto';
import { CreateNotificationRecipientDto } from './dto/create-recipient.dto';
import { UpdateNotificationRecipientDto } from './dto/update-recipient.dto';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { CurrentActor } from '../../../common/decorators/current-actor.decorator';
import { CurrentBranch } from '../../../common/decorators/current-branch.decorator';
import { RequirePermission } from '../../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../../common/guards/permissions.guard';
import { BranchScopeGuard } from '../../../common/guards/branch-scope.guard';
import type { RequestActor } from '../branches/branch-access.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard, PermissionsGuard, BranchScopeGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly expiryRemindersService: ExpiryRemindersService,
    private readonly dailyReportService: DailyReportService,
  ) {}

  @Get()
  @RequirePermission('notification:read')
  list(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
    @Query() query: ListNotificationsDto,
  ) {
    return this.notificationsService.listNotifications(
      actor.organizationId,
      actor.userId,
      branchIds,
      query,
    );
  }

  @Get('unread-count')
  @RequirePermission('notification:read')
  unreadCount(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
  ) {
    return this.notificationsService.unreadCount(actor.organizationId, actor.userId, branchIds);
  }

  @Get('capabilities')
  @RequirePermission('notification:read')
  capabilities() {
    return {
      data: {
        inAppNotifications: true,
        emailNotifications: true,
        expiryReminders: true,
        salesNotificationsAvailable: true,
        dailySalesReports: true,
        dailyReportPerBranch: true,
        emailTransport: this.emailService.activeTransport,
      },
    };
  }

  @Get('preferences')
  @RequirePermission('notification:read')
  getPreferences(@CurrentActor() actor: RequestActor) {
    return this.notificationsService
      .getPreferences(actor.organizationId)
      .then((preferences) => ({ data: preferences }));
  }

  @Patch('preferences')
  @RequirePermission('notification:manage')
  async updatePreferences(
    @CurrentActor() actor: RequestActor,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    const preferences = await this.notificationsService.updatePreferences(
      actor.organizationId,
      actor.userId,
      dto,
    );
    return { data: preferences };
  }

  /**
   * Preview of the daily sales summary for the current or requested business
   * day: one report, or one per branch when the workspace reports per branch.
   */
  @Get('daily-report')
  @RequirePermission('report:read')
  async previewDailyReport(
    @CurrentActor() actor: RequestActor,
    @Query('date') date?: string,
  ) {
    const reports = await this.dailyReportService.buildReports(actor.organizationId, date);
    return { data: { reports } };
  }

  /** Sends the daily summary immediately, ignoring the configured delivery time. */
  @Post('daily-report/send')
  @RequirePermission('notification:manage')
  async sendDailyReport(
    @CurrentActor() actor: RequestActor,
    @Body() body: { date?: string },
  ) {
    const result = await this.dailyReportService.sendNow(
      actor.organizationId,
      actor.userId,
      body?.date,
    );
    return { data: result };
  }

  @Get('recipients')
  @RequirePermission('notification:read')
  listRecipients(@CurrentActor() actor: RequestActor) {
    return this.notificationsService.listRecipients(actor.organizationId);
  }

  @Post('recipients')
  @RequirePermission('notification:manage')
  createRecipient(
    @CurrentActor() actor: RequestActor,
    @Body() dto: CreateNotificationRecipientDto,
  ) {
    return this.notificationsService.createRecipient(actor.organizationId, actor.userId, dto);
  }

  @Patch('recipients/:id')
  @RequirePermission('notification:manage')
  updateRecipient(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
    @Body() dto: UpdateNotificationRecipientDto,
  ) {
    return this.notificationsService.updateRecipient(
      actor.organizationId,
      actor.userId,
      id,
      dto,
    );
  }

  @Delete('recipients/:id')
  @RequirePermission('notification:manage')
  deactivateRecipient(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
  ) {
    return this.notificationsService.deactivateRecipient(actor.organizationId, actor.userId, id);
  }

  @Get('deliveries')
  @RequirePermission('notification:manage')
  listDeliveries(
    @CurrentActor() actor: RequestActor,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.emailService.listDeliveries(
      actor.organizationId,
      status || undefined,
      limit ? Number(limit) : 50,
    );
  }

  @Post('deliveries/:id/retry')
  @RequirePermission('notification:manage')
  retryDelivery(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
  ) {
    return this.emailService.retryDelivery(actor.organizationId, id);
  }

  @Post('read-all')
  @RequirePermission('notification:read')
  markAllRead(
    @CurrentActor() actor: RequestActor,
    @CurrentBranch('branchIds') branchIds: string[],
  ) {
    return this.notificationsService.markAllRead(actor.organizationId, actor.userId, branchIds);
  }

  @Post(':id/read')
  @RequirePermission('notification:read')
  markRead(
    @CurrentActor() actor: RequestActor,
    @Param('id') id: string,
  ) {
    return this.notificationsService.markRead(actor.organizationId, actor.userId, id);
  }

  @Post('expiry-scan')
  @RequirePermission('expiry:read')
  async runExpiryScan(@CurrentActor() actor: RequestActor) {
    const summary = await this.expiryRemindersService.runScan({
      organizationId: actor.organizationId,
      actorId: actor.userId,
      trigger: 'manual',
    });
    return { data: summary };
  }
}

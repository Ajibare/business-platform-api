import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NotificationPreference } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateNotificationRecipientDto } from './dto/create-recipient.dto';
import { UpdateNotificationRecipientDto } from './dto/update-recipient.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-preferences.dto';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import {
  DEFAULT_REMINDER_INTERVAL_DAYS,
  DEFAULT_REMINDER_LEAD_DAYS,
} from './notification-rules';
import { normaliseDeliveryTime } from './daily-report.rules';

export interface NotificationPreferenceRecord {
  organizationId: string;
  inAppEnabled: boolean;
  emailEnabled: boolean;
  expiryRemindersEnabled: boolean;
  saleNotificationsEnabled: boolean;
  reminderLeadDays: number;
  reminderIntervalDays: number;
  dailyReportEnabled: boolean;
  dailyReportTime: string;
  dailyReportTimezone: string | null;
  updatedAt: Date;
}

function toPreferenceRecord(preferences: NotificationPreference): NotificationPreferenceRecord {
  return {
    organizationId: preferences.organizationId,
    inAppEnabled: preferences.inAppEnabled,
    emailEnabled: preferences.emailEnabled,
    expiryRemindersEnabled: preferences.expiryRemindersEnabled,
    saleNotificationsEnabled: preferences.saleNotificationsEnabled,
    reminderLeadDays: preferences.reminderLeadDays,
    reminderIntervalDays: preferences.reminderIntervalDays,
    dailyReportEnabled: preferences.dailyReportEnabled,
    dailyReportTime: normaliseDeliveryTime(preferences.dailyReportTime),
    dailyReportTimezone: preferences.dailyReportTimezone,
    updatedAt: preferences.updatedAt,
  };
}

/** Rejects timezone identifiers that the runtime cannot format with. */
function assertTimeZone(timeZone: string): string {
  const value = timeZone.trim();
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return value;
  } catch {
    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: `"${value}" is not a recognised timezone identifier.`,
    });
  }
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async getPreferences(organizationId: string): Promise<NotificationPreferenceRecord> {
    const preferences = await this.prisma.notificationPreference.upsert({
      where: { organizationId },
      create: {
        organizationId,
        reminderLeadDays: DEFAULT_REMINDER_LEAD_DAYS,
        reminderIntervalDays: DEFAULT_REMINDER_INTERVAL_DAYS,
      },
      update: {},
    });

    return toPreferenceRecord(preferences);
  }

  async updatePreferences(
    organizationId: string,
    actorId: string,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferenceRecord> {
    // The upsert inside getPreferences guarantees the row exists before update.
    await this.getPreferences(organizationId);

    const dailyReportTimezone =
      dto.dailyReportTimezone === undefined
        ? {}
        : {
            dailyReportTimezone: dto.dailyReportTimezone
              ? assertTimeZone(dto.dailyReportTimezone)
              : null,
          };

    const updated = await this.prisma.notificationPreference.update({
      where: { organizationId },
      data: {
        ...(dto.inAppEnabled !== undefined ? { inAppEnabled: dto.inAppEnabled } : {}),
        ...(dto.emailEnabled !== undefined ? { emailEnabled: dto.emailEnabled } : {}),
        ...(dto.expiryRemindersEnabled !== undefined
          ? { expiryRemindersEnabled: dto.expiryRemindersEnabled }
          : {}),
        ...(dto.saleNotificationsEnabled !== undefined
          ? { saleNotificationsEnabled: dto.saleNotificationsEnabled }
          : {}),
        ...(dto.reminderLeadDays !== undefined ? { reminderLeadDays: dto.reminderLeadDays } : {}),
        ...(dto.reminderIntervalDays !== undefined
          ? { reminderIntervalDays: dto.reminderIntervalDays }
          : {}),
        ...(dto.dailyReportEnabled !== undefined
          ? { dailyReportEnabled: dto.dailyReportEnabled }
          : {}),
        ...(dto.dailyReportTime !== undefined
          ? { dailyReportTime: normaliseDeliveryTime(dto.dailyReportTime) }
          : {}),
        ...dailyReportTimezone,
      },
    });

    await this.auditService.record({
      organizationId,
      actorId,
      action: 'NOTIFICATION_PREFERENCES_UPDATED',
      entityType: 'NotificationPreference',
      entityId: organizationId,
      metadata: { ...dto },
    });

    return toPreferenceRecord(updated);
  }

  async listNotifications(organizationId: string, userId: string, query: ListNotificationsDto) {
    const preferences = await this.getPreferences(organizationId);
    if (!preferences.inAppEnabled) {
      return { data: [], meta: { total: 0, unread: 0, inAppEnabled: false } };
    }

    const limit = query.limit ?? 50;
    const unreadOnly = query.unreadOnly === 'true';

    const notifications = await this.prisma.notification.findMany({
      where: {
        organizationId,
        ...(unreadOnly ? { reads: { none: { userId } } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { reads: { where: { userId }, select: { readAt: true } } },
    });

    const unread = await this.prisma.notification.count({
      where: { organizationId, reads: { none: { userId } } },
    });

    return {
      data: notifications.map((notification) => ({
        id: notification.id,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        severity: notification.severity,
        productId: notification.productId,
        batchId: notification.batchId,
        metadata: notification.metadata,
        createdAt: notification.createdAt,
        readAt: notification.reads[0]?.readAt ?? null,
      })),
      meta: { total: notifications.length, unread, inAppEnabled: true },
    };
  }

  async unreadCount(organizationId: string, userId: string) {
    const preferences = await this.getPreferences(organizationId);
    if (!preferences.inAppEnabled) {
      return { data: { unread: 0, inAppEnabled: false } };
    }

    const unread = await this.prisma.notification.count({
      where: { organizationId, reads: { none: { userId } } },
    });
    return { data: { unread, inAppEnabled: true } };
  }

  async markRead(organizationId: string, userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, organizationId },
      select: { id: true },
    });
    if (!notification) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Notification not found' });
    }

    const read = await this.prisma.notificationRead.upsert({
      where: { notificationId_userId: { notificationId, userId } },
      create: { notificationId, userId },
      update: {},
    });

    return { data: { id: notificationId, readAt: read.readAt } };
  }

  async markAllRead(organizationId: string, userId: string) {
    const unread = await this.prisma.notification.findMany({
      where: { organizationId, reads: { none: { userId } } },
      select: { id: true },
    });

    if (unread.length > 0) {
      await this.prisma.notificationRead.createMany({
        data: unread.map((notification) => ({ notificationId: notification.id, userId })),
        skipDuplicates: true,
      });
    }

    return { data: { marked: unread.length } };
  }

  async listRecipients(organizationId: string) {
    const recipients = await this.prisma.notificationRecipient.findMany({
      where: { organizationId },
      orderBy: [{ active: 'desc' }, { email: 'asc' }],
    });

    return {
      data: recipients.map((recipient) => ({
        id: recipient.id,
        email: recipient.email,
        name: recipient.name,
        active: recipient.active,
        receivesExpiry: recipient.receivesExpiry,
        receivesSales: recipient.receivesSales,
        createdAt: recipient.createdAt,
        updatedAt: recipient.updatedAt,
      })),
    };
  }

  async createRecipient(
    organizationId: string,
    actorId: string,
    dto: CreateNotificationRecipientDto,
  ) {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.notificationRecipient.findFirst({
      where: { organizationId, email },
    });
    if (existing) {
      throw new ConflictException({
        code: 'DUPLICATE_REQUEST',
        message: 'This email address is already a notification recipient.',
      });
    }

    const recipient = await this.prisma.notificationRecipient.create({
      data: {
        organizationId,
        email,
        name: dto.name?.trim() || null,
        receivesExpiry: dto.receivesExpiry ?? true,
        receivesSales: dto.receivesSales ?? false,
      },
    });

    await this.auditService.record({
      organizationId,
      actorId,
      action: 'NOTIFICATION_RECIPIENT_ADDED',
      entityType: 'NotificationRecipient',
      entityId: recipient.id,
      metadata: { email },
    });

    return {
      data: {
        id: recipient.id,
        email: recipient.email,
        name: recipient.name,
        active: recipient.active,
        receivesExpiry: recipient.receivesExpiry,
        receivesSales: recipient.receivesSales,
      },
    };
  }

  async updateRecipient(
    organizationId: string,
    actorId: string,
    id: string,
    dto: UpdateNotificationRecipientDto,
  ) {
    const recipient = await this.prisma.notificationRecipient.findFirst({
      where: { id, organizationId },
    });
    if (!recipient) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recipient not found' });
    }

    const email = dto.email ? dto.email.trim().toLowerCase() : undefined;
    if (email && email !== recipient.email) {
      const duplicate = await this.prisma.notificationRecipient.findFirst({
        where: { organizationId, email, NOT: { id } },
      });
      if (duplicate) {
        throw new ConflictException({
          code: 'DUPLICATE_REQUEST',
          message: 'This email address is already a notification recipient.',
        });
      }
    }

    const updated = await this.prisma.notificationRecipient.update({
      where: { id },
      data: {
        ...(email ? { email } : {}),
        ...(dto.name !== undefined ? { name: dto.name.trim() || null } : {}),
        ...(dto.receivesExpiry !== undefined ? { receivesExpiry: dto.receivesExpiry } : {}),
        ...(dto.receivesSales !== undefined ? { receivesSales: dto.receivesSales } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });

    await this.auditService.record({
      organizationId,
      actorId,
      action: 'NOTIFICATION_RECIPIENT_UPDATED',
      entityType: 'NotificationRecipient',
      entityId: updated.id,
      metadata: { ...dto },
    });

    return {
      data: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        active: updated.active,
        receivesExpiry: updated.receivesExpiry,
        receivesSales: updated.receivesSales,
      },
    };
  }

  async deactivateRecipient(organizationId: string, actorId: string, id: string) {
    const recipient = await this.prisma.notificationRecipient.findFirst({
      where: { id, organizationId },
    });
    if (!recipient) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Recipient not found' });
    }

    await this.prisma.notificationRecipient.update({
      where: { id },
      data: { active: false },
    });

    await this.auditService.record({
      organizationId,
      actorId,
      action: 'NOTIFICATION_RECIPIENT_REMOVED',
      entityType: 'NotificationRecipient',
      entityId: id,
      metadata: { email: recipient.email },
    });

    return { data: { id, active: false } };
  }

  async activeRecipients(organizationId: string, purpose: 'expiry' | 'sales') {
    return this.prisma.notificationRecipient.findMany({
      where: {
        organizationId,
        active: true,
        ...(purpose === 'expiry' ? { receivesExpiry: true } : { receivesSales: true }),
      },
      select: { email: true },
    });
  }
}

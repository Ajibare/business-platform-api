import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from './notifications.service';
import { EmailService } from './email.service';
import {
  EXPIRED_GRACE_DAYS,
  EXPIRY_NOTIFICATION_TYPE,
  buildExpiryReminderCopy,
  defaultBatchUrl,
  resolveExpiryMilestone,
} from './notification-rules';
import { addDaysKey, localDateKey } from '../../../common/utils/time';

export interface ExpiryScanOptions {
  organizationId?: string;
  actorId?: string;
  trigger: 'manual' | 'scheduled';
}

export interface ExpiryScanSummary {
  organizationsScanned: number;
  batchesScanned: number;
  remindersCreated: number;
  emailsQueued: number;
  emailsSent: number;
  emailsFailed: number;
  alreadyNotified: number;
}

/**
 * Creates expiry reminders for batches inside the configured reminder window.
 *
 * Deduplication is enforced by a unique `(organizationId, dedupeKey)` constraint,
 * where the key contains the batch id and the reminder window start date. The
 * scan can therefore run repeatedly or from several instances without producing
 * duplicate reminders.
 */
@Injectable()
export class ExpiryRemindersService {
  private readonly logger = new Logger(ExpiryRemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly auditService: AuditService,
  ) {}

  async runScan(options: ExpiryScanOptions): Promise<ExpiryScanSummary> {
    const summary: ExpiryScanSummary = {
      organizationsScanned: 0,
      batchesScanned: 0,
      remindersCreated: 0,
      emailsQueued: 0,
      emailsSent: 0,
      emailsFailed: 0,
      alreadyNotified: 0,
    };

    const organizations = await this.prisma.organization.findMany({
      where: options.organizationId ? { id: options.organizationId } : {},
      select: { id: true, name: true, timezone: true },
    });

    const now = new Date();
    const webUrl = process.env.WEB_APP_URL ?? process.env.APP_PUBLIC_URL ?? 'http://localhost:3000';

    for (const organization of organizations) {
      const preferences = await this.notifications.getPreferences(organization.id);
      if (!preferences.expiryRemindersEnabled) continue;
      if (!preferences.inAppEnabled && !preferences.emailEnabled) continue;

      summary.organizationsScanned += 1;
      const timeZone = organization.timezone || 'Africa/Lagos';
      const todayKey = localDateKey(now, timeZone);
      const leadDays = preferences.reminderLeadDays;

      // Fetch a slightly wider window than required so just-expired batches can
      // still receive their single expiry notification.
      const windowStart = new Date(
        `${addDaysKey(todayKey, -(EXPIRED_GRACE_DAYS + 2))}T00:00:00.000Z`,
      );
      const windowEnd = new Date(`${addDaysKey(todayKey, leadDays + 1)}T00:00:00.000Z`);

      const batches = await this.prisma.batch.findMany({
        where: {
          organizationId: organization.id,
          expiryDate: { not: null, gte: windowStart, lt: windowEnd },
        },
        include: {
          product: { select: { id: true, name: true, unit: true } },
          balance: { select: { quantity: true } },
        },
        orderBy: { expiryDate: 'asc' },
      });

      const recipients = preferences.emailEnabled
        ? await this.notifications.activeRecipients(organization.id, 'expiry')
        : [];
      // Branch tagged recipients only hear about their own branch's batches.
      const recipientsByBranch = new Map<string, string[]>();
      const recipientsFor = async (branchId: string): Promise<string[]> => {
        const cached = recipientsByBranch.get(branchId);
        if (cached) return cached;
        const tagged = recipients
          .filter((recipient) => recipient.branchId === null || recipient.branchId === branchId)
          .map((recipient) => recipient.email);
        recipientsByBranch.set(branchId, tagged);
        return tagged;
      };

      for (const batch of batches) {
        if (!batch.expiryDate) continue;
        summary.batchesScanned += 1;

        const quantity = batch.balance ? this.toQuantity(batch.balance.quantity) : 0;
        // Depleted, written-off or returned batches no longer need reminders.
        if (quantity <= 0) continue;

        const milestone = resolveExpiryMilestone({
          expiryDate: batch.expiryDate,
          todayKey,
          leadDays,
          dedupePrefix: `expiry-reminder:${batch.id}`,
        });
        // Outside every milestone window, or expired too long ago.
        if (!milestone) continue;

        const createdAt = await this.createReminder({
          organizationId: organization.id,
          organizationName: organization.name,
          branchId: batch.branchId,
          batchId: batch.id,
          productId: batch.productId,
          productName: batch.product.name,
          unit: batch.product.unit,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          quantity,
          daysRemaining: milestone.daysRemaining,
          milestone: milestone.milestone,
          action: milestone.action,
          severity: milestone.severity,
          dedupeKey: milestone.dedupeKey,
          timeZone,
          actionUrl: defaultBatchUrl(webUrl, batch.id),
        });

        if (!createdAt) {
          summary.alreadyNotified += 1;
          continue;
        }

        summary.remindersCreated += 1;

        if (preferences.emailEnabled) {
          const branchRecipients = await recipientsFor(batch.branchId);
          if (branchRecipients.length === 0) continue;
          const notificationId = createdAt.notificationId;
          summary.emailsQueued += await this.email.queueForNotification(
            organization.id,
            notificationId,
            branchRecipients,
          );
          const outcome = await this.email.sendPendingForNotification(notificationId);
          summary.emailsSent += outcome.sent;
          summary.emailsFailed += outcome.failed;
        }
      }
    }

    if (options.trigger === 'manual' && options.organizationId) {
      await this.auditService.record({
        organizationId: options.organizationId,
        actorId: options.actorId ?? null,
        action: 'EXPIRY_REMINDER_SCAN',
        entityType: 'Notification',
        entityId: null,
        metadata: { ...summary },
      });
    }

    if (summary.remindersCreated > 0 || summary.emailsFailed > 0) {
      this.logger.log(`Expiry scan ${JSON.stringify(summary)}`);
    }

    return summary;
  }

  private async createReminder(input: {
    organizationId: string;
    organizationName: string;
    branchId: string;
    batchId: string;
    productId: string;
    productName: string;
    unit: string;
    batchNumber: string | null;
    expiryDate: Date;
    quantity: number;
    daysRemaining: number;
    milestone: string;
    action: string;
    severity: 'danger' | 'warning';
    dedupeKey: string;
    timeZone: string;
    actionUrl: string;
  }): Promise<{ notificationId: string } | null> {
    const existing = await this.prisma.notification.findUnique({
      where: {
        organizationId_dedupeKey: {
          organizationId: input.organizationId,
          dedupeKey: input.dedupeKey,
        },
      },
      select: { id: true },
    });
    if (existing) return null;

    const copy = buildExpiryReminderCopy({
      organizationName: input.organizationName,
      productName: input.productName,
      batchNumber: input.batchNumber,
      expiryDate: input.expiryDate,
      daysRemaining: input.daysRemaining,
      quantity: input.quantity,
      unit: input.unit,
      timeZone: input.timeZone,
      action: input.action,
      actionUrl: input.actionUrl,
    });

    try {
      const notification = await this.prisma.notification.create({
        data: {
          organizationId: input.organizationId,
          branchId: input.branchId,
          type: EXPIRY_NOTIFICATION_TYPE,
          title: copy.title,
          body: copy.body,
          severity: input.severity,
          productId: input.productId,
          batchId: input.batchId,
          dedupeKey: input.dedupeKey,
          metadata: {
            batchId: input.batchId,
            batchNumber: input.batchNumber,
            productId: input.productId,
            productName: input.productName,
            expiryDate: input.expiryDate.toISOString().slice(0, 10),
            daysRemaining: input.daysRemaining,
            milestone: input.milestone,
            recommendedAction: input.action,
            actionUrl: input.actionUrl,
            quantity: input.quantity,
            unit: input.unit,
            timeZone: input.timeZone,
          },
        },
        select: { id: true },
      });

      return { notificationId: notification.id };
    } catch (error) {
      // A concurrent scan may have created the same reminder first.
      if (this.isUniqueViolation(error)) return null;
      throw error;
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
  }

  private toQuantity(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
  }
}

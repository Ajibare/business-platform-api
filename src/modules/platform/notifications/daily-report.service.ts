import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { isValidDateKey, localDateKey, zonedDayRangeUtc } from '../../../common/utils/time';
import {
  DailySalesSummary,
  summariseSalesDay,
} from '../../products/pharmacy/sales/daily-summary';
import { NotificationsService } from './notifications.service';
import { EmailService } from './email.service';
import {
  DAILY_REPORT_NOTIFICATION_TYPE,
  buildDailyReportCopy,
  dailyReportDedupeKey,
  isDailyReportDue,
  normaliseDeliveryTime,
} from './daily-report.rules';

export interface DailyReport {
  organizationId: string;
  pharmacyName: string;
  date: string;
  timeZone: string;
  deliveryTime: string;
  currency: string;
  summary: DailySalesSummary;
  recipients: string[];
  /** True when the report for this business date was already created. */
  alreadySent: boolean;
}

export interface DailyReportRunSummary {
  organizationsChecked: number;
  organizationsDue: number;
  reportsCreated: number;
  alreadySent: number;
  emailsQueued: number;
  emailsSent: number;
  emailsFailed: number;
}

export interface DailyReportSendResult {
  report: DailyReport;
  skipped: boolean;
  reason?: string;
  notificationId: string | null;
  emailsQueued: number;
  emailsSent: number;
  emailsFailed: number;
}

/**
 * Builds and delivers the daily sales summary.
 *
 * Figures come from completed sales only, refunds are counted on the day they
 * were given, and the business day is resolved in the reporting timezone. A
 * unique `(organizationId, dedupeKey)` notification prevents duplicate reports
 * for the same date even when several schedulers run at once.
 */
@Injectable()
export class DailyReportService {
  private readonly logger = new Logger(DailyReportService.name);
  private readonly webUrl =
    process.env.WEB_APP_URL ?? process.env.APP_PUBLIC_URL ?? 'http://localhost:3000';

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly auditService: AuditService,
  ) {}

  async buildReport(organizationId: string, requestedDate?: string): Promise<DailyReport> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, timezone: true, currency: true },
    });
    if (!organization) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Workspace not found' });
    }

    const preferences = await this.notifications.getPreferences(organizationId);
    const timeZone = preferences.dailyReportTimezone || organization.timezone || 'Africa/Lagos';
    const date =
      requestedDate && isValidDateKey(requestedDate)
        ? requestedDate
        : localDateKey(new Date(), timeZone);
    const { start, end } = zonedDayRangeUtc(date, timeZone);

    const [sales, returns, existing, recipients] = await Promise.all([
      this.prisma.sale.findMany({
        where: { organizationId, status: 'COMPLETED', occurredAt: { gte: start, lt: end } },
        select: {
          subtotal: true,
          discountTotal: true,
          revenue: true,
          unitCount: true,
          costTotal: true,
        },
      }),
      this.prisma.saleReturn.findMany({
        where: { organizationId, occurredAt: { gte: start, lt: end } },
        select: { amount: true },
      }),
      this.prisma.notification.findUnique({
        where: {
          organizationId_dedupeKey: {
            organizationId,
            dedupeKey: dailyReportDedupeKey(date),
          },
        },
        select: { id: true },
      }),
      this.resolveRecipients(organizationId),
    ]);

    const summary = summariseSalesDay(
      sales.map((sale) => ({
        subtotal: this.toNumber(sale.subtotal),
        discountTotal: this.toNumber(sale.discountTotal),
        revenue: this.toNumber(sale.revenue),
        unitCount: this.toNumber(sale.unitCount),
        costTotal: sale.costTotal === null ? null : this.toNumber(sale.costTotal),
      })),
      returns.map((entry) => ({ amount: this.toNumber(entry.amount) })),
    );

    return {
      organizationId,
      pharmacyName: organization.name,
      date,
      timeZone,
      deliveryTime: normaliseDeliveryTime(preferences.dailyReportTime),
      currency: organization.currency || 'NGN',
      summary,
      recipients,
      alreadySent: Boolean(existing),
    };
  }

  /**
   * Sends the report for a workspace. Scheduled runs only send when the local
   * delivery time has passed and daily reports are enabled; a manual run from
   * the settings screen ignores the clock but still respects deduplication.
   */
  async send(
    organizationId: string,
    actorId: string | null,
    options: { date?: string; mode: 'scheduled' | 'manual' } = { mode: 'scheduled' },
  ): Promise<DailyReportSendResult> {
    const preferences = await this.notifications.getPreferences(organizationId);
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const timeZone =
      preferences.dailyReportTimezone || organization?.timezone || 'Africa/Lagos';

    if (options.mode === 'scheduled') {
      if (!preferences.dailyReportEnabled || !preferences.emailEnabled) {
        return this.skipped(await this.buildReport(organizationId, options.date), 'disabled');
      }
      if (
        !isDailyReportDue({
          now: new Date(),
          deliveryTime: preferences.dailyReportTime,
          timeZone,
        })
      ) {
        return this.skipped(await this.buildReport(organizationId, options.date), 'not-due');
      }
    }

    const report = await this.buildReport(organizationId, options.date);
    if (report.alreadySent) {
      return {
        report,
        skipped: true,
        reason: 'already-sent',
        notificationId: null,
        emailsQueued: 0,
        emailsSent: 0,
        emailsFailed: 0,
      };
    }

    const copy = buildDailyReportCopy({
      organizationName: report.pharmacyName,
      currency: report.currency,
      date: report.date,
      timeZone: report.timeZone,
      summary: report.summary,
      dashboardUrl: `${this.webUrl.replace(/\/+$/, '')}/products/pharmacy/reports`,
    });

    let notificationId: string;
    try {
      const notification = await this.prisma.notification.create({
        data: {
          organizationId,
          type: DAILY_REPORT_NOTIFICATION_TYPE,
          title: copy.title,
          body: copy.body,
          severity: 'info',
          dedupeKey: dailyReportDedupeKey(report.date),
          metadata: {
            date: report.date,
            timeZone: report.timeZone,
            currency: report.currency,
            ...report.summary,
          },
        },
        select: { id: true },
      });
      notificationId = notification.id;
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        return {
          report: { ...report, alreadySent: true },
          skipped: true,
          reason: 'already-sent',
          notificationId: null,
          emailsQueued: 0,
          emailsSent: 0,
          emailsFailed: 0,
        };
      }
      throw error;
    }

    const emailsQueued = await this.email.queueForNotification(
      organizationId,
      notificationId,
      report.recipients,
    );
    const outcome = await this.email.sendPendingForNotification(notificationId);

    if (options.mode === 'manual' && actorId) {
      await this.auditService.record({
        organizationId,
        actorId,
        action: 'DAILY_SALES_REPORT_SENT',
        entityType: 'Notification',
        entityId: notificationId,
        metadata: { date: report.date, recipients: report.recipients.length },
      });
    }

    return {
      report,
      skipped: false,
      notificationId,
      emailsQueued,
      emailsSent: outcome.sent,
      emailsFailed: outcome.failed,
    };
  }

  /**
   * Called by the scheduler. Every workspace with daily reports enabled is
   * checked; reports only leave once the configured local time has passed.
   */
  async runScheduled(): Promise<DailyReportRunSummary> {
    const summary: DailyReportRunSummary = {
      organizationsChecked: 0,
      organizationsDue: 0,
      reportsCreated: 0,
      alreadySent: 0,
      emailsQueued: 0,
      emailsSent: 0,
      emailsFailed: 0,
    };

    const organizations = await this.prisma.organization.findMany({
      where: { notificationPrefs: { dailyReportEnabled: true, emailEnabled: true } },
      select: { id: true, timezone: true },
    });

    for (const organization of organizations) {
      summary.organizationsChecked += 1;
      const preferences = await this.notifications.getPreferences(organization.id);
      const timeZone =
        preferences.dailyReportTimezone || organization.timezone || 'Africa/Lagos';

      if (
        !isDailyReportDue({
          now: new Date(),
          deliveryTime: preferences.dailyReportTime,
          timeZone,
        })
      ) {
        continue;
      }

      summary.organizationsDue += 1;
      const result = await this.send(organization.id, null, { mode: 'scheduled' });
      if (result.reason === 'already-sent') {
        summary.alreadySent += 1;
        continue;
      }
      if (result.skipped) continue;

      summary.reportsCreated += 1;
      summary.emailsQueued += result.emailsQueued;
      summary.emailsSent += result.emailsSent;
      summary.emailsFailed += result.emailsFailed;
    }

    if (summary.reportsCreated > 0 || summary.emailsFailed > 0) {
      this.logger.log(`Daily report run ${JSON.stringify(summary)}`);
    }

    return summary;
  }

  /** Sends a test copy from the settings screen, ignoring the delivery time. */
  async sendNow(organizationId: string, actorId: string, date?: string) {
    if (date && !isValidDateKey(date)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Date must use the YYYY-MM-DD format.',
      });
    }
    return this.send(organizationId, actorId, { date, mode: 'manual' });
  }

  /**
   * Recipients are configured sales recipients plus the active owners and
   * managers of the workspace, because the daily report is an owner level
   * summary. Addresses are de-duplicated case-insensitively.
   */
  private async resolveRecipients(organizationId: string): Promise<string[]> {
    const [configured, staff] = await Promise.all([
      this.notifications.activeRecipients(organizationId, 'sales'),
      this.prisma.membership.findMany({
        where: {
          organizationId,
          active: true,
          role: { in: ['OWNER', 'MANAGER'] },
          user: { status: 'ACTIVE', email: { not: null } },
        },
        select: { user: { select: { email: true } } },
      }),
    ]);

    const emails = new Set<string>();
    for (const recipient of configured) {
      emails.add(recipient.email.trim().toLowerCase());
    }
    for (const membership of staff) {
      const email = membership.user.email?.trim().toLowerCase();
      if (email) emails.add(email);
    }
    return [...emails];
  }

  private skipped(report: DailyReport, reason: string): DailyReportSendResult {
    return {
      report,
      skipped: true,
      reason,
      notificationId: null,
      emailsQueued: 0,
      emailsSent: 0,
      emailsFailed: 0,
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
  }

  private toNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const decimal = value as { toNumber?: () => number };
    return typeof decimal.toNumber === 'function' ? decimal.toNumber() : Number(value);
  }
}
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
  /** Null for the consolidated organisation report. */
  branchId: string | null;
  branchName: string | null;
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

/** One send can produce several reports when the workspace reports per branch. */
export interface DailyReportBatchResult {
  scope: 'consolidated' | 'per-branch';
  reports: DailyReport[];
  results: DailyReportSendResult[];
  totals: {
    reportsCreated: number;
    alreadySent: number;
    emailsQueued: number;
    emailsSent: number;
    emailsFailed: number;
  };
}

/**
 * Builds and delivers the daily sales summary.
 *
 * Figures come from completed sales only, refunds are counted on the day they
 * were given, and the business day is resolved in the reporting timezone. A
 * unique `(organizationId, dedupeKey)` notification prevents duplicate reports
 * for the same date even when several schedulers run at once; when the workspace
 * reports per branch the branch id is part of that key.
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

  async buildReport(
    organizationId: string,
    requestedDate?: string,
    branchId: string | null = null,
  ): Promise<DailyReport> {
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
    const scope = branchId ? { branchId } : {};

    const [branch, sales, returns, existing, recipients] = await Promise.all([
      branchId
        ? this.prisma.branch.findFirst({
            where: { id: branchId, organizationId },
            select: { name: true },
          })
        : Promise.resolve(null),
      this.prisma.sale.findMany({
        where: {
          organizationId,
          ...scope,
          status: 'COMPLETED',
          occurredAt: { gte: start, lt: end },
        },
        select: {
          subtotal: true,
          discountTotal: true,
          revenue: true,
          unitCount: true,
          costTotal: true,
        },
      }),
      this.prisma.saleReturn.findMany({
        where: {
          organizationId,
          occurredAt: { gte: start, lt: end },
          ...(branchId ? { sale: { branchId } } : {}),
        },
        select: { amount: true },
      }),
      this.prisma.notification.findUnique({
        where: {
          organizationId_dedupeKey: {
            organizationId,
            dedupeKey: dailyReportDedupeKey(date, branchId),
          },
        },
        select: { id: true },
      }),
      this.resolveRecipients(organizationId, branchId),
    ]);

    if (branchId && !branch) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Branch not found' });
    }

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
      branchId,
      branchName: branch?.name ?? null,
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
   * Every report this workspace should produce for a date: one consolidated
   * report, or one per active branch when that preference is on.
   */
  async buildReports(organizationId: string, requestedDate?: string): Promise<DailyReport[]> {
    const preferences = await this.notifications.getPreferences(organizationId);
    if (!preferences.dailyReportPerBranch) {
      return [await this.buildReport(organizationId, requestedDate, null)];
    }

    const branches = await this.prisma.branch.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: { id: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    return Promise.all(
      branches.map((branch) => this.buildReport(organizationId, requestedDate, branch.id)),
    );
  }

  /**
   * Sends the report(s) for a workspace. Scheduled runs only send when the local
   * delivery time has passed and daily reports are enabled; a manual run from
   * the settings screen ignores the clock but still respects deduplication.
   */
  async send(
    organizationId: string,
    actorId: string | null,
    options: { date?: string; mode: 'scheduled' | 'manual' } = { mode: 'scheduled' },
  ): Promise<DailyReportBatchResult> {
    const preferences = await this.notifications.getPreferences(organizationId);
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const timeZone =
      preferences.dailyReportTimezone || organization?.timezone || 'Africa/Lagos';
    const scope: DailyReportBatchResult['scope'] = preferences.dailyReportPerBranch
      ? 'per-branch'
      : 'consolidated';

    const skippedBatch = async (reason: string): Promise<DailyReportBatchResult> => {
      const reports = await this.buildReports(organizationId, options.date);
      return {
        scope,
        reports,
        results: reports.map((report) => this.skipped(report, reason)),
        totals: {
          reportsCreated: 0,
          alreadySent: 0,
          emailsQueued: 0,
          emailsSent: 0,
          emailsFailed: 0,
        },
      };
    };

    if (options.mode === 'scheduled') {
      if (!preferences.dailyReportEnabled || !preferences.emailEnabled) {
        return skippedBatch('disabled');
      }
      if (
        !isDailyReportDue({
          now: new Date(),
          deliveryTime: preferences.dailyReportTime,
          timeZone,
        })
      ) {
        return skippedBatch('not-due');
      }
    }

    const reports = await this.buildReports(organizationId, options.date);
    const results: DailyReportSendResult[] = [];
    for (const report of reports) {
      results.push(await this.deliver(organizationId, actorId, options.mode, report));
    }

    const batch: DailyReportBatchResult = {
      scope,
      reports,
      results,
      totals: {
        reportsCreated: results.filter((result) => !result.skipped).length,
        alreadySent: results.filter((result) => result.reason === 'already-sent').length,
        emailsQueued: results.reduce((total, result) => total + result.emailsQueued, 0),
        emailsSent: results.reduce((total, result) => total + result.emailsSent, 0),
        emailsFailed: results.reduce((total, result) => total + result.emailsFailed, 0),
      },
    };

    if (options.mode === 'manual' && actorId && batch.totals.reportsCreated > 0) {
      await this.auditService.record({
        organizationId,
        actorId,
        action: 'DAILY_SALES_REPORT_SENT',
        entityType: 'Notification',
        entityId: batch.reports[0]?.date ?? '',
        metadata: {
          scope: batch.scope,
          date: batch.results[0]?.report.date ?? null,
          reports: batch.totals.reportsCreated,
          recipients: reports.reduce((total, report) => total + report.recipients.length, 0),
        },
      });
    }

    return batch;
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
      summary.reportsCreated += result.totals.reportsCreated;
      summary.alreadySent += result.totals.alreadySent;
      summary.emailsQueued += result.totals.emailsQueued;
      summary.emailsSent += result.totals.emailsSent;
      summary.emailsFailed += result.totals.emailsFailed;
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

  /** Creates the notification for one report and queues its emails. */
  private async deliver(
    organizationId: string,
    actorId: string | null,
    mode: 'scheduled' | 'manual',
    report: DailyReport,
  ): Promise<DailyReportSendResult> {
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
      branchName: report.branchName,
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
          branchId: report.branchId,
          type: DAILY_REPORT_NOTIFICATION_TYPE,
          title: copy.title,
          body: copy.body,
          severity: 'info',
          dedupeKey: dailyReportDedupeKey(report.date, report.branchId),
          metadata: {
            date: report.date,
            timeZone: report.timeZone,
            currency: report.currency,
            branchId: report.branchId,
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
   * Recipients are the configured sales recipients plus the staff who are
   * responsible for the scope: owners and admins for the organisation report,
   * and the branch manager when the report covers one branch. Addresses are
   * de-duplicated case-insensitively so nobody receives the same email twice.
   */
  private async resolveRecipients(
    organizationId: string,
    branchId: string | null,
  ): Promise<string[]> {
    const [configured, staff] = await Promise.all([
      this.notifications.activeRecipients(organizationId, 'sales', branchId),
      this.prisma.membership.findMany({
        where: {
          organizationId,
          active: true,
          role: branchId
            ? { in: ['OWNER', 'ADMIN', 'BRANCH_MANAGER', 'MANAGER'] }
            : { in: ['OWNER', 'ADMIN', 'MANAGER'] },
          user: { status: 'ACTIVE', email: { not: null } },
        },
        select: { role: true, user: { select: { email: true } } },
      }),
    ]);

    // For a branch report only the manager of that branch is added; owners and
    // admins are organisation level and always receive every branch report.
    const managers = branchId
      ? await this.prisma.branch.findMany({
          where: { id: branchId, organizationId, managerUserId: { not: null } },
          select: { manager: { select: { email: true, status: true } } },
        })
      : [];

    const emails = new Set<string>();
    for (const recipient of configured) {
      emails.add(recipient.email.trim().toLowerCase());
    }
    for (const membership of staff) {
      if (!branchId) {
        const email = membership.user.email?.trim().toLowerCase();
        if (email) emails.add(email);
        continue;
      }
      // Organisation owners and admins see every branch; a branch manager only
      // receives the report of a branch they manage.
      if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') continue;
      const email = membership.user.email?.trim().toLowerCase();
      if (email) emails.add(email);
    }
    for (const branch of managers) {
      if (branch.manager?.status !== 'ACTIVE') continue;
      const email = branch.manager.email?.trim().toLowerCase();
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

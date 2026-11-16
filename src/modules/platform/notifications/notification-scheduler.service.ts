import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ExpiryRemindersService } from './expiry-reminders.service';
import { DailyReportService } from './daily-report.service';
import { EmailService } from './email.service';

/**
 * Runs the reminder scan and email retry worker inside the API process.
 *
 * The interval is configuration driven (`NOTIFICATION_SCAN_INTERVAL_MINUTES`),
 * so multiple instances are safe because reminder and delivery records are
 * deduplicated in the database. Setting the interval to `0` disables the
 * scheduler, which is useful when an external runner triggers the scan.
 */
@Injectable()
export class NotificationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly reminders: ExpiryRemindersService,
    private readonly dailyReport: DailyReportService,
    private readonly email: EmailService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;

    const intervalMinutes = Number(process.env.NOTIFICATION_SCAN_INTERVAL_MINUTES ?? '60');
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      this.logger.log('Notification scheduler disabled by configuration.');
      return;
    }

    const initialDelaySeconds = Number(process.env.NOTIFICATION_SCAN_INITIAL_DELAY_SECONDS ?? '20');
    const intervalMs = intervalMinutes * 60 * 1000;
    const initialDelayMs = Math.max(Number.isFinite(initialDelaySeconds) ? initialDelaySeconds : 20, 1) * 1000;

    this.schedule(initialDelayMs, intervalMs);
    this.logger.log(
      `Notification scheduler active: first run in ${Math.round(initialDelayMs / 1000)}s, then every ${intervalMinutes} minute(s).`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number, intervalMs: number): void {
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(intervalMs, intervalMs));
    }, delayMs);
    // Do not hold the process open because of the scheduler.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reminders.runScan({ trigger: 'scheduled' });
      await this.dailyReport.runScheduled();
      await this.email.processDueDeliveries(25);
    } catch (error) {
      this.logger.error(
        'Scheduled notification run failed',
        error instanceof Error ? error.stack : undefined,
      );
    } finally {
      this.running = false;
    }
  }
}

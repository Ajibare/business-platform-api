import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';

const MAX_ATTEMPTS = Number(process.env.EMAIL_MAX_ATTEMPTS ?? 5);
const BACKOFF_BASE_MINUTES = 5;
const BACKOFF_MAX_MINUTES = 60;

interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Delivers notification emails. The transport is configuration driven:
 *
 * - `log` (default): records the attempt and writes the message to the log.
 *   Suitable for local development and for deployments without an email provider.
 * - `http`: posts to `EMAIL_HTTP_URL` with a bearer `EMAIL_HTTP_API_KEY`.
 *   Credentials are read from the environment and never stored in source code.
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private readonly transport = process.env.EMAIL_TRANSPORT === 'http' ? 'http' : 'log';
  private readonly from = process.env.EMAIL_FROM ?? 'notifications@pharmacy.local';

  constructor(private readonly prisma: PrismaService) {}

  /**
   * States which transport is live at boot. Configuration is read once per
   * process, so without this line a `.env` edit that has not been reloaded looks
   * identical to one that was applied.
   */
  onModuleInit(): void {
    if (this.transport === 'log') {
      this.logger.log(`Email transport: log - nothing is delivered. from=${this.from}`);
      return;
    }
    this.logger.log(
      `Email transport: http - delivering via ${process.env.EMAIL_HTTP_URL ?? '(unset)'} from ${this.from}`,
    );
  }

  get activeTransport(): 'log' | 'http' {
    return this.transport;
  }

  /**
   * Sends a one-off message (verification codes, password resets, invitations).
   * Unlike notification delivery there is no durable row: the caller owns the
   * secret and must be able to tell the user when delivery failed.
   */
  async sendTransactional(message: OutboundEmail): Promise<boolean> {
    try {
      await this.send(message);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown email error';
      this.logger.warn(`Transactional email to ${message.to} failed: ${detail}`);
      return false;
    }
  }

  async queueForNotification(
    organizationId: string,
    notificationId: string,
    recipients: string[],
  ): Promise<number> {
    if (recipients.length === 0) return 0;

    const result = await this.prisma.notificationDelivery.createMany({
      data: recipients.map((recipient) => ({
        organizationId,
        notificationId,
        recipient,
        status: 'PENDING',
        nextAttemptAt: new Date(),
      })),
      skipDuplicates: true,
    });

    return result.count;
  }

  /**
   * Sends every pending delivery for a notification. Delivery rows are the
   * durable record, so a crashed send is picked up by the retry worker.
   */
  async sendPendingForNotification(notificationId: string): Promise<{ sent: number; failed: number }> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification) return { sent: 0, failed: 0 };

    const deliveries = await this.prisma.notificationDelivery.findMany({
      where: { notificationId, status: 'PENDING' },
      take: 25,
    });

    let sent = 0;
    let failed = 0;
    for (const delivery of deliveries) {
      const outcome = await this.attempt(delivery.id, {
        to: delivery.recipient,
        subject: notification.title,
        text: notification.body,
      });
      if (outcome) sent += 1;
      else failed += 1;
    }
    return { sent, failed };
  }

  async processDueDeliveries(limit = 20): Promise<{ sent: number; failed: number }> {
    const due = await this.prisma.notificationDelivery.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        attempts: { lt: MAX_ATTEMPTS },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: { notification: true },
    });

    let sent = 0;
    let failed = 0;
    for (const delivery of due) {
      const outcome = await this.attempt(delivery.id, {
        to: delivery.recipient,
        subject: delivery.notification.title,
        text: delivery.notification.body,
      });
      if (outcome) sent += 1;
      else failed += 1;
    }
    return { sent, failed };
  }

  async retryDelivery(organizationId: string, deliveryId: string) {
    const delivery = await this.prisma.notificationDelivery.findFirst({
      where: { id: deliveryId, organizationId },
      include: { notification: true },
    });
    if (!delivery) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery not found' });
    }
    if (delivery.status === 'SENT') {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'This email was already delivered.',
      });
    }

    await this.attempt(delivery.id, {
      to: delivery.recipient,
      subject: delivery.notification.title,
      text: delivery.notification.body,
    });

    return this.findOneDelivery(organizationId, delivery.id);
  }

  async listDeliveries(organizationId: string, status?: string, limit = 50) {
    const deliveries = await this.prisma.notificationDelivery.findMany({
      where: {
        organizationId,
        ...(status ? { status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      include: { notification: { select: { title: true, type: true } } },
    });

    return {
      data: deliveries.map((delivery) => ({
        id: delivery.id,
        notificationId: delivery.notificationId,
        notificationTitle: delivery.notification.title,
        notificationType: delivery.notification.type,
        recipient: delivery.recipient,
        status: delivery.status,
        attempts: delivery.attempts,
        lastError: delivery.lastError,
        lastAttemptAt: delivery.lastAttemptAt,
        nextAttemptAt: delivery.nextAttemptAt,
        sentAt: delivery.sentAt,
        createdAt: delivery.createdAt,
      })),
      meta: { maxAttempts: MAX_ATTEMPTS, transport: this.transport },
    };
  }

  private async findOneDelivery(organizationId: string, id: string) {
    const delivery = await this.prisma.notificationDelivery.findFirst({
      where: { id, organizationId },
      include: { notification: { select: { title: true, type: true } } },
    });
    if (!delivery) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Delivery not found' });
    }
    return {
      data: {
        id: delivery.id,
        notificationId: delivery.notificationId,
        notificationTitle: delivery.notification.title,
        recipient: delivery.recipient,
        status: delivery.status,
        attempts: delivery.attempts,
        lastError: delivery.lastError,
        lastAttemptAt: delivery.lastAttemptAt,
        nextAttemptAt: delivery.nextAttemptAt,
        sentAt: delivery.sentAt,
      },
    };
  }

  private async attempt(deliveryId: string, message: OutboundEmail): Promise<boolean> {
    const attempts = await this.prisma.notificationDelivery
      .findUnique({ where: { id: deliveryId }, select: { attempts: true } })
      .then((row) => (row?.attempts ?? 0) + 1);

    try {
      await this.send(message);
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'SENT',
          attempts,
          sentAt: new Date(),
          lastAttemptAt: new Date(),
          lastError: null,
          nextAttemptAt: null,
        },
      });
      return true;
    } catch (error) {
      const lastError = error instanceof Error ? error.message : 'Unknown email error';
      const exhausted = attempts >= MAX_ATTEMPTS;
      const backoffMinutes = Math.min(
        BACKOFF_BASE_MINUTES * 2 ** Math.max(attempts - 1, 0),
        BACKOFF_MAX_MINUTES,
      );
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'FAILED',
          attempts,
          lastAttemptAt: new Date(),
          lastError: lastError.slice(0, 500),
          nextAttemptAt: exhausted
            ? null
            : new Date(Date.now() + backoffMinutes * 60 * 1000),
        },
      });
      this.logger.warn(`Email delivery ${deliveryId} failed (attempt ${attempts}): ${lastError}`);
      return false;
    }
  }

  private async send(message: OutboundEmail): Promise<void> {
    if (this.transport === 'log') {
      // The body carries the secret (verification code, reset token), so it is
      // only written outside production. Omitting it entirely - as this used to
      // - made a missing email impossible to diagnose: nothing was delivered and
      // nothing recorded what should have been.
      const body =
        process.env.NODE_ENV === 'production'
          ? '(nothing is delivered by this transport; set EMAIL_TRANSPORT=http)'
          : message.text;
      this.logger.log(
        `[email:log] to=${message.to} from=${this.from} subject="${message.subject}"\n${body}`,
      );
      return;
    }

    const url = process.env.EMAIL_HTTP_URL;
    const apiKey = process.env.EMAIL_HTTP_API_KEY;
    if (!url || !apiKey) {
      throw new Error('EMAIL_HTTP_URL and EMAIL_HTTP_API_KEY must be configured for the http transport.');
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Email provider responded ${response.status} ${detail}`.trim());
    }
  }
}

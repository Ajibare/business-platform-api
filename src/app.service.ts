import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './database/prisma.service';

/** How long a readiness probe waits before calling the database unreachable. */
const READINESS_TIMEOUT_MS = 3000;

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up and routing. It never touches the database. */
  getHealth() {
    return { status: 'ok' };
  }

  /**
   * Readiness: can this instance actually serve requests?
   *
   * The registration failure that produced an opaque 500 was a database
   * authentication error, so there has to be an endpoint that says so directly
   * instead of waiting for a user to hit a query. Answers 503 with the reason
   * (never the connection string) when the database is unreachable.
   */
  async getReadiness() {
    const startedAt = Date.now();
    try {
      await this.withTimeout(this.prisma.$queryRaw`SELECT 1`);
      return {
        status: 'ok',
        database: { status: 'up', latencyMs: Date.now() - startedAt },
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Unknown database error';
      this.logger.error(
        `Readiness probe failed after ${Date.now() - startedAt}ms: ${detail}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new ServiceUnavailableException({
        code: 'DATABASE_UNAVAILABLE',
        message: 'The API cannot reach its database.',
        details: { database: 'down' },
      });
    }
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Database did not answer within ${READINESS_TIMEOUT_MS}ms.`)),
            READINESS_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

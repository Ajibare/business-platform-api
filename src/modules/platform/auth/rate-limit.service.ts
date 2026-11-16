import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

interface WindowBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiting for the credential endpoints.
 *
 * Counters live in process memory, which is the right trade-off for a single
 * API instance: it keeps the login path free of database round trips before
 * authentication succeeds. When the API is scaled horizontally this must move
 * to a shared store (Redis) so the limit is global; `AUTH_RATE_LIMIT_DRIVER`
 * documents the intent and the service is the only place that changes.
 */
@Injectable()
export class RateLimitService {
  private readonly buckets = new Map<string, WindowBucket>();

  consume(key: string, limit: number, windowMs: number): RateLimitResult {
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.sweep(now);
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: Math.max(limit - 1, 0), retryAfterSeconds: 0 };
    }

    if (bucket.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: Math.max(limit - bucket.count, 0),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  /** Throws a 429 with a retry hint when the caller is over its budget. */
  assertAllowed(key: string, limit: number, windowMs: number, message: string): RateLimitResult {
    const result = this.consume(key, limit, windowMs);
    if (!result.allowed) {
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message,
          retryAfterSeconds: result.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return result;
  }

  /** Used after a successful credential change so the user is not punished for earlier attempts. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Test hook: drops every counter. */
  clear(): void {
    this.buckets.clear();
  }

  private sweep(now: number): void {
    if (this.buckets.size < 500) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

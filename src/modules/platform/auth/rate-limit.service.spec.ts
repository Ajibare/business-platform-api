import { HttpException, HttpStatus } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';

describe('RateLimitService', () => {
  let service: RateLimitService;

  beforeEach(() => {
    service = new RateLimitService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows requests up to the limit and then blocks with a retry hint', () => {
    const windowMs = 60_000;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = service.consume('signin:1.2.3.4', 3, windowMs);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(3 - attempt);
    }

    const blocked = service.consume('signin:1.2.3.4', 3, windowMs);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('tracks each key independently', () => {
    service.consume('register:1.1.1.1', 1, 60_000);
    expect(service.consume('register:1.1.1.1', 1, 60_000).allowed).toBe(false);
    expect(service.consume('register:2.2.2.2', 1, 60_000).allowed).toBe(true);
  });

  it('opens a fresh window once the old one expires', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    service.consume('reset:1.1.1.1', 1, 1_000);
    expect(service.consume('reset:1.1.1.1', 1, 1_000).allowed).toBe(false);

    jest.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    expect(service.consume('reset:1.1.1.1', 1, 1_000).allowed).toBe(true);
  });

  it('resets a key after a successful credential change', () => {
    service.consume('signin:key', 1, 60_000);
    service.reset('signin:key');
    expect(service.consume('signin:key', 1, 60_000).allowed).toBe(true);
  });

  it('throws a 429 envelope with the rate limit code', () => {
    service.assertAllowed('verify:key', 1, 60_000, 'Slow down');

    let thrown: unknown;
    try {
      service.assertAllowed('verify:key', 1, 60_000, 'Slow down');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    const exception = thrown as HttpException;
    expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(exception.getResponse()).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Slow down',
    });
  });
});

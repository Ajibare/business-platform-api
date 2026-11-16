import { ForbiddenException } from '@nestjs/common';
import { REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH } from './auth.constants';
import { SessionMeta } from './session.service';

/**
 * Minimal shape of the Express request fields the auth layer reads. Keeping it
 * structural avoids importing Express types into the domain services.
 */
export interface AuthRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string | null };
}

function headerValue(request: AuthRequestLike, name: string): string | undefined {
  const raw = request.headers?.[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function describeRequest(request: AuthRequestLike): SessionMeta {
  const forwarded = headerValue(request, 'x-forwarded-for');
  const ipAddress = (forwarded?.split(',')[0] ?? request.ip ?? request.socket?.remoteAddress ?? '')
    .trim()
    .slice(0, 64);
  const userAgent = headerValue(request, 'user-agent')?.slice(0, 255);
  return {
    ipAddress: ipAddress || null,
    userAgent: userAgent || null,
  };
}

export function clientKey(request: AuthRequestLike): string {
  return describeRequest(request).ipAddress ?? 'unknown';
}

export function readRefreshCookie(request: AuthRequestLike): string | null {
  const cookieHeader = headerValue(request, 'cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE_NAME) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

export function allowedOrigins(): string[] {
  return (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Cookie-authenticated endpoints are protected against cross-site request
 * forgery by comparing the browser Origin with the configured web app origins.
 * `SameSite=Lax` already blocks the cookie on cross-site POSTs; this is the
 * second, explicit layer and the reason no CSRF token round trip is needed.
 */
export function assertTrustedOrigin(request: AuthRequestLike): void {
  const origin = headerValue(request, 'origin');
  if (!origin) return; // Non-browser clients (CLI, tests) do not send Origin.
  if (allowedOrigins().includes(origin)) return;
  throw new ForbiddenException({
    code: 'UNTRUSTED_ORIGIN',
    message: 'This request did not come from a trusted application origin.',
  });
}

export function refreshCookieOptions(expiresAt?: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: REFRESH_COOKIE_PATH,
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

/**
 * Structural view of the Express response. Declared locally so the auth layer
 * does not need `@types/express`; Nest hands us the real Express response.
 */
export interface CookieResponse {
  cookie(name: string, value: string, options?: Record<string, unknown>): void;
  clearCookie(name: string, options?: Record<string, unknown>): void;
}

export function attachRefreshCookie(
  res: CookieResponse,
  refreshToken: string,
  expiresAt: Date,
): void {
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions(expiresAt));
}

export function clearRefreshCookie(res: CookieResponse): void {
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
}

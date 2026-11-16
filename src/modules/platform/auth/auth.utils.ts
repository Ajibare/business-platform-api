import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { PASSWORD_MIN_LENGTH } from './auth.constants';

/**
 * `0803...`, `803...`, `+234803...` and `234803...` are the shapes staff type.
 * The two alternatives keep the national significant part identical, so a
 * nine-digit body can never be accepted with a doubled prefix.
 */
const NIGERIAN_MOBILE_PATTERN = /^(?:(?:\+?234|0)([789][01]\d{8})|([789][01]\d{8}))$/;
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'qwerty123',
  'letmein123',
  'iloveyou1',
  'admin12345',
  'pharmacy123',
  'pharmacy2024',
  'welcome123',
]);

export interface NormalisedIdentifier {
  channel: 'email' | 'phone';
  value: string;
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Accepts the Nigerian formats staff actually type: `0803...`, `803...`,
 * `+234803...` and `234803...`, with optional spaces, dashes or brackets.
 * Returns the canonical `+234` form, or null when the number is not a valid
 * Nigerian mobile number.
 */
export function normalizePhone(input: string): string | null {
  const cleaned = input.replace(/[\s()-]/g, '');
  if (!cleaned) return null;
  const match = cleaned.match(NIGERIAN_MOBILE_PATTERN);
  if (!match) return null;
  const nationalNumber = match[1] ?? match[2];
  if (!nationalNumber) return null;
  return `+234${nationalNumber}`;
}

export function isValidNigerianPhone(input: string): boolean {
  return normalizePhone(input) !== null;
}

export function normalizeIdentifier(raw: string): NormalisedIdentifier | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes('@')) {
    return { channel: 'email', value: normalizeEmail(trimmed) };
  }
  const phone = normalizePhone(trimmed);
  return phone ? { channel: 'phone', value: phone } : null;
}

export interface PasswordAssessment {
  valid: boolean;
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  issues: string[];
  suggestions: string[];
}

/**
 * Shared by the API (authoritative) and mirrored by the UI so a form that shows
 * "strong" cannot be rejected by the server.
 */
export function assessPassword(
  password: string,
  context: { email?: string | null; name?: string | null } = {},
): PasswordAssessment {
  const issues: string[] = [];
  const suggestions: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    issues.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (!/[a-z]/.test(password)) issues.push('Include a lowercase letter.');
  if (!/[A-Z]/.test(password)) issues.push('Include an uppercase letter.');
  if (!/\d/.test(password)) issues.push('Include a number.');

  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) {
    issues.push('This password is too common. Choose something unique.');
  }

  const emailLocalPart = context.email?.split('@')[0] ?? '';
  const personalTokens = [emailLocalPart, ...(context.name ?? '').split(/\s+/)]
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 3);
  if (personalTokens.some((token) => lowered.includes(token))) {
    issues.push('Do not use your name or email address in the password.');
  }

  // Only suggest something that is actually missing: asking someone who used a
  // symbol to "add a symbol" reads like a bug.
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  if (!hasSymbol) suggestions.push('Add a symbol for extra strength.');
  else if (password.length < 14) suggestions.push('A longer password is even harder to guess.');

  const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;
  let points = 0;
  if (password.length >= PASSWORD_MIN_LENGTH) points += 1;
  if (variety >= 3) points += 1;
  if (password.length >= 14) points += 1;
  if (variety === 4 && password.length >= 12) points += 1;
  if (issues.length > 0) points = Math.min(points, 1);

  const score = Math.max(0, Math.min(points, 4)) as PasswordAssessment['score'];
  const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
  return {
    valid: issues.length === 0,
    score,
    label: labels[score],
    issues,
    suggestions,
  };
}

export function passwordIssues(
  password: string,
  context: { email?: string | null; name?: string | null } = {},
): string[] {
  return assessPassword(password, context).issues;
}

export function generateVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Verification codes and opaque tokens are stored as keyed hashes. The pepper
 * lives in the environment, so a leaked database dump cannot be brute-forced
 * offline into valid codes.
 */
export function hashSecret(secret: string): string {
  const pepper = process.env.AUTH_SECRET_PEPPER ?? process.env.JWT_SECRET ?? 'development-pepper';
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function isEmailIdentifier(raw: string): boolean {
  return raw.includes('@');
}

export function minutesUntil(date: Date, now = new Date()): number {
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 60_000));
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(local.length - 2, 2))}@${domain}`;
}

/** Keeps the country code and the last three digits of a normalised number. */
export function maskPhone(phone: string): string {
  if (phone.length <= 7) return phone;
  return `${phone.slice(0, 4)}${'*'.repeat(phone.length - 7)}${phone.slice(-3)}`;
}

/** Short collision-resistant suffix for generated workspace slugs. */
export function randomSuffix(length = 6): string {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .slice(0, length);
}

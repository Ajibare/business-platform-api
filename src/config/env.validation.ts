import { Logger } from '@nestjs/common';

/**
 * Startup validation for the database connection strings.
 *
 * A wrong database URL otherwise surfaces as an opaque 500 on the first request
 * that touches the database. Failing at boot — with a message that names the
 * variable and what is wrong with it — turns that into a one-line fix.
 *
 * Messages never echo the value: a connection string carries the password.
 */

export type DatabaseVariable = 'DATABASE_URL' | 'DIRECT_URL';

export interface DatabaseTarget {
  hostname: string;
  port: string;
  database: string;
  /** PgBouncer/Supavisor transaction pooler, which cannot run migrations. */
  transactionPooler: boolean;
  sslMode: string | null;
  pgbouncer: string | null;
  connectionLimit: string | null;
}

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
  }
}

const UNEDITED_PLACEHOLDER = /YOUR_|USER:PASSWORD|change-me/i;
const ENCRYPTED_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Parses one connection string. Throws `DatabaseConfigError` with an actionable
 * message; never returns a partially valid target.
 */
export function parseDatabaseUrl(
  raw: unknown,
  variable: DatabaseVariable,
): DatabaseTarget {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new DatabaseConfigError(
      `${variable} is not set. Copy the connection string from the Supabase dashboard (Project Settings -> Database) into .env, or use ${variable}="postgresql://user:password@localhost:5432/database" locally.`,
    );
  }

  const value = raw.trim();
  if (UNEDITED_PLACEHOLDER.test(value)) {
    throw new DatabaseConfigError(
      `${variable} still contains the .env.example placeholder. Replace it with the real connection string from the Supabase dashboard.`,
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DatabaseConfigError(
      `${variable} is not a valid URL. Expected postgresql://user:password@host:port/database?sslmode=require.`,
    );
  }

  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new DatabaseConfigError(
      `${variable} must start with postgresql:// (found ${url.protocol}://). Prisma talks to PostgreSQL over the wire protocol, not over Supabase's HTTP API.`,
    );
  }
  if (!url.hostname) {
    throw new DatabaseConfigError(
      `${variable} is missing a host. Expected postgresql://user:password@host:port/database.`,
    );
  }
  if (!url.username) {
    throw new DatabaseConfigError(`${variable} is missing a user name.`);
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) {
    throw new DatabaseConfigError(
      `${variable} is missing a database name. Supabase names it "postgres" by default.`,
    );
  }

  const port = url.port || '5432';
  return {
    hostname: url.hostname,
    port,
    database,
    transactionPooler: port === '6543',
    sslMode: url.searchParams.get('sslmode'),
    pgbouncer: url.searchParams.get('pgbouncer'),
    connectionLimit: url.searchParams.get('connection_limit'),
  };
}

/** Production connections leave the host network, so the transport must be encrypted. */
export function assertEncryptedTransport(target: DatabaseTarget, variable: DatabaseVariable): void {
  if (ENCRYPTED_SSL_MODES.has((target.sslMode ?? '').toLowerCase())) return;
  if (LOOPBACK_HOSTS.has(target.hostname)) return;
  throw new DatabaseConfigError(
    `${variable} must use an encrypted connection when NODE_ENV=production: add ?sslmode=require (Supabase requires TLS on every connection).`,
  );
}

/** `prisma migrate` needs a session, which the transaction pooler cannot provide. */
export function assertMigratableTarget(target: DatabaseTarget, variable: DatabaseVariable): void {
  if (!target.transactionPooler) return;
  throw new DatabaseConfigError(
    `${variable} points at the transaction pooler (port 6543), which cannot run migrations. Use the direct connection on port 5432, or the session pooler if your network has no IPv6 route.`,
  );
}

/**
 * Non-fatal advice for a pooled connection. Prisma keeps prepared statements on
 * by default; PgBouncer/Supavisor in transaction mode does not support them, so
 * `pgbouncer=true` is required and a small `connection_limit` protects the pool.
 */
export function collectDatabaseWarnings(
  target: DatabaseTarget,
  variable: DatabaseVariable,
): string[] {
  if (!target.transactionPooler) return [];

  const warnings: string[] = [];
  if (!target.pgbouncer) {
    warnings.push(
      `${variable} uses the transaction pooler without ?pgbouncer=true. Prisma will keep using prepared statements, which the pooler does not support; add ?pgbouncer=true&connection_limit=1 to the URL.`,
    );
  }
  if (!target.connectionLimit) {
    warnings.push(
      `${variable} uses the transaction pooler without ?connection_limit. Each API instance opens its own pool, so set connection_limit=1 and let Supabase multiplex the connections.`,
    );
  }
  return warnings;
}

/**
 * `ConfigModule.forRoot({ validate })` entry point. Returns the configuration
 * unchanged so every other key keeps working as it did.
 *
 * Jest (NODE_ENV=test) builds `AppModule` without a database or a `.env`, so the
 * database requirements are skipped there. Every real boot is validated.
 */
export function validateEnvironment(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (config.NODE_ENV === 'test') return config;

  const isProduction = config.NODE_ENV === 'production';
  const database = parseDatabaseUrl(config.DATABASE_URL, 'DATABASE_URL');
  const direct = parseDatabaseUrl(config.DIRECT_URL, 'DIRECT_URL');

  assertMigratableTarget(direct, 'DIRECT_URL');
  if (isProduction) {
    assertEncryptedTransport(database, 'DATABASE_URL');
    assertEncryptedTransport(direct, 'DIRECT_URL');
  }

  const logger = new Logger('DatabaseConfig');
  for (const warning of collectDatabaseWarnings(database, 'DATABASE_URL')) {
    logger.warn(warning);
  }
  return config;
}

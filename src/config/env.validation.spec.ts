import {
  DatabaseConfigError,
  assertEncryptedTransport,
  assertMigratableTarget,
  collectDatabaseWarnings,
  parseDatabaseUrl,
  validateEnvironment,
} from './env.validation';

const LOCAL_DATABASE = 'postgresql://postgres:postgres@localhost:5432/business_platform?schema=public';
const POOLER =
  'postgresql://postgres.org:secret@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1';
const DIRECT =
  'postgresql://postgres.org:secret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';

const expectRejection = (run: () => unknown): DatabaseConfigError => {
  let caught: unknown = null;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DatabaseConfigError);
  return caught as DatabaseConfigError;
};

describe('parseDatabaseUrl', () => {
  it('reads host, port and database from a Supabase pooler string', () => {
    expect(parseDatabaseUrl(POOLER, 'DATABASE_URL')).toMatchObject({
      hostname: 'aws-0-eu-west-1.pooler.supabase.com',
      port: '6543',
      database: 'postgres',
      transactionPooler: true,
      pgbouncer: 'true',
      connectionLimit: '1',
    });
  });

  it('defaults the port to 5432 when the URL omits it', () => {
    expect(parseDatabaseUrl('postgresql://app:secret@db.example.com/postgres', 'DIRECT_URL').port).toBe(
      '5432',
    );
  });

  it('rejects an unset variable with guidance that names it', () => {
    const error = expectRejection(() => parseDatabaseUrl(undefined, 'DATABASE_URL'));
    expect(error.message).toContain('DATABASE_URL is not set');
  });

  it('rejects an empty string', () => {
    expectRejection(() => parseDatabaseUrl('   ', 'DIRECT_URL'));
  });

  it('rejects a value that is still the .env.example placeholder', () => {
    const error = expectRejection(() =>
      parseDatabaseUrl('postgresql://postgres:YOUR_PASSWORD@host:5432/postgres', 'DATABASE_URL'),
    );
    expect(error.message).toContain('placeholder');
  });

  it('rejects a non-PostgreSQL URL such as Supabase’s HTTPS API endpoint', () => {
    const error = expectRejection(() =>
      parseDatabaseUrl('https://project.supabase.co', 'DATABASE_URL'),
    );
    expect(error.message).toContain('postgresql://');
  });

  it('rejects a malformed connection string', () => {
    expectRejection(() => parseDatabaseUrl('postgresql://', 'DATABASE_URL'));
  });

  it('rejects a URL without a database name', () => {
    const error = expectRejection(() =>
      parseDatabaseUrl('postgresql://postgres:secret@localhost:5432/', 'DIRECT_URL'),
    );
    expect(error.message).toContain('database name');
  });

  it('never echoes the password in the error message', () => {
    const error = expectRejection(() =>
      parseDatabaseUrl('postgresql://postgres:hunter2@localhost:5432/', 'DATABASE_URL'),
    );
    expect(error.message).not.toContain('hunter2');
  });
});

describe('assertMigratableTarget', () => {
  it('refuses the transaction pooler for DIRECT_URL', () => {
    const error = expectRejection(() =>
      assertMigratableTarget(parseDatabaseUrl(POOLER, 'DIRECT_URL'), 'DIRECT_URL'),
    );
    expect(error.message).toContain('port 6543');
  });

  it('accepts the session pooler and the direct connection on 5432', () => {
    expect(() =>
      assertMigratableTarget(parseDatabaseUrl(DIRECT, 'DIRECT_URL'), 'DIRECT_URL'),
    ).not.toThrow();
  });
});

describe('assertEncryptedTransport', () => {
  it('requires sslmode for a remote host in production', () => {
    const error = expectRejection(() =>
      assertEncryptedTransport(parseDatabaseUrl(DIRECT, 'DIRECT_URL'), 'DIRECT_URL'),
    );
    expect(error.message).toContain('sslmode=require');
  });

  it('accepts sslmode=require', () => {
    expect(() =>
      assertEncryptedTransport(
        parseDatabaseUrl(`${DIRECT}?sslmode=require`, 'DIRECT_URL'),
        'DIRECT_URL',
      ),
    ).not.toThrow();
  });

  it('allows a loopback host without TLS', () => {
    expect(() =>
      assertEncryptedTransport(
        parseDatabaseUrl(LOCAL_DATABASE, 'DATABASE_URL'),
        'DATABASE_URL',
      ),
    ).not.toThrow();
  });
});

describe('collectDatabaseWarnings', () => {
  it('warns when the transaction pooler lacks the Prisma parameters', () => {
    const warnings = collectDatabaseWarnings(
      parseDatabaseUrl(
        'postgresql://postgres.org:secret@aws-0-eu-west-1.pooler.supabase.com:6543/postgres',
        'DATABASE_URL',
      ),
      'DATABASE_URL',
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('pgbouncer=true');
    expect(warnings[1]).toContain('connection_limit');
  });

  it('is silent for a pooled URL that carries both parameters', () => {
    expect(collectDatabaseWarnings(parseDatabaseUrl(POOLER, 'DATABASE_URL'), 'DATABASE_URL')).toEqual(
      [],
    );
  });

  it('is silent for a direct connection', () => {
    expect(collectDatabaseWarnings(parseDatabaseUrl(DIRECT, 'DIRECT_URL'), 'DIRECT_URL')).toEqual([]);
  });
});

describe('validateEnvironment', () => {
  it('returns the configuration untouched when both URLs are usable', () => {
    const config = { NODE_ENV: 'development', DATABASE_URL: LOCAL_DATABASE, DIRECT_URL: LOCAL_DATABASE };
    expect(validateEnvironment(config)).toBe(config);
  });

  it('fails when DIRECT_URL is missing', () => {
    const error = expectRejection(() =>
      validateEnvironment({ NODE_ENV: 'development', DATABASE_URL: LOCAL_DATABASE }),
    );
    expect(error.message).toContain('DIRECT_URL is not set');
  });

  it('skips the database requirements under NODE_ENV=test', () => {
    // Jest builds AppModule without a .env; that path must not require a database.
    const config = { NODE_ENV: 'test' };
    expect(validateEnvironment(config)).toBe(config);
  });

  it('fails in production when a remote connection is unencrypted', () => {
    expectRejection(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        DATABASE_URL: `${POOLER}&sslmode=disable`,
        DIRECT_URL: DIRECT,
      }),
    );
  });

  it('accepts a production pair with TLS and a direct migration target', () => {
    const config = {
      NODE_ENV: 'production',
      DATABASE_URL: `${POOLER}&sslmode=require`,
      DIRECT_URL: `${DIRECT}?sslmode=require`,
    };
    expect(() => validateEnvironment(config)).not.toThrow();
  });
});

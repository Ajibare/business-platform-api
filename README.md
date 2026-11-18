# business-platform-api

REST API for the multi-product SaaS platform. Pharmacy Stock Intelligence is the first product module.

## Stack

- Node.js
- TypeScript
- NestJS
- PostgreSQL (Supabase in hosted environments, local PostgreSQL for development)
- Prisma ORM
- Redis where genuinely required
- REST API

## Getting started

- Copy `.env.example` to `.env` and fill values.
- Set `DATABASE_URL` and `DIRECT_URL` (see below).
- Run `npx prisma migrate deploy`.
- Run `npm run start:dev`.

The web app in `business-platform-web` talks to this API only. It never holds a database
connection, a Supabase key or a JWT secret.

## Database: Supabase PostgreSQL

### 1. Create the project

1. Sign in at <https://supabase.com/dashboard> and create a project.
2. Choose a strong database password and store it in your password manager. Supabase
   shows it once; it can be reset from Project Settings -> Database.
3. Pick the region closest to the API host. Latency between the API and the database
   dominates every request.

### 2. Copy both connection strings

Open **Project Settings -> Database -> Connection string**. Supabase exposes three
strings, and this project needs two of them:

| Variable       | Supabase string                                 | Port | Used by                                    |
| -------------- | ----------------------------------------------- | ---- | ------------------------------------------ |
| `DATABASE_URL` | **Transaction pooler** (+ Prisma parameters)     | 6543 | The running API, one short-lived session per query |
| `DIRECT_URL`   | **Direct connection**, or **Session pooler**     | 5432 | `prisma migrate`, `prisma db`, studio      |

Append the Prisma parameters to the pooler string:

```env
DATABASE_URL="postgresql://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require"
DIRECT_URL="postgresql://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:5432/postgres?sslmode=require"
```

Why each parameter exists:

- `pgbouncer=true` stops Prisma from using prepared statements, which the transaction
  pooler cannot keep between queries. Without it the API fails with
  `prepared statement "s1" already exists`.
- `connection_limit=1` keeps each API replica to a single pooled connection and lets
  Supavisor do the multiplexing. Raise it only if you measure pool starvation.
- `sslmode=require` is mandatory: Supabase rejects unencrypted connections.

Use the **Session pooler** string for `DIRECT_URL` when the direct host is unreachable.
Supabase's direct hostname is IPv6-only on many projects, so networks without an IPv6
route get `ECONNREFUSED` on port 5432. The session pooler serves the same port over
IPv4 and supports the DDL and advisory locks that migrations need.

The API validates both variables at boot (`src/config/env.validation.ts`): a missing
value, a non-PostgreSQL URL, a leftover placeholder, an unencrypted production
connection or a transaction pooler in `DIRECT_URL` stops the process with a message
that names the variable and the fix. The password is never printed.

### 3. Apply migrations

```bash
npx prisma migrate deploy
```

`migrate deploy` applies the SQL in `prisma/migrations` through `DIRECT_URL` and
records each file in `_prisma_migrations`. It never resets or drops data. Use it for
every environment, including your machine.

`npx prisma migrate dev` additionally creates a shadow database and is meant for
authoring a new migration locally, not for a shared Supabase project.

### 4. Generate the Prisma Client

```bash
npx prisma generate
```

Run this after any `schema.prisma` change, and after `npm install` on a fresh clone.

### 5. Start the API

```bash
npm run start:dev
```

Then confirm the database is reachable:

```bash
curl http://localhost:3001/api/v1/health/ready
# {"status":"ok","database":{"status":"up","latencyMs":6}}
```

### Moving local data to Supabase

1. Back up the local database first:
   `powershell -File scripts/backup-db.ps1` writes a compressed dump to `backups/`
   (git-ignored).
2. Apply the schema to Supabase: `npx prisma migrate deploy` with Supabase values in
   `.env`.
3. Copy the data across with `pg_dump`/`pg_restore` against `DIRECT_URL`, or start with
   an empty database and register the first organisation through the web app.
4. Compare row counts per table before pointing production traffic at Supabase.

`prisma db push --force-reset`, `prisma migrate reset` and dropping tables are never
part of this workflow.

## Local PostgreSQL alternative

Both variables may point at the same local server. The defaults in `.env.example`
do exactly that. Local PostgreSQL does not need TLS.

## Migrations

- Files live in `prisma/migrations` and are append-only once applied.
- Check what is pending with `npx prisma migrate status`.
- Diff the database against `schema.prisma` with
  `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code`;
  it prints `No difference detected.` when they agree.

Indexes are added only where a query shape needs them, with the reason recorded in the
migration SQL.

## Troubleshooting database connection errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| `P1001: Can't reach database server` | Wrong host/port, or the Supabase project is paused | Check the connection string; restore a paused project in the dashboard |
| `P1013: The provided database string is invalid` | Password with unencoded characters (`@`, `#`, `:`), or a non-PostgreSQL URL | Percent-encode the password; keep the `postgresql://` scheme |
| `prepared statement "s1" already exists` | Prisma talking to the transaction pooler without `pgbouncer=true` | Add `?pgbouncer=true&connection_limit=1` |
| `Timed out fetching a new connection from the connection pool` (`P2024`) | Pool exhausted | Lower `connection_limit`, recycle idle sessions, or add a Supabase compute tier |
| `Environment variable not found: DIRECT_URL` | Prisma CLI reads `.env` and the key is absent | Add `DIRECT_URL`; both variables are required |
| `The database schema is behind the application schema` | Pending migration | `npx prisma migrate deploy` |
| Migrations hang on port 6543 | Pointed `DIRECT_URL` at the transaction pooler | Use the direct connection or session pooler on 5432 |
| `ECONNREFUSED` on port 5432 | No IPv6 route to the direct host | Use the session pooler string |
| `Self-signed certificate` / TLS errors | `sslmode` missing or wrong | Add `sslmode=require` |

## Security model

- Connection strings and secrets live in `.env` only. `.env*` is git-ignored; only
  `.env.example` is committed, with placeholders.
- The web app never receives database credentials. It calls this API.
- Supabase Row Level Security is not used today: the API is the only database client and
  connects with a privileged role, so RLS would not constrain it. Tenant isolation is
  enforced in NestJS — every query is scoped by `organizationId`, and branch access is
  resolved and checked server-side (`src/modules/platform/branches/branch-access.service.ts`).
  If a browser-side Supabase client is ever introduced, enable RLS with explicit
  policies first; do not rely on the API's connection string for that.
- Never put the Supabase `service_role` key in the web app or in any `NEXT_PUBLIC_*`
  variable.

## Module structure

- `src/modules/platform` - auth, users, organisations, memberships, permissions, staff, branches, subscriptions, billing, notifications, audit, files.
- `src/modules/products/pharmacy` - inventory, medicines, batches, suppliers, expiry, transfers, reports.
- `src/config` - startup validation of environment configuration.

## API versioning

All endpoints are versioned under `/api/v1`.

## Testing

- Unit: `npm test`
- E2E: `npm run test:e2e`

## Deployment

Docker and docker-compose are provided. See `docs/BACKEND_SETUP.md`.

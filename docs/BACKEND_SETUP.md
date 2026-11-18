# Backend Setup

## Prerequisites

Node.js 22, npm, PostgreSQL, Prisma CLI.

## Steps

1. Copy `.env.example` to `.env`.
2. Configure `DATABASE_URL` (pooled connection) and `DIRECT_URL` (unpooled, used by
   migrations). Supabase values and the required pooler parameters are documented in
   the root README, "Database: Supabase PostgreSQL". Locally both may point at the same
   PostgreSQL instance.
3. Run `npx prisma generate`.
4. Run `npx prisma migrate deploy` (applies the committed migrations without resetting
   the database; `migrate dev` is only for authoring a new migration).
5. Run `npm run start:dev`.

## Commands

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run test:e2e`
- `npm run prisma:generate`
- `npm run prisma:migrate`

## Local infrastructure

`docker-compose.yml` provides PostgreSQL and Redis.

## Running

- Development: `npm run start:dev`
- Production: `npm run start:prod` (API served under `/api/v1`)

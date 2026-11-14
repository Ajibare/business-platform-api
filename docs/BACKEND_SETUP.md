# Backend Setup

## Prerequisites

Node.js 22, npm, PostgreSQL, Prisma CLI.

## Steps

1. Copy `.env.example` to `.env`.
2. Configure `DATABASE_URL`.
3. Run `npx prisma generate`.
4. Run `npx prisma migrate dev`.
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

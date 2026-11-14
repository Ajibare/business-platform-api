# business-platform-api

REST API for the multi-product SaaS platform. Pharmacy Stock Intelligence is the first product module.

## Stack

- Node.js
- TypeScript
- NestJS
- PostgreSQL
- Prisma ORM
- Redis where genuinely required
- REST API

## Getting started

- Copy `.env.example` to `.env` and fill values.
- Run `npx prisma migrate dev`.
- Run `npm run start:dev`.

## Module structure

- `src/modules/platform` - auth, users, organisations, memberships, permissions, subscriptions, billing, notifications, audit, files.
- `src/modules/products/pharmacy` - inventory, medicines, batches, suppliers, expiry, reports.

## API versioning

All endpoints are versioned under `/api/v1`.

## Testing

- Unit: `npm test`
- E2E: `npm run test:e2e`

## Deployment

Docker and docker-compose are provided. See `docs/BACKEND_SETUP.md`.

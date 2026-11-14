# Backend Architecture

## Status

Modular monolith for the backend of the multi-product SaaS platform.

## Stack

Node.js, TypeScript, NestJS, PostgreSQL, Prisma ORM, Redis where genuinely required, REST API.

## Layers

Controllers handle HTTP concerns and delegate to services. Services hold business logic and use Prisma through the shared `PrismaService`. Guards, pipes and filters enforce cross-cutting concerns.

## Module map

- `src/modules/platform` - reusable platform capabilities: auth, users, organisations, memberships, permissions, subscriptions, billing, notifications, audit, files.
- `src/modules/products/pharmacy` - first product module: inventory, medicines, batches, suppliers, expiry, reports.

## Module boundaries

Product modules do not depend on other product modules. Cross-module communication uses application-level interfaces and contracts, not direct internal service access.

## API versioning

Base path is `/api/v1`. Global prefix `api` with URI versioning enabled.

## Extensibility

Future products are added as new modules under `src/modules/products/<product>` following the same pattern described in `docs/PRODUCT_MODULE_GUIDE.md`.

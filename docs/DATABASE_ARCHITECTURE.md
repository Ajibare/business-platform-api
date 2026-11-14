# Database Architecture

## Stack

PostgreSQL with Prisma ORM.

## Principles

- Multi-tenant design keyed by organization.
- Quantities use fixed-precision decimals.
- Stock movement ledger is authoritative; balances are transactional projections.
- No patient health data in the MVP.

## Core models

- Organization, User, Membership.
- Product, Batch, StockMovement, BatchBalance.
- Supplier, StockReceipt, StockCount and related operational models as the module set grows.

## Tenant isolation

Every query is scoped by the organization resolved from the authenticated membership.

## Ledger and balance

Every mutation writes a movement and updates the balance in one transaction. Balances are never edited through generic CRUD.

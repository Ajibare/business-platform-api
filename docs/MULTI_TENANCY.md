# Multi-Tenancy

## Tenant resolution

The tenant context is resolved from the authenticated membership, not from client-supplied tenant identifiers.

## Isolation

All services and queries include tenant scope. Foreign keys prevent cross-tenant associations.

## Tests

Authentication, permissions, product isolation and organization isolation tests are required for backend coverage.

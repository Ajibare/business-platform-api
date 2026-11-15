# Authentication and Authorization

## Auth

Email and password authentication with short-lived access tokens and rotating refresh tokens. Issued by the auth module under `/api/v1/auth`.

- `POST /api/v1/auth/signup`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me` (JWT protected)

## Authorization

Role-based access control resolved from the organization membership. Permissions are enforced server-side.

- `JwtAuthGuard` validates the bearer token and attaches the JWT payload (including `organisationId`) to the request.
- `RolesGuard` reads `@Roles(...)` metadata and verifies the caller's active organization membership role.

## Guards

The JWT auth guard validates the bearer token and attaches the payload to the request.

The roles guard enforces per-endpoint allowed roles, for example owner and manager for product updates, and owner, manager, and inventory staff for stock mutations.

## Audit

Critical mutations write audit records with actor, timestamp, entity, action and before/after summaries.

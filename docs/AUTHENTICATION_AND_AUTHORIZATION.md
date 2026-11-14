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

## Guards

The JWT auth guard validates the bearer token and attaches the payload to the request.

## Audit

Critical mutations write audit records with actor, timestamp, entity, action and before/after summaries.

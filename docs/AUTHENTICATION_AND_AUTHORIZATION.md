# Authentication and Authorization

Summary only. The detail lives in:

- [AUTHENTICATION_ARCHITECTURE.md](./AUTHENTICATION_ARCHITECTURE.md) — module layout, request pipeline, role matrix, error codes.
- [REGISTRATION_AND_VERIFICATION.md](./REGISTRATION_AND_VERIFICATION.md) — the two-step sign-up.
- [SESSION_AND_SECURITY.md](./SESSION_AND_SECURITY.md) — tokens, rotation, rate limits, threat model.
- [AUTH_API_CONTRACTS.md](./AUTH_API_CONTRACTS.md) — request and response shapes.
- [PHARMACY_ONBOARDING.md](./PHARMACY_ONBOARDING.md) — the setup wizard.

## Auth

Email or Nigerian mobile number plus password, under `/api/v1/auth`. The access
token is a 15-minute JWT sent as `Authorization: Bearer`; the refresh token is an
HttpOnly cookie scoped to `/api/v1/auth` and is rotated on every refresh.

- `POST /api/v1/auth/register`, `POST /api/v1/auth/register/verify`, `POST /api/v1/auth/register/resend`
- `POST /api/v1/auth/sign-in` (`/auth/login` alias), `POST /api/v1/auth/refresh`, `POST /api/v1/auth/sign-out` (`/auth/logout` alias)
- `GET /api/v1/auth/me` (bearer)
- `POST /api/v1/auth/password/forgot`, `POST /api/v1/auth/password/reset`

Registering does not create an account: a `PendingRegistration` row holds a bcrypt
password hash and a keyed hash of a six-digit code, and the Owner, workspace,
membership and onboarding record are written in one transaction only after the
code is verified.

## Authorization

Role-based access control resolved from the active membership of the workspace in
the token.

- `JwtAuthGuard` verifies the bearer token and attaches `sub`, `email`,
  `organisationId` and `sid` to the request.
- `RolesGuard` reads `@Roles(...)` and re-checks the caller's membership in that
  workspace on every request, so a role change takes effect immediately.
- The organisation always comes from the token. No route accepts an organisation
  id from the client.
- Roles: `OWNER`, `MANAGER`, `INVENTORY_STAFF`, `READ_ONLY`. The setup wizard and
  invitation management are `OWNER`; a Manager may invite inventory staff and
  read-only users only.

## Audit

`AuditService.record` writes actor, action, entity and metadata to `AuditLog`,
readable through `GET /api/v1/audit` for owners and managers. Auth events:
`ORGANISATION_REGISTERED`, `STAFF_INVITED`, `INVITATION_REVOKED`,
`INVITATION_ACCEPTED`, `ONBOARDING_STEP_SAVED`, `ONBOARDING_COMPLETED`,
`SAMPLE_DATA_SEEDED`, `PASSWORD_RESET`.

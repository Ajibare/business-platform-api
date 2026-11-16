# Authentication Architecture

How a person gets from "no account" to an authenticated session with a role inside
one pharmacy workspace, and how the API enforces that on every request.

Related documents:

- [REGISTRATION_AND_VERIFICATION.md](./REGISTRATION_AND_VERIFICATION.md) — the two-step sign-up and the code.
- [SESSION_AND_SECURITY.md](./SESSION_AND_SECURITY.md) — token handling, rate limits, threat model.
- [PHARMACY_ONBOARDING.md](./PHARMACY_ONBOARDING.md) — the setup wizard after registration.
- [AUTH_API_CONTRACTS.md](./AUTH_API_CONTRACTS.md) — request and response shapes.
- [AUTH_IMPLEMENTATION_STATUS.md](./AUTH_IMPLEMENTATION_STATUS.md) — what is done and what needs a decision.

## Module layout

Everything auth-related lives under `src/modules/platform/auth`. There is one
module, one set of services, and no second copy of the rules anywhere.

| File | Responsibility |
| --- | --- |
| `auth.controller.ts` | `/auth/*` routes: register, verify, resend, sign-in, refresh, sign-out, me, password recovery. |
| `auth.service.ts` | The flows themselves: trust boundaries, ordering, transactions, profile assembly. |
| `auth.utils.ts` | Pure helpers: phone/email normalisation, password assessment, code generation, keyed hashing, masking, slugs. |
| `auth.constants.ts` | Every TTL, attempt limit and user-facing generic message. Read this first when changing behaviour. |
| `auth-context.ts` | Request/response plumbing: client key, refresh cookie read/write, trusted-origin check. |
| `session.service.ts` | Refresh-session records: create, rotate, revoke one, revoke all for a user. |
| `rate-limit.service.ts` | Fixed-window counters for the credential endpoints. |
| `invitations.controller.ts` / `invitations.service.ts` | Staff invitations: create, list, revoke, public preview, accept. |
| `onboarding.controller.ts` / `onboarding.service.ts` | Setup progress, step saves, sample data, completion. |
| `onboarding-summary.ts` | The four step definitions and the derived summary shared by `me` and onboarding. |
| `dto/*.ts` | Request validation. `class-validator` decorators are the first line of defence. |

Guard rails that already existed and are reused unchanged: `JwtAuthGuard`,
`RolesGuard`, `@CurrentUser()`, `@Roles()`, `PrismaService`, `AuditService`,
`EmailService`.

## Request pipeline

```text
HTTP
  └─ ValidationPipe (whitelist + transform)      strips unknown fields, coerces numbers
      └─ JwtAuthGuard                            verifies the bearer token, attaches sub/organisationId
          └─ RolesGuard                          reads @Roles(...) and checks the active membership
              └─ Controller                      shapes { data }
                  └─ Service                     rules, transactions, audit
                      └─ Prisma                  organisation-scoped queries
  └─ AllExceptionsFilter                         { statusCode, error, code, message, field, details, retryAfterSeconds }
```

`AllExceptionsFilter` is part of the contract: it forwards `field`,
`details` and `retryAfterSeconds` from an exception body, and turns a
`class-validator` message array into its first entry. Without that, the web app
could not show "4 attempts left", a resend countdown, or an error next to the
right input.

## Three kinds of credential

| Credential | Format | Lifetime | Where it lives | What it proves |
| --- | --- | --- | --- | --- |
| Access token | Signed JWT, `HS256` | `AUTH_ACCESS_TOKEN_TTL_SECONDS` (15 min) | Response body; web app keeps it in `localStorage` | Identity + workspace for one request |
| Refresh token | `<sessionId>.<32 random bytes>` | `AUTH_REFRESH_TOKEN_DAYS` (30 days) | HttpOnly cookie `psi_refresh`, path `/api/v1/auth` | The right to mint a new access token |
| One-off tokens | 6-digit code, or a 32-byte opaque token | 15 min (code), 30 min (reset), 7 days (invite) | Email only; a keyed hash is stored | Control of the email address |

The access token is deliberately short lived and carries the organisation:

```ts
{ sub: userId, email, organisationId, sid: sessionId }
```

`organisationId` is read from the session's membership at sign-in time, not from
anything the client sends, so a request cannot ask for another workspace.

## Session lifecycle

```text
sign-in / verify / accept invitation
        │
        ▼
   AuthSession row ── refreshTokenHash, expiresAt, revokedAt, replacedBySessionId
        │
        ▼  POST /auth/refresh   (cookie only, Origin checked)
   rotate(): revoke the presented token, issue its successor
        │
        ├─ token already revoked → revoke every session for that user, 401 SESSION_REVOKED
        ├─ expired               → mark revoked, 401 SESSION_EXPIRED
        └─ membership gone       → revoke every session, 403 NO_WORKSPACE
```

Every sign-in creates a new `AuthSession`; a person can be signed in on several
devices and signing out on one leaves the others alone. A password reset revokes
all of them.

## Workspace and role resolution

- A user has **one or more** memberships through `Membership`. Registration
  creates exactly one, as `OWNER`.
- `pickMembership` prefers the `OWNER` membership, otherwise the oldest active
  one. This is why a person who runs a pharmacy *and* helps at another one lands
  in the workspace they own.
- `loadSessionContext` refuses to build a session for a `DEACTIVATED` user or for
  a user with no active membership (`403 NO_WORKSPACE`).
- `buildProfile` re-reads the membership on every `/auth/me`; if it is no longer
  active the call fails with `403 FORBIDDEN`. A removed staff member therefore
  loses the workspace at the next token refresh, without waiting for a sign-out.
- Every product query is filtered by the `organisationId` from the token. There is
  no route that accepts an organisation id as a parameter.

### Role matrix

| Capability | OWNER | MANAGER | INVENTORY_STAFF | READ_ONLY |
| --- | --- | --- | --- | --- |
| Pharmacy setup wizard (`/onboarding/steps/*`, `sample-data`, `complete`) | yes | no | no | no |
| Invite staff | any invitable role | inventory staff, read-only | no | no |
| List / revoke invitations | yes | yes | no | no |
| Notifications: preferences, recipients, deliveries | yes | yes | no | no |
| Suppliers: create / update | yes | yes | no | no |
| Receipts, counts, imports, barcode assignment | yes | yes | yes | no |
| Read products, batches, reports, audit | yes | yes | yes | yes (read only) |

`RolesGuard` resolves the role from the database for the token's workspace on
each request, so a role change takes effect immediately rather than at the next
sign-in.

## Where a person lands after signing in

`AuthProfile.nextPath` is computed server-side:

- Owner, setup not complete → `/onboarding/pharmacy-setup`
- Owner, setup complete → `/dashboard`
- Staff (any role) → `/dashboard`

The web app prefers `?next=` from the URL when it is a same-origin path, so a
deep link survives the sign-in redirect. The guard never uses `nextPath` for a
non-Owner, which is what stops invited staff being routed into a wizard they are
not allowed to save.

## Error contract

Errors are JSON with a stable `code`; the web app matches on the code and shows
`message`, so wording can change without breaking behaviour.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | A field failed validation; `field` names it. |
| `WEAK_PASSWORD` | 400 | Password policy failed; `details.issues` lists every unmet rule. |
| `PASSWORD_MISMATCH` | 400 | `password` and `confirmPassword` differ. |
| `INVALID_PHONE` | 400 | Number is not a Nigerian mobile number. |
| `EMAIL_IN_USE` / `PHONE_IN_USE` | 409 | An account already exists for that contact. |
| `REGISTRATION_NOT_FOUND` | 400 | No pending registration for that email; start again. |
| `INVALID_CODE` | 400 | Wrong code; `details.attemptsRemaining`. |
| `CODE_EXPIRED` | 400 | The code's 15-minute window closed. |
| `TOO_MANY_ATTEMPTS` | 429 | Five wrong codes; request a new one. |
| `VERIFICATION_JUST_SENT` | 429 | Resend cooldown active; `retryAfterSeconds`. |
| `TOO_MANY_RESENDS` | 429 | Six codes already sent for this address. |
| `INVALID_CREDENTIALS` | 401 | Wrong identifier or password; deliberately generic. |
| `ACCOUNT_LOCKED` | 423 | Five failed sign-ins; `retryAfterSeconds`. |
| `ACCOUNT_DEACTIVATED` | 403 | The account was switched off by its owner. |
| `NO_WORKSPACE` | 403 | No active membership in any workspace. |
| `INVALID_SESSION` / `SESSION_REVOKED` / `SESSION_EXPIRED` | 401 | The refresh token cannot mint a new session. |
| `UNTRUSTED_ORIGIN` | 403 | Cookie-authenticated call from an unknown origin. |
| `RATE_LIMITED` | 429 | Per-IP budget exhausted; `retryAfterSeconds`. |
| `FORBIDDEN` | 403 | The role may not perform this action. |
| `INVALID_RESET_TOKEN` | 400 | Reset link used, expired, or never existed. |
| `CHANNEL_UNAVAILABLE` | 400 | Phone-only invitation: no SMS transport is configured. |
| `INVITATION_NOT_PENDING` | 400 | The invitation was already accepted or revoked. |

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | — | Signs access tokens. Required outside development. |
| `AUTH_SECRET_PEPPER` | falls back to `JWT_SECRET` | Keys every stored code, reset token, invitation token and refresh hash. Rotating it invalidates all of them. |
| `APP_WEB_URL` | `CORS_ORIGINS[0]` | Builds the links in verification, reset and invitation email. |
| `CORS_ORIGINS` | `http://localhost:3000` | Comma-separated. Also the allow-list for the Origin check. |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS` | `900` | |
| `AUTH_REFRESH_TOKEN_DAYS` | `30` | |
| `AUTH_BCRYPT_ROUNDS` | `12` | |
| `AUTH_LOGIN_MAX_ATTEMPTS` / `AUTH_LOGIN_LOCK_MINUTES` | `5` / `15` | |
| `AUTH_VERIFICATION_CODE_TTL_MINUTES` | `15` | |
| `AUTH_VERIFICATION_MAX_ATTEMPTS` | `5` | |
| `AUTH_VERIFICATION_RESEND_COOLDOWN_SECONDS` | `60` | |
| `AUTH_VERIFICATION_MAX_RESENDS` | `6` | |
| `AUTH_PASSWORD_RESET_TTL_MINUTES` | `30` | |
| `AUTH_INVITATION_TTL_DAYS` | `7` | |
| `EMAIL_TRANSPORT` | `log` | `log` writes the message to the log; `http` posts to `EMAIL_HTTP_URL`. |

In development with the `log` transport, the registration response also carries
`devCode` and invitation creation carries `devInviteUrl`. Both are impossible
when `NODE_ENV=production`. The web app does not render either of them.

## Adding a protected endpoint

1. `@UseGuards(JwtAuthGuard)` on the controller, plus `RolesGuard` and
   `@Roles(...)` when the role matters.
2. Take the workspace from `@CurrentUser('organisationId')`; never from the body
   or the query string.
3. Filter every query by that organisation id.
4. Record an audit entry when the change matters to the business.
5. Document the route in `docs/AUTH_API_CONTRACTS.md` if it is part of the auth
   surface.

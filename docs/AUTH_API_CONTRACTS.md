# Auth API Contracts

Base URL: `/api/v1`. Versioned by URI (`/api/v1/...`). JSON only.

These contracts are also implemented in the web app's `src/services/auth.ts` and
`src/types/auth.ts`; when a shape changes here, change both.

## Envelope

Success:

```json
{ "data": { }, "meta": { } }
```

`meta` is present only where a route already returned it (lists with counts).
Every auth route returns `{ data: ... }`.

Error:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "code": "WEAK_PASSWORD",
  "message": "Use at least 10 characters.",
  "field": "password",
  "details": { "issues": ["Use at least 10 characters."] },
  "retryAfterSeconds": 42
}
```

Only `statusCode`, `error`, `code` and `message` are always present. `field`
tells the form where the message belongs; `details` carries non-secret hints;
`retryAfterSeconds` is present on 429 and 423.

## Shared shapes

### `AuthProfile`

```json
{
  "user": {
    "id": "clx…",
    "name": "Ada Obi",
    "email": "ada@pharmacy.com",
    "phone": "+2348031234567",
    "status": "ACTIVE",
    "emailVerified": true,
    "phoneVerified": false,
    "createdAt": "2026-11-16T09:00:00.000Z"
  },
  "organisation": {
    "id": "clx…",
    "name": "Ada Pharmacy",
    "slug": "ada-pharmacy-4f2c1a",
    "timezone": "Africa/Lagos",
    "currency": "NGN",
    "phone": "+2348031234567",
    "address": null,
    "outletProfile": null,
    "nearExpiryWarningDays": 90,
    "defaultUnit": null,
    "defaultMinStockLevel": null,
    "onboardingCompletedAt": null
  },
  "membership": { "role": "OWNER", "active": true },
  "onboarding": { "…": "OnboardingSummary" },
  "nextPath": "/onboarding/pharmacy-setup"
}
```

`role` is one of `OWNER`, `MANAGER`, `INVENTORY_STAFF`, `READ_ONLY`.
`nextPath` is `/onboarding/pharmacy-setup` for an Owner whose setup is unfinished,
otherwise `/dashboard`.

### `OnboardingSummary`

```json
{
  "status": "IN_PROGRESS",
  "currentStep": 2,
  "completedSteps": [1],
  "firstIncompleteStep": 2,
  "steps": [
    {
      "step": 1,
      "key": "pharmacy-profile",
      "title": "Pharmacy profile",
      "description": "Name, outlet profile and time zone.",
      "optional": false,
      "completed": true
    }
  ],
  "checklist": [
    { "key": "pharmacy-profile", "label": "Confirm your pharmacy profile", "done": true, "optional": false }
  ],
  "requiresSetup": true,
  "allTasksDone": false,
  "completedAt": null
}
```

---

## Registration

### `POST /api/v1/auth/register`

Public. `201`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string 2–120 | yes | Becomes the workspace name |
| `email` | email | yes | Lowercased |
| `phone` | string 7–24 | no | Nigerian mobile number |
| `password` | string 1–200 | yes | Policy enforced by the service |
| `confirmPassword` | string | no | Checked when present |
| `termsAccepted` | boolean | yes | Must be `true` (`400` otherwise) |

Response:

```json
{
  "data": {
    "email": "ad**@pharmacy.com",
    "phone": "+2348*******567",
    "verificationRequired": true,
    "expiresInMinutes": 15,
    "resendAvailableInSeconds": 60,
    "remainingResends": 6,
    "devCode": "123456"
  }
}
```

`devCode` is present only when `NODE_ENV !== production` and
`EMAIL_TRANSPORT=log`. Contacts are masked.

Errors: `INVALID_PHONE`, `PASSWORD_MISMATCH`, `WEAK_PASSWORD`,
`EMAIL_IN_USE`, `PHONE_IN_USE`, `VERIFICATION_JUST_SENT`, `TOO_MANY_RESENDS`,
`RATE_LIMITED`, plus `VALIDATION_ERROR` for the DTO rules.

### `POST /api/v1/auth/register/verify`

Public. `200`. Sets the refresh cookie and returns a session.

| Field | Type | Required |
| --- | --- | --- |
| `email` | email | yes |
| `code` | string, exactly 6 digits | yes |

Response:

```json
{
  "data": {
    "accessToken": "eyJ…",
    "tokenType": "Bearer",
    "expiresInSeconds": 900,
    "profile": { "…": "AuthProfile" }
  }
}
```

Errors: `REGISTRATION_NOT_FOUND`, `CODE_EXPIRED`, `INVALID_CODE`
(`details.attemptsRemaining`), `TOO_MANY_ATTEMPTS`, `EMAIL_IN_USE`,
`PHONE_IN_USE`, `RATE_LIMITED`.

Verifying twice returns a session for the account that already exists.

### `POST /api/v1/auth/register/resend`

Public. `200`.

| Field | Type | Required |
| --- | --- | --- |
| `email` | email | yes |

```json
{ "data": { "sent": true, "resendAvailableInSeconds": 60, "remainingResends": 5 } }
```

Errors: `REGISTRATION_NOT_FOUND`, `VERIFICATION_JUST_SENT` (with
`retryAfterSeconds`), `TOO_MANY_RESENDS`, `RATE_LIMITED`.

---

## Sign-in and session

### `POST /api/v1/auth/sign-in`

Public. `200`. Sets the refresh cookie.

| Field | Type | Required |
| --- | --- | --- |
| `identifier` | string 5–120 | yes — email address or Nigerian phone number |
| `password` | string | yes |

```json
{
  "data": {
    "accessToken": "eyJ…",
    "tokenType": "Bearer",
    "expiresInSeconds": 900,
    "profile": { "…": "AuthProfile" }
  }
}
```

Errors:

| Code | Status | Notes |
| --- | --- | --- |
| `INVALID_CREDENTIALS` | 401 | Wrong identifier or password; `details.attemptsRemaining` before the lock |
| `ACCOUNT_LOCKED` | 423 | `retryAfterSeconds` until the lock expires |
| `ACCOUNT_DEACTIVATED` | 403 | |
| `NO_WORKSPACE` | 403 | Password correct, no active membership |
| `RATE_LIMITED` | 429 | 20 attempts / 5 minutes per IP |

`POST /api/v1/auth/login` is a backwards-compatible alias that also accepts
`{ email?, phone?, password }`.

### `POST /api/v1/auth/refresh`

Cookie only, Origin checked. `200`. Rotates the refresh token and returns a new
access token with the same body shape as sign-in.

Errors: `INVALID_SESSION`, `SESSION_REVOKED` (reuse detected — every session for
that user is revoked), `SESSION_EXPIRED`, `NO_WORKSPACE`, `UNTRUSTED_ORIGIN`.

No `Authorization` header is required: an expired access token is exactly the
case this endpoint exists for.

### `POST /api/v1/auth/sign-out`

Cookie only, Origin checked. `200`.

```json
{ "data": { "signedOut": true } }
```

Revokes the presented session and clears the cookie. Idempotent: an unknown or
already revoked token still answers `{ "signedOut": true }`.
`POST /api/v1/auth/logout` is the alias.

### `GET /api/v1/auth/me`

Bearer. `200`.

```json
{ "data": { "…": "AuthProfile" } }
```

Errors: `401` when the token is missing, invalid or expired; `403 FORBIDDEN` when
the membership is no longer active.

---

## Password recovery

### `POST /api/v1/auth/password/forgot`

Public. `200`, always.

| Field | Type | Required |
| --- | --- | --- |
| `identifier` | string 5–120 | yes |

```json
{
  "data": {
    "message": "If an account exists for this email or phone, we have sent password-reset instructions."
  }
}
```

An email is sent only when an active account with an email address matches.
A phone number cannot receive a link (no SMS transport), and the response is
identical either way. Errors: `RATE_LIMITED` (6 / 15 min per IP).

### `POST /api/v1/auth/password/reset`

Public. `200`.

| Field | Type | Required |
| --- | --- | --- |
| `token` | string | yes |
| `password` | string | yes |
| `confirmPassword` | string | no |

```json
{ "data": { "message": "Your password has been updated. Sign in with your new password." } }
```

Single use, 30-minute window. Clears the lockout counter and revokes every
session for the user. Errors: `INVALID_RESET_TOKEN`, `WEAK_PASSWORD`,
`PASSWORD_MISMATCH`, `ACCOUNT_DEACTIVATED`, `RATE_LIMITED`.

---

## Staff invitations

### `POST /api/v1/invitations`

Bearer, `OWNER` or `MANAGER`. `201`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `email` | email | yes in practice | Phone-only invites return `CHANNEL_UNAVAILABLE` |
| `phone` | string 7–24 | no | Stored for matching, never messaged |
| `role` | `MANAGER` \| `INVENTORY_STAFF` \| `READ_ONLY` | yes | `OWNER` cannot be invited |

```json
{
  "data": {
    "id": "clx…",
    "email": "staff@pharmacy.com",
    "phone": null,
    "role": "INVENTORY_STAFF",
    "status": "PENDING",
    "expiresAt": "2026-11-23T09:00:00.000Z",
    "delivered": true,
    "devInviteUrl": "http://localhost:3000/invite/…"
  }
}
```

`devInviteUrl` only outside production with the log transport.

Errors: `FORBIDDEN` (a Manager inviting a Manager), `CHANNEL_UNAVAILABLE`,
`INVALID_PHONE`, `VALIDATION_ERROR`, `RATE_LIMITED`.

### `GET /api/v1/invitations`

Bearer, `OWNER` or `MANAGER`. `200`. Most recent 100.

```json
{
  "data": [
    {
      "id": "clx…",
      "email": "staff@pharmacy.com",
      "phone": null,
      "role": "INVENTORY_STAFF",
      "status": "PENDING",
      "expiresAt": "2026-11-23T09:00:00.000Z",
      "acceptedAt": null,
      "createdAt": "2026-11-16T09:00:00.000Z"
    }
  ]
}
```

`status` may also be `EXPIRED`, which is derived (the row stays `PENDING`).

### `DELETE /api/v1/invitations/:id`

Bearer, `OWNER` or `MANAGER`. `200`.

```json
{ "data": { "id": "clx…", "status": "REVOKED" } }
```

Errors: `NOT_FOUND`, `INVITATION_NOT_PENDING`.

### `GET /api/v1/invitations/:token`

Public, rate limited (30 / 10 min per IP). `200`. Powers the invite page before
the person has an account.

```json
{
  "data": {
    "organizationName": "Ada Pharmacy",
    "role": "INVENTORY_STAFF",
    "email": "staff@pharmacy.com",
    "phone": null,
    "hasAccount": false,
    "expiresAt": "2026-11-23T09:00:00.000Z"
  }
}
```

Errors: `404 INVALID_INVITATION`, `INVITATION_REVOKED`,
`INVITATION_ALREADY_ACCEPTED`, `INVITATION_EXPIRED`, `RATE_LIMITED`.

### `POST /api/v1/invitations/:token/accept`

Public. `200`. For a person who has no account yet. Creates the user, the
membership with **the invitation's role**, marks the invitation accepted, audits
`INVITATION_ACCEPTED`, and returns a session.

| Field | Type | Required |
| --- | --- | --- |
| `name` | string 2–120 | yes |
| `password` | string | yes |
| `confirmPassword` | string | no |

Response: same body as sign-in. `profile.organisation` is the inviting workspace.

Errors: `ACCOUNT_EXISTS` (sign in, then use `accept-existing`), `WEAK_PASSWORD`,
`PASSWORD_MISMATCH`, `INVALID_INVITATION`, `INVITATION_REVOKED`,
`INVITATION_ALREADY_ACCEPTED`, `INVITATION_EXPIRED`, `CHANNEL_UNAVAILABLE`.

### `POST /api/v1/invitations/:token/accept-existing`

Bearer. `200`. For a person who already has an account and is signed in.

The signed-in email or phone must match the invitation
(`403 INVITATION_MISMATCH`). Returns a session for the inviting workspace and
rotates the cookie. Errors: `ALREADY_MEMBER`, `INVALID_SESSION`,
`INVITATION_MISMATCH`, plus the invitation state errors above.

---

## Onboarding

All onboarding routes require a bearer token. `GET` is open to every member;
the rest are `OWNER` only (`403 FORBIDDEN`).

### `GET /api/v1/onboarding`

```json
{
  "data": {
    "organization": {
      "id": "clx…",
      "name": "Ada Pharmacy",
      "slug": "ada-pharmacy-4f2c1a",
      "timezone": "Africa/Lagos",
      "currency": "NGN",
      "phone": "+2348031234567",
      "address": null,
      "outletProfile": "Community pharmacy",
      "nearExpiryWarningDays": 90,
      "defaultUnit": "tablet",
      "defaultMinStockLevel": null
    },
    "progress": { "…": "OnboardingSummary" },
    "counts": { "members": 2, "products": 3, "pendingInvitations": 1 },
    "inventoryNotice": "Imported or recorded quantities are system-recorded balances. They have not been physically verified."
  }
}
```

### `PATCH /api/v1/onboarding/steps/1`

| Field | Type | Required |
| --- | --- | --- |
| `name` | string 2–120 | yes |
| `outletProfile` | one of the five outlet profiles | yes |
| `address` | string 3–200 | no |
| `timezone` | IANA identifier 3–64 | no (default `Africa/Lagos`) |

Returns the full overview. Errors: `INVALID_TIMEZONE`, `VALIDATION_ERROR`,
`FORBIDDEN`.

### `PATCH /api/v1/onboarding/steps/2`

| Field | Type | Required |
| --- | --- | --- |
| `nearExpiryWarningDays` | integer 1–365 | yes |
| `defaultUnit` | string 1–24 | no |
| `defaultMinStockLevel` | number ≥ 0, or `null` | no — `null` means "not configured" |

Returns the full overview.

### `PATCH /api/v1/onboarding/steps/3`

No body. Marks the invite step seen or skipped. Returns the overview.

### `PATCH /api/v1/onboarding/steps/4`

| Field | Type | Required |
| --- | --- | --- |
| `choice` | `IMPORT` \| `MANUAL` \| `SAMPLE` \| `EMPTY` | yes |

`SAMPLE` seeds the three sample products first. Returns the overview.

### `POST /api/v1/onboarding/sample-data`

No body. Idempotent.

```json
{ "data": { "created": 3, "products": [{ "id": "clx…", "name": "Paracetamol 500mg tablets" }] } }
```

### `POST /api/v1/onboarding/complete`

No body. `200`.

```json
{
  "data": {
    "completed": true,
    "nextPath": "/dashboard",
    "onboarding": { "…": "OnboardingSummary" }
  }
}
```

Errors: `400 ONBOARDING_INCOMPLETE` with `details.missingSteps` (steps 1 and 2 are
required; 3 and 4 are not).

---

## Status codes at a glance

| Code | Used for |
| --- | --- |
| 200 | Successful read, sign-in, refresh, sign-out, step save, completion |
| 201 | Registration started, invitation created |
| 400 | Validation, weak password, bad or expired code, invalid token, incomplete onboarding |
| 401 | Invalid credentials, bad or expired session |
| 403 | Role not allowed, deactivated account, no workspace, untrusted origin, invitation mismatch |
| 404 | Unknown invitation, unknown record |
| 409 | Email/phone in use, account exists, already a member |
| 423 | Account locked |
| 429 | Rate limit, resend cooldown, too many code attempts |

## Not implemented

- **No Swagger UI.** `@nestjs/swagger` is not a dependency and the project has
  never exposed an OpenAPI document, so these contracts are the source of truth.
  Adding the package would mean decorating ~25 routes; see decision 13 in
  `OPEN_PRODUCT_DECISIONS.md`.
- **No `/auth/signup` route.** The original draft had one; registration is the
  two-step `register` + `register/verify` pair. Only `login` and `logout` kept an
  alias.

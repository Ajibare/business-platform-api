# Session and Security

What protects an account, what an attacker would have to do to take one over, and
where the remaining risk sits. Written to be read before changing anything in
`auth/*`.

## Threat model

| Threat | Control |
| --- | --- |
| Password guessing | bcrypt cost 12; per-account lockout after 5 failures; per-IP budget on sign-in |
| Credential stuffing | Per-IP budget (20 sign-ins / 5 min); generic error message |
| Offline hash cracking after a database leak | bcrypt for passwords; HMAC-SHA256 with an environment pepper for codes and tokens |
| Replaying a stolen refresh cookie | Rotation on every refresh, with reuse detection that revokes all sessions for that user |
| Reading the refresh token from JavaScript | The token is only ever sent as an `HttpOnly` cookie |
| Cross-site request forgery on cookie endpoints | `SameSite=Lax` plus an explicit Origin allow-list |
| Asking for another workspace's data | The organisation comes from the signed token, never from the request |
| Account enumeration on sign-in or recovery | One generic message, and a reset request always answers the same way |
| Guessing the six-digit code | 5 attempts per code, 15-minute window, keyed hash at rest, resend cooldown |
| An ex-staff member keeping access | Membership is re-checked on every `/me` and refresh; removing it ends the session at the next refresh |
| A leaked log line becoming a credential | Codes, tokens and passwords are never logged; addresses are masked |

## Token handling

| Token | Lifetime | Storage | Revocable |
| --- | --- | --- | --- |
| Access JWT | 900 s | `localStorage` (`accessToken`) | Not individually; expires quickly |
| Refresh token | 30 days | HttpOnly cookie `psi_refresh`, `Path=/api/v1/auth` | Yes, per session and per user |
| Verification code | 15 min | HMAC hash in `PendingRegistration` | Yes, by replacing it |
| Password reset token | 30 min | HMAC hash in `PasswordReset` | Yes, single use |
| Invitation token | 7 days | HMAC hash in `StaffInvitation` | Yes, single use and revocable |

Why the access token is readable by JavaScript: the app has to send it in an
`Authorization` header synchronously, including from a cold page load. The
trade-off is that a script injected into the page could read a token that is
valid for at most 15 minutes. The refresh token is the valuable one, and that is
never exposed to script.

Cookie flags (`refreshCookieOptions`):

```ts
{ httpOnly: true, sameSite: 'lax', secure: NODE_ENV === 'production',
  path: '/api/v1/auth', expires: <session expiry> }
```

The cookie is scoped to `/api/v1/auth`, so it is not attached to product
requests at all.

### Rotation and reuse detection

`SessionService.rotate`:

1. Finds the session by id prefix and keyed hash of the whole token.
2. Not found → `401 INVALID_SESSION`.
3. `revokedAt` set → the same token was presented twice, so **every** session for
   that user is revoked and the caller gets `401 SESSION_REVOKED`.
4. Expired → marked revoked, `401 SESSION_EXPIRED`.
5. Otherwise a replacement session is created, the old row records
   `replacedBySessionId`, and both the access token and the new cookie are
   returned.

The web app's `renewAccessToken` is single-flight: concurrent 401s share one
refresh request. Without that, a page firing several queries would present the
same refresh token several times and trip reuse detection, signing the person out
of everything.

## CSRF and origins

Cookie-authenticated endpoints (`/auth/refresh`, `/auth/sign-out`) call
`assertTrustedOrigin`. A request without an `Origin` header is allowed (CLI
clients, tests); a browser always sends one, and only `CORS_ORIGINS` entries pass.
Anything else is `403 UNTRUSTED_ORIGIN`.

`CORS_ORIGINS` is a comma-separated allow-list with `credentials: true`. It is
read from configuration, never reflected from the request.

## Rate limits

All counters are keyed per client IP (`x-forwarded-for` first entry, then the
socket address).

| Bucket | Limit | Window | Code |
| --- | --- | --- | --- |
| `register` | 6 | 15 min | `RATE_LIMITED` |
| `verify` | 6 | 15 min | `RATE_LIMITED` |
| `verify-resend` | 6 | 15 min | `RATE_LIMITED` |
| `signin` | 20 | 5 min | `RATE_LIMITED` |
| `forgot` | 6 | 15 min | `RATE_LIMITED` |
| `reset` | 6 | 15 min | `RATE_LIMITED` |
| `invitation-preview` | 30 | 10 min | `RATE_LIMITED` |

Every 429 carries `retryAfterSeconds`, and the web app shows the wait instead of
the raw error.

`AUTH_RATE_LIMIT_DRIVER` documents the intent; today the store is an in-process
`Map`. **One API instance is assumed.** Behind a load balancer each replica has
its own counters, so the effective limit multiplies by the replica count. Moving
`RateLimitService` to Redis is the only change needed when that happens.

## Per-account lockout

Separate from the IP budget, and stored on the user row so it survives a restart:

- `failedLoginAttempts` increments on every wrong password.
- On the fifth failure `lockedUntil = now + 15 min` and the response is
  **`423 ACCOUNT_LOCKED`** with `retryAfterSeconds`.
- While locked, even a correct password is refused (`423`) until the window ends.
- A field error before the fifth failure carries `details.attemptsRemaining`.
- A successful sign-in resets the counter and clears `lockedUntil`.
- A password reset also clears both.

The response distinguishes `ACCOUNT_LOCKED` from `INVALID_CREDENTIALS` on purpose:
the person needs to know that waiting is the fix.

## Passwords

Policy, enforced server-side in `assessPassword` and mirrored by the web app so a
form that says "strong" is never rejected:

- at least 10 characters;
- at least one lowercase letter, one uppercase letter, one digit;
- not in the common-password denylist;
- must not contain the person's name or the local part of their email (tokens of
  3+ characters).

Hashed with bcrypt at cost `AUTH_BCRYPT_ROUNDS` (12). Login failures on an unknown
identifier still run a bcrypt comparison against a cached dummy hash, so the
response time does not reveal whether the account exists.

Rate-limit counters and account lockout are the only brute-force controls; there
is no captcha and no MFA.

## Secrets at rest

`hashSecret` is HMAC-SHA256 keyed by `AUTH_SECRET_PEPPER` (falling back to
`JWT_SECRET`). It is used for:

- verification codes,
- password reset tokens,
- invitation tokens,
- refresh token hashes.

Consequences:

- A database dump cannot be turned into valid codes or tokens offline.
- Rotating the pepper invalidates every pending code, reset link, invitation and
  refresh session. That is the intended "sign everyone out" switch, and it should
  be planned, not discovered.
- `AUTH_SECRET_PEPPER` must be set explicitly in production; the fallback exists
  only so a development environment starts without extra setup.

Comparison uses `timingSafeEqual` via `safeEqual`, so code verification does not
leak a prefix match through timing.

## Enumeration

| Endpoint | Behaviour |
| --- | --- |
| `POST /auth/sign-in` | Always `INVALID_CREDENTIALS` for a bad identifier or password; the dummy hash makes the timing match too |
| `POST /auth/password/forgot` | Always `200` with the same message; an email is only sent when the account is active and has an email address |
| `POST /auth/register` | Returns `EMAIL_IN_USE` / `PHONE_IN_USE`. This is a deliberate usability trade-off: people must be told that they already have an account, and a real registration attempt is already rate-limited and requires a valid code |
| `POST /auth/register/verify` | `INVALID_CODE` does not say whether the code exists |

Deactivated accounts are told so (`ACCOUNT_DEACTIVATED`) rather than being given
a fake generic error, because the person needs to contact their workspace owner.

## Membership and revocation

- Removing or deactivating a membership takes effect on the next `/auth/me` or
  refresh: `loadSessionContext` returns `null`, all sessions for that user are
  revoked, and the client is bounced to sign-in.
- Deactivating the user (`status = DEACTIVATED`) has the same effect and also
  blocks sign-in.
- There is no "revoke this device" screen yet; `signOutAll` exists in the service
  and is used by the password reset path.

## Audit trail

`AuditService.record` writes to `AuditLog` with the actor and the workspace.
Events in the auth surface:

| Action | When |
| --- | --- |
| `ORGANISATION_REGISTERED` | A new Owner and workspace are created |
| `STAFF_INVITED` | An invitation is created, with role and delivery result |
| `INVITATION_REVOKED` | An invitation is revoked |
| `INVITATION_ACCEPTED` | An invited person joins |
| `ONBOARDING_STEP_SAVED` | A wizard step is saved (step and key values) |
| `ONBOARDING_COMPLETED` | Setup is finished |
| `SAMPLE_DATA_SEEDED` | Sample products are created |
| `PASSWORD_RESET` | A password is changed through the reset link |

Sign-in and sign-out are not audited. They are high volume and low value for this
product; the session rows themselves record IP, user agent and last use.

## Logging hygiene

- Verification codes are logged only in non-production with the `log` transport.
- Email addresses are masked (`ad**@pharmacy.com`) before they reach a log line.
- The refresh token, access token, password and password hash are never logged.
- Email delivery failures are logged with the masked address and the provider
  error, never the message body.

## Production checklist

1. Set `JWT_SECRET` and `AUTH_SECRET_PEPPER` to long random values, distinct from
   each other.
2. Set `CORS_ORIGINS` to the real web origins (no wildcard, no trailing slash).
3. Run behind HTTPS; the refresh cookie sets `Secure` when `NODE_ENV=production`.
4. Ensure the proxy sets `x-forwarded-for`, otherwise every client shares one
   rate-limit bucket and the lockout counters key on the proxy address.
5. Set `EMAIL_TRANSPORT=http` with `EMAIL_HTTP_URL` and `EMAIL_HTTP_API_KEY`, and
   configure SPF/DKIM for `EMAIL_FROM`'s domain.
6. Set `APP_WEB_URL` so verification, reset and invitation links point at the real
   site.
7. Run the schema migration (see `AUTH_IMPLEMENTATION_STATUS.md`) before the first
   deployment that uses these endpoints.

## Known gaps

- **In-memory rate limiting.** Correct for one instance, weakened by horizontal
  scaling. Move to Redis before adding a second API replica.
- **No MFA.** Not in the brief; would need recovery codes and a policy decision.
- **No session management screen.** A person cannot see or revoke individual
  devices.
- **No automatic bcrypt rehash.** Raising `AUTH_BCRYPT_ROUNDS` affects new hashes
  only; existing hashes keep verifying at their own cost.
- **No SMS.** Phone numbers can sign in and be invited, but only email receives a
  code or a reset link.

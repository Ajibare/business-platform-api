# Registration and Verification

Two steps, on purpose: nothing that can sign in is written until the person
proves they control the email address. An abandoned form cannot reserve an email
address, a workspace name or a slug.

## Step 1 — `POST /api/v1/auth/register`

Request:

```json
{
  "name": "Ada Obi",
  "email": "ada@pharmacy.com",
  "phone": "0803 123 4567",
  "password": "Pharmacy#2024Stock",
  "confirmPassword": "Pharmacy#2024Stock",
  "termsAccepted": true
}
```

`name`, `email`, `password` and `termsAccepted` are required. `phone` is optional;
when present it must be a Nigerian mobile number in any of the shapes staff type
(`0803…`, `803…`, `+234803…`, `234803…`, with spaces, dashes or brackets).

Checks run in this order, so the most useful message wins:

1. `phone` format → `400 INVALID_PHONE` with `field: "phone"`.
2. `password !== confirmPassword` → `400 PASSWORD_MISMATCH` with `field: "confirmPassword"`.
3. Password policy → `400 WEAK_PASSWORD`, `details.issues` (every unmet rule), `field: "password"`.
4. Per-IP budget: 6 attempts / 15 minutes → `429 RATE_LIMITED`.
5. Existing account on that email or phone → `409 EMAIL_IN_USE` / `409 PHONE_IN_USE`.
6. An earlier pending registration for the same email:
   - resent within 60 s → `429 VERIFICATION_JUST_SENT` with `retryAfterSeconds`;
   - already resent 6 times → `429 TOO_MANY_RESENDS`.

Nothing is created on the `User` table. A `PendingRegistration` row is written
(or replaced) with:

| Column | Content |
| --- | --- |
| `name`, `email`, `phone` | Normalised: email lowercased, phone canonicalised to `+234…` |
| `passwordHash` | bcrypt, cost 12 |
| `termsAcceptedAt` | Timestamp of this request |
| `verificationCodeHash` | HMAC-SHA256 of the six-digit code, keyed by `AUTH_SECRET_PEPPER` |
| `codeExpiresAt` | Now + 15 minutes |
| `attempts` | Reset to `0` |
| `resendCount`, `lastSentAt` | Drive the cooldown and the resend cap |

Then the code is emailed. Response `201`:

```json
{
  "data": {
    "email": "ad**@pharmacy.com",
    "phone": "+2348*******567",
    "verificationRequired": true,
    "expiresInMinutes": 15,
    "resendAvailableInSeconds": 60,
    "remainingResends": 6
  }
}
```

Contacts are **masked**. The code is never in the response body in production;
with `NODE_ENV !== production` and `EMAIL_TRANSPORT=log` the response also carries
`devCode`, and the API log prints the code, so the flow can be completed locally
without a mail provider. The web app deliberately does not render `devCode`.

Re-submitting step 1 for the same email after the cooldown replaces the pending
row (new code, new attempt counter) instead of stacking rows. The email is the
unique key, so a second browser cannot create a parallel registration.

## Step 2 — `POST /api/v1/auth/register/verify`

```json
{ "email": "ada@pharmacy.com", "code": "123456" }
```

1. Per-IP budget: 6 attempts / 15 minutes → `429 RATE_LIMITED`.
2. No pending row → `400 REGISTRATION_NOT_FOUND`.
3. Code window closed → `400 CODE_EXPIRED`.
4. Wrong code → counter increments, `400 INVALID_CODE` with
   `details.attemptsRemaining`; the fifth wrong code is
   `429 TOO_MANY_ATTEMPTS` and the person must request a new one.
5. Correct code and not yet verified → one transaction creates:
   - `User` (active, `emailVerifiedAt = now`, `phoneVerifiedAt = null`),
   - `Organization` (the person's name, slug `<name-slug>-<6 hex>`, `Africa/Lagos`, `NGN`, 90-day expiry window),
   - `Membership` with role `OWNER`,
   - `OnboardingProgress` (`IN_PROGRESS`, step 1, no completed steps),
   - marks the `PendingRegistration` verified and linked to the user.
6. Audit `ORGANISATION_REGISTERED`.
7. A session is created and the refresh cookie set. Response `200`:

```json
{
  "data": {
    "accessToken": "…",
    "tokenType": "Bearer",
    "expiresInSeconds": 900,
    "profile": { "…": "see AUTH_API_CONTRACTS.md" }
  }
}
```

`profile.nextPath` is `/onboarding/pharmacy-setup` for this Owner.

### Why `phoneVerifiedAt` stays null

Only the email address receives a code. There is no SMS transport, so the phone
number is a sign-in identifier, not a verified contact. Marking it verified would
be a lie the UI would then repeat.

### Idempotency

Verifying an already-verified registration returns a **new session for the
existing account**; it does not create a second workspace. Two requests racing
each other are settled by the unique constraints: the loser gets
`409 EMAIL_IN_USE` / `409 PHONE_IN_USE` from the `P2002` handler rather than a
duplicate workspace.

## Resend — `POST /api/v1/auth/register/resend`

```json
{ "email": "ada@pharmacy.com" }
```

Issues a fresh code, resets `attempts` to `0`, increments `resendCount`, and
returns:

```json
{ "data": { "sent": true, "resendAvailableInSeconds": 60, "remainingResends": 5 } }
```

Errors: `REGISTRATION_NOT_FOUND`, `VERIFICATION_JUST_SENT` (with
`retryAfterSeconds`), `TOO_MANY_RESENDS`, `RATE_LIMITED`.

Changing the email or phone number means going back to step 1, which is why the
verification screen offers "Change email or phone number" instead of an inline
edit — the pending row is keyed by email.

## What the email says

Plain text, no HTML templates, no tracking pixels:

```text
Hello Ada Obi,

Your verification code is 123456.
It expires in 15 minutes. If you did not create an account, ignore this email.
```

Delivery goes through `EmailService.sendTransactional`. With the default `log`
transport the attempt is recorded and written to the log; with `http` it is
posted to `EMAIL_HTTP_URL` with `EMAIL_HTTP_API_KEY`. A delivery failure is logged
with the address masked and does **not** reveal to the caller that the address
exists.

## Frontend mapping

`/sign-up` (`src/features/auth/sign-up-flow.tsx`) is one page with a `details`
and a `verify` phase:

| API outcome | What the person sees |
| --- | --- |
| `201` | Step 2: six boxes, masked email/phone, "expires in 15 minutes" |
| `EMAIL_IN_USE` / `PHONE_IN_USE` | Message under that field, with a link to sign in |
| `WEAK_PASSWORD` | First unmet rule under the password, full list in the strength indicator |
| `VERIFICATION_JUST_SENT` | Step 2 with the countdown already running (`retryAfterSeconds`) |
| `INVALID_CODE` | "That code is not correct… 4 attempts left" |
| `TOO_MANY_ATTEMPTS` | Code boxes disabled, "request a new code" |
| `CODE_EXPIRED` | Same, with the Resend button enabled |
| `TOO_MANY_RESENDS` | Resend disabled, message to contact support |
| Network failure | "We could not reach the server…", form values kept |

The six-box field auto-advances, accepts a pasted code anywhere, moves back on
backspace and opens a numeric keyboard on mobile. The resend button shows a live
countdown so it can never be pressed early.

## Gaps

- **No cleanup job.** Abandoned `PendingRegistration` rows stay until the same
  email registers again. A daily delete of rows where `verifiedAt IS NULL AND
  codeExpiresAt < now() - 7 days` is safe to add.
- **No SMS.** Phone numbers can sign in but cannot receive a code or a reset
  link. See decision 7 in `OPEN_PRODUCT_DECISIONS.md`.

# Auth Implementation Status

State of the authentication and pharmacy registration work described in the
brief. Everything below is in the working tree of the two repositories; nothing is
committed and nothing has been deployed.

Verified on 2026-11-16 with the commands in "Verification performed".

## Requirement coverage

| Brief section | Status | Where |
| --- | --- | --- |
| §1 Audit before implementing | Done | Existing guards, `PrismaService`, `AuditService`, `EmailService`, UI kit reused; four obsolete auth DTOs removed rather than left beside the new ones |
| §2A Sign-in `/sign-in` | Done | `src/app/(auth)/sign-in`, `src/features/auth/sign-in-form.tsx` |
| §2B Sign-up `/sign-up`, two steps | Done | `src/app/(auth)/sign-up`, `src/features/auth/sign-up-flow.tsx` |
| §2C Forgot / reset password | Done | `src/app/(auth)/forgot-password`, `src/app/(auth)/reset-password`, two forms |
| §2D Invitation acceptance | Done | `src/app/(auth)/invite/[token]`, `src/features/auth/invitation-acceptance.tsx` |
| §3 Pharmacy setup wizard | Done | `src/app/onboarding/**`, `src/features/onboarding/**`, dashboard checklist |
| §4 Backend auth | Done | `src/modules/platform/auth/**` |
| §5 Database / workspace | Done in the schema; **migration not generated** | `prisma/schema.prisma` |
| §6 Frontend components | Done | `src/components/auth/*`, `src/components/onboarding/*` |
| §7 API contracts + Swagger | Contracts documented; **no Swagger UI** (package not present) | `docs/AUTH_API_CONTRACTS.md` |
| §8 Testing | Unit tests added in both repos; linters, type checks and production builds pass | see below |
| §9 Documentation | Six documents | `docs/AUTH_*.md`, `docs/PHARMACY_ONBOARDING.md`, `docs/REGISTRATION_AND_VERIFICATION.md`, `docs/SESSION_AND_SECURITY.md` |

## Files added — backend

| File | Purpose |
| --- | --- |
| `src/modules/platform/auth/auth.constants.ts` | TTLs, attempt limits, generic messages |
| `src/modules/platform/auth/auth.utils.ts` + `.spec.ts` | Normalisation, password policy, code/token generation, keyed hashing, masking |
| `src/modules/platform/auth/auth-context.ts` | Client key, refresh cookie, trusted-origin check |
| `src/modules/platform/auth/session.service.ts` + `.spec.ts` | Session create / rotate / revoke |
| `src/modules/platform/auth/rate-limit.service.ts` + `.spec.ts` | Fixed-window counters |
| `src/modules/platform/auth/invitations.service.ts`, `invitations.controller.ts` | Staff invitations |
| `src/modules/platform/auth/onboarding.service.ts`, `onboarding.controller.ts`, `onboarding-summary.ts` + `.spec.ts` | Setup wizard data |
| `src/modules/platform/auth/dto/register.dto.ts`, `verify-registration.dto.ts`, `sign-in.dto.ts`, `password-recovery.dto.ts`, `invitation.dto.ts`, `onboarding.dto.ts` | Request validation |

## Files changed — backend

| File | Change |
| --- | --- |
| `src/modules/platform/auth/auth.controller.ts` | Replaced the draft routes with register/verify/resend, sign-in, refresh, sign-out, me, password recovery; kept `login`/`logout` aliases |
| `src/modules/platform/auth/auth.service.ts` | Registration, verification, lockout, sessions, profile assembly, recovery |
| `src/modules/platform/auth/auth.module.ts` | Wires the new services and `EmailService` |
| `src/common/filters/all-exceptions.filter.ts` | Forwards `field`, `details`, `retryAfterSeconds`; unwraps validator message arrays |
| `src/main.ts` | CORS with credentials from `CORS_ORIGINS` |
| `src/modules/platform/audit/audit.service.ts`, `audit.module.ts` | Implemented `record()` and exported the service |
| `prisma/schema.prisma` | Auth and onboarding models and columns (see below) |
| `.env.example` | Auth and email variables |
| **Deleted** `dto/login.dto.ts`, `dto/logout.dto.ts`, `dto/refresh.dto.ts`, `dto/signup.dto.ts` | Superseded; nothing imported them after the rewrite |

## Files added — frontend

| File | Purpose |
| --- | --- |
| `src/types/auth.ts` | Contracts mirrored from the API |
| `src/services/api.ts` (rewritten) | `apiFetch`, `ApiError`, single-flight `renewAccessToken`, session-expired event |
| `src/services/auth.ts` | `authApi`, `invitationApi`, `onboardingApi` |
| `src/hooks/use-auth.ts` (rewritten) | Profile + token state, silent renewal, cross-component sync |
| `src/components/guards/auth-guard.tsx` (rewritten) | Sign-in redirect with `?next=`, Owner-only setup gate |
| `src/lib/auth-validation.ts` + `.test.ts` | Zod schemas and the mirrored password/phone rules |
| `src/components/auth/auth-card.tsx`, `auth-input.tsx`, `password-input.tsx`, `password-strength-indicator.tsx`, `verification-code-input.tsx`, `auth-submit-button.tsx`, `auth-message.tsx` | Reusable auth UI |
| `src/components/onboarding/onboarding-layout.tsx`, `onboarding-progress.tsx`, `onboarding-step.tsx`, `select-field.tsx` | Wizard shell |
| `src/features/auth/sign-in-form.tsx`, `sign-up-flow.tsx`, `forgot-password-form.tsx`, `reset-password-form.tsx`, `invitation-acceptance.tsx` | Flows |
| `src/features/onboarding/pharmacy-setup-wizard.tsx`, `pharmacy-profile-step.tsx`, `stock-settings-step.tsx`, `staff-invite-panel.tsx`, `stock-start-step.tsx`, `setup-checklist.tsx` | Wizard steps and checklist |
| `src/app/(auth)/sign-in`, `sign-up`, `forgot-password`, `reset-password`, `invite/[token]` | Routes |
| `src/app/onboarding/layout.tsx`, `src/app/onboarding/pharmacy-setup/page.tsx` | Routes |
| Tests: `src/lib/auth-validation.test.ts`, `src/components/auth/verification-code-input.test.tsx`, `src/components/auth/password-strength-indicator.test.tsx`, `src/features/auth/sign-in-form.test.tsx` | |

## Files changed — frontend

| File | Change |
| --- | --- |
| `src/components/guards/auth-guard.test.tsx` | Rewritten for `usePathname`, `/sign-in?next=`, and the Owner-only setup gate |
| `src/components/layouts/auth-layout.tsx` | Split brand/form layout |
| `src/components/layouts/app-shell.tsx` | Workspace name and role from the profile; sign-out calls the API and lands on `/sign-in` |
| `src/app/(platform)/dashboard/page.tsx` | Renders the setup checklist |
| `src/app/(auth)/login/page.tsx` | Redirects to `/sign-in` |
| `tailwind.config.ts` | Added the numeric `slate` scale that `bg-slate-100/200` referred to |
| **Deleted** `src/features/auth/login-form.tsx`, `login-form.test.tsx` | Replaced by `sign-in-form.tsx` |

## Endpoints created

| Method | Path |
| --- | --- |
| POST | `/api/v1/auth/register` |
| POST | `/api/v1/auth/register/verify` |
| POST | `/api/v1/auth/register/resend` |
| POST | `/api/v1/auth/sign-in` (`/auth/login` alias) |
| POST | `/api/v1/auth/refresh` |
| POST | `/api/v1/auth/sign-out` (`/auth/logout` alias) |
| GET | `/api/v1/auth/me` |
| POST | `/api/v1/auth/password/forgot` |
| POST | `/api/v1/auth/password/reset` |
| POST | `/api/v1/invitations` |
| GET | `/api/v1/invitations` |
| DELETE | `/api/v1/invitations/:id` |
| GET | `/api/v1/invitations/:token` |
| POST | `/api/v1/invitations/:token/accept` |
| POST | `/api/v1/invitations/:token/accept-existing` |
| GET | `/api/v1/onboarding` |
| PATCH | `/api/v1/onboarding/steps/1` … `/steps/4` |
| POST | `/api/v1/onboarding/sample-data` |
| POST | `/api/v1/onboarding/complete` |

Request and response shapes: `docs/AUTH_API_CONTRACTS.md`.

## Schema changes

Added:

- `enum UserStatus { ACTIVE, DEACTIVATED }`, `enum InvitationStatus { PENDING, ACCEPTED, REVOKED }`
- `Organization`: `phone`, `address`, `outletProfile`, `nearExpiryWarningDays` (default 90),
  `defaultUnit`, `defaultMinStockLevel`, `onboardingCompletedAt`, and the `invitations`
  and `onboarding` relations
- `User`: `status`, `emailVerifiedAt`, `phoneVerifiedAt`, `failedLoginAttempts`,
  `lockedUntil`, `lastLoginAt`, `passwordChangedAt`, the `sessions` and
  `passwordResets` relations; `name`, `email`, `phone`, `passwordHash` are now
  nullable because an invited person is created without some of them
- `Product.isSample` (marks onboarding sample data so the UI can label it)
- Models `AuthSession`, `PendingRegistration`, `PasswordReset`, `StaffInvitation`,
  `OnboardingProgress`

### Migration status: not generated

`prisma/migrations/` does not exist in this repository, and it did not exist before
this change (see decision 6 in `OPEN_PRODUCT_DECISIONS.md`). `npx prisma generate`
has been run, which is why the client and the type checks are clean, but **no
database has been altered from here**.

Before the first deployment that uses these endpoints, run from
`business-platform-api`:

```bash
npx prisma migrate dev --name authentication_and_onboarding
npx prisma generate
```

For an existing production database without migration history, create a baseline
with `prisma migrate diff` first and apply this change on top. Do not use
`db push` on production data.

The working tree also contains the notification, barcode and bulk-import schema
from the previous piece of work; a single migration will cover both.

## Verification performed

| Command | Repository | Result |
| --- | --- | --- |
| `npx tsc --noEmit` | `business-platform-api` | clean |
| `npm run lint` | `business-platform-api` | clean (`eslint --fix`, no remaining findings) |
| `npx jest` | `business-platform-api` | **18 suites, 127 tests passed** |
| `npm run build` | `business-platform-api` | clean (`nest build`) |
| `npx tsc --noEmit` | `business-platform-web` | clean |
| `npm run lint` | `business-platform-web` | clean (`next lint`) |
| `npx jest` | `business-platform-web` | **10 suites, 93 tests passed** |
| `npm run build` | `business-platform-web` | clean; 23 routes generated, including all auth and onboarding routes |

New frontend tests cover:

- Nigerian phone formats (`0803…`, `803…`, `+234803…`, `234803…`, spaced and
  bracketed) and the numbers that must be rejected;
- the password rules the API enforces, including the common-password list and a
  password built from the person's name or email;
- `parseOptionalMinimum` keeping "not configured" as `null` and a real `0` as `0`;
- `signInSchema`, `registerSchema` and `stockSettingsSchema` edge cases;
- the six-box code field: typing advances, a pasted code fills all six and
  completes, backspace moves back, non-digits are ignored, disabled/invalid state;
- the strength indicator's message for weak, strong and name-based passwords;
- the guard: unauthenticated redirect with `?next=`, Owner setup redirect, the
  onboarding route itself, and invited staff not being routed into the wizard;
- the sign-in form: correct payload, `?next=` honoured, open-redirect attempts
  ignored, `423 ACCOUNT_LOCKED` wording, field errors placed on the field, network
  failure message, client-side validation blocking the request.

New backend tests cover phone normalisation, password assessment, keyed hashing,
code verification, session rotation and reuse detection, rate-limit windows, the
onboarding summary, and the checklist.

### Not verified

- No browser walk-through and no end-to-end test against a running API and
  database. The brief asked not to restart the app, so verification stops at type
  checks, unit tests and production builds.
- No real email delivery: `EMAIL_TRANSPORT=log`, so codes and links were observed
  in the API log and in the test doubles.
- No load or concurrency test on session rotation.

## Decisions made during implementation

These were needed to keep the flow honest; each is small and reversible.

1. **`phoneVerifiedAt` stays `null`.** Only email receives a code, so the phone
   number is a sign-in identifier. Claiming it is verified would be false.
2. **`nextPath` is `/onboarding/pharmacy-setup` for Owners only.** Staff who join
   mid-setup go to the dashboard, and `AuthGuard` applies the same rule, so nobody
   is sent to a wizard they cannot save.
3. **`AllExceptionsFilter` forwards `field`, `details`, `retryAfterSeconds`.** The
   UI needs them for "4 attempts left", the resend countdown and field-level errors.
4. **The phone rule in the web app now matches the API.** It previously rejected
   the bare `803…` form that the API accepts.
5. **The password strength indicator no longer asks for a symbol the password
   already contains.** Both repos hold the same rule set.
6. **A saved onboarding step counts as a finished checklist item**, even when the
   optional stock fields are blank. Otherwise two required items could never be
   ticked and the checklist would never disappear.
7. **`/login` redirects to `/sign-in`.** The old page and its test were replaced,
   not kept beside the new one.
8. **Terms and privacy are plain text**, not links to pages that do not exist.
9. **The "save and finish later" link was removed** from the wizard: the guard
   would immediately bounce it back.

## Outstanding decisions requiring approval

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Apply the schema migration (name above) and baseline existing databases | Baseline + one migration, reviewed by whoever owns backups |
| 2 | Swagger / OpenAPI UI: add `@nestjs/swagger` and decorate ~25 routes, or keep markdown contracts | Keep markdown until an external integrator needs the spec |
| 3 | Shared rate-limit store | Stay in-process for one instance; move to Redis before a second replica |
| 4 | SMS transport for phone verification and phone reset | Not now; document that email is the only channel (already stated in the UI copy and the docs) |
| 5 | Cleanup of abandoned `PendingRegistration` rows | Add a daily delete of unverified rows older than 7 days |
| 6 | Sign-in auditing | Not audited today; the session table records IP, user agent and last use |
| 7 | Device/session management screen | Out of scope for the MVP; `signOutAll` already exists |

Items 1 and 3 also appear in `OPEN_PRODUCT_DECISIONS.md`, which is the longer-lived
record.

## Observed issues outside this change

- `npx jest` in the API prints "A worker process has failed to exit gracefully".
  The suite still passes; the cause is a timer in the notification scheduler from
  the previous feature. Calling `unref()` on that interval removes the warning.
- `next lint` prints a deprecation notice (Next.js 16 removes it) and a "Next.js
  plugin was not detected" note. Both are pre-existing configuration observations,
  not failures.

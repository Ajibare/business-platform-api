# Pharmacy Onboarding

An Owner who registers lands in `/onboarding/pharmacy-setup` until the two
required steps are saved and setup is completed. Invited staff never see the
wizard.

## The four steps

| Step | Key | Required | What it writes |
| --- | --- | --- | --- |
| 1 | `pharmacy-profile` | yes | `Organization.name`, `outletProfile`, `address`, `timezone` |
| 2 | `stock-settings` | yes | `Organization.nearExpiryWarningDays`, `defaultUnit`, `defaultMinStockLevel` |
| 3 | `invite-staff` | no | Nothing but the progress marker; invitations go through `/invitations` |
| 4 | `add-stock` | no | The progress marker, plus sample products when the choice is `SAMPLE` |

Step definitions live in `onboarding-summary.ts` (`ONBOARDING_STEPS`); the wizard
and the dashboard both read from there rather than duplicating the list.

## Endpoints

| Method | Path | Role | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/onboarding` | any member | Overview: organisation, derived progress, counts, the inventory notice |
| `PATCH` | `/api/v1/onboarding/steps/1` | OWNER | Save the pharmacy profile |
| `PATCH` | `/api/v1/onboarding/steps/2` | OWNER | Save the stock settings |
| `PATCH` | `/api/v1/onboarding/steps/3` | OWNER | Mark the invite step seen or skipped |
| `PATCH` | `/api/v1/onboarding/steps/4` | OWNER | Mark the stock step and record the chosen option |
| `POST` | `/api/v1/onboarding/sample-data` | OWNER | Seed the sample products explicitly |
| `POST` | `/api/v1/onboarding/complete` | OWNER | Complete setup; refuses if steps 1 or 2 are missing |

Each save returns the same overview as `GET`, so the wizard never needs a second
round trip to refresh its progress.

`GET /onboarding` is readable by every member because the dashboard uses it for
counts. The writes are `OWNER` only: a Manager cannot rename the pharmacy or
change the expiry window.

## Step 1 — pharmacy profile

```json
{
  "name": "Ada Pharmacy",
  "outletProfile": "Community pharmacy",
  "address": "12 Market Road, Ikeja",
  "timezone": "Africa/Lagos"
}
```

`outletProfile` must be one of `Community pharmacy`, `Hospital pharmacy`,
`Chain outlet`, `Wholesale distributor`, `Other`. `timezone` is validated with
`Intl.DateTimeFormat`; an unknown identifier returns `400 INVALID_TIMEZONE` with
`field: "timezone"`. When omitted it defaults to `Africa/Lagos`, never to the
browser's zone.

## Step 2 — stock settings

```json
{ "nearExpiryWarningDays": 90, "defaultUnit": "tablet", "defaultMinStockLevel": 20 }
```

- `nearExpiryWarningDays` is an integer 1–365. It drives the "expiring soon"
  window on the batch list, the expiry report and the reminder scan.
- `defaultUnit` is optional and free text (max 24).
- `defaultMinStockLevel` is optional and **must stay `null` when unset**.
  A minimum of zero is a real value that disables low-stock warnings, so the API
  never turns "not configured" into `0`. The web app keeps the field blank and
  sends `null`; `parseOptionalMinimum('')` returns `null`, and only an explicit
  `0` is sent as `0`.

## Step 3 — invite staff

The wizard embeds `StaffInvitePanel`, which calls `POST /invitations` directly.
The step itself is "seen or skipped":

- pressing Continue, or Skip, calls `PATCH /onboarding/steps/3`;
- invitations already sent are listed with their status and a revoke action;
- a Manager may not invite a Manager (see `assertCanInvite`).

Skipping is legitimate: the panel keeps working later from the checklist.

## Step 4 — add stock

Four options, exactly as the brief describes:

| Choice | What happens | Where the wizard sends you next |
| --- | --- | --- |
| `IMPORT` | Nothing yet; step marked complete | `/products/pharmacy/import` |
| `MANUAL` | Nothing yet; step marked complete | `/products/pharmacy` |
| `SAMPLE` | Three sample products seeded, `isSample = true` | `/dashboard` |
| `EMPTY` | Nothing; step marked complete | `/dashboard` |

Imported or recorded quantities are system-recorded balances, not verified
counts. That sentence is part of the response as `inventoryNotice` and is
rendered verbatim on the step, so the wording has one home:

```ts
export const INVENTORY_NOTICE =
  'Imported or recorded quantities are system-recorded balances. They have not been physically verified.';
```

Sample products (Paracetamol 500 mg tablets, Amoxicillin 250 mg capsules, oral
rehydration salts) use the workspace `defaultUnit` when set, carry a reorder
threshold, and are marked `isSample` so the UI can label them. Seeding is
idempotent: if any sample row already exists, nothing is inserted.

"Skip for now" on step 4 calls `POST /onboarding/complete` without marking the
step, which leaves "Add your first products" on the dashboard checklist.

## Completion

`POST /onboarding/complete`:

1. If step 1 or step 2 is missing → `400 ONBOARDING_INCOMPLETE` with
   `details.missingSteps`.
2. Sets `OnboardingProgress.status = COMPLETED`, `completedAt`, and
   `Organization.onboardingCompletedAt`.
3. Audits `ONBOARDING_COMPLETED`.
4. Returns `{ completed: true, nextPath: "/dashboard", onboarding: <summary> }`.

The wizard then shows **"Your pharmacy is set up."** with one primary action
("Go to dashboard") and calls `refreshProfile()` so the guard stops redirecting.
Saving a step after completion does not reopen setup: `markStepComplete` keeps
`status = COMPLETED` when it is already set.

## Resume

`OnboardingProgress` stores `currentStep` and `completedSteps` (JSON array).
On load the wizard asks `GET /onboarding` and resumes at
`progress.firstIncompleteStep`, so closing the tab never loses a position.

## The dashboard checklist

After completion, if any task is still open, the dashboard shows a checklist that
disappears on its own once everything is done:

| Item | Done when | Optional |
| --- | --- | --- |
| Confirm your pharmacy profile | step 1 saved, or `outletProfile` set | no |
| Set your near-expiry warning window | step 2 saved, or a default unit/minimum exists | no |
| Invite your team | more than one active member | yes |
| Add your first products | at least one active product | yes |

`allTasksDone` is `true` only when all four are done; `requiresSetup` is `true`
while the status is not `COMPLETED`. Both are computed in one place
(`buildOnboardingSummary`) and used by `/auth/me`, `/onboarding`, and the web
app's guard and checklist.

## Frontend routes and components

| Path | File |
| --- | --- |
| `/onboarding/pharmacy-setup` | `src/app/onboarding/pharmacy-setup/page.tsx` |
| route guard (session, but setup may be incomplete) | `src/app/onboarding/layout.tsx` |
| wizard state machine | `src/features/onboarding/pharmacy-setup-wizard.tsx` |
| step 1 form | `src/features/onboarding/pharmacy-profile-step.tsx` |
| step 2 form | `src/features/onboarding/stock-settings-step.tsx` |
| step 3 panel | `src/features/onboarding/staff-invite-panel.tsx` |
| step 4 choices | `src/features/onboarding/stock-start-step.tsx` |
| dashboard checklist | `src/features/onboarding/setup-checklist.tsx` |
| shell + progress + step header + select | `src/components/onboarding/*` |

The wizard shows an explicit "you already finished" card when the status is
`COMPLETED`, and an explanation card instead of a form when the signed-in member
is not the Owner.

## Edge cases

| Situation | Behaviour |
| --- | --- |
| Staff signs in while setup is incomplete | `nextPath` is `/dashboard`; the guard only sends Owners to the wizard |
| A step is saved twice | `completedSteps` is de-duplicated and re-sorted; no duplicate entries |
| Owner closes the browser mid-step | Unsaved fields are lost; the step is not marked complete |
| Two tabs save different steps | Each save re-reads `completedSteps`, adds its own, and writes the union |
| Time zone omitted | `Africa/Lagos` |
| Minimum stock level blank | `null`, never `0` |
| Setup completed, then a required field cleared | Status stays `COMPLETED`; the checklist item still reflects the saved step |

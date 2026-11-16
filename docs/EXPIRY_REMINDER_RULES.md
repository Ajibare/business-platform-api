# Expiry Reminder Rules

These rules decide when an expiry reminder is created for a batch. They are pure functions in `src/modules/platform/notifications/notification-rules.ts` plus the organisation loop in `expiry-reminders.service.ts`.

## Summary

- The first reminder is created when a batch is inside the configured lead time (default 90 days before expiry).
- Reminders repeat every configured interval (default 7 days) until the batch expires.
- Reminders stop when the batch balance reaches zero, when the batch is expired, or when the organisation has reminders disabled.
- At most one reminder exists per batch per reminder window, enforced by a database unique constraint.
- The window grid is anchored to the batch expiry date, not to the day the scan happens to run, so a late or repeated scan cannot create a duplicate.
- Dates are evaluated in the workspace timezone (`Organization.timezone`, default `Africa/Lagos`).

## Inputs

| Input | Source | Default |
| --- | --- | --- |
| `expiryDate` | `Batch.expiryDate` | none; batches without an expiry date are skipped |
| quantity | `BatchBalance.quantity` (recorded balance) | skipped when `<= 0` |
| lead time | `NotificationPreference.reminderLeadDays` | 90 |
| interval | `NotificationPreference.reminderIntervalDays` | 7 |
| switches | `expiryRemindersEnabled`, `inAppEnabled`, `emailEnabled` | reminders on, in-app on, email off |
| timezone | `Organization.timezone` | `Africa/Lagos` |

Quantity is the recorded balance, not a physical count. A batch with a stale balance can therefore still produce a reminder; the message says "recorded quantity" for that reason.

## Algorithm

```text
todayKey      = local date of now in the workspace timezone        (YYYY-MM-DD)
expiryKey     = calendar date of the batch expiry date             (YYYY-MM-DD)
daysRemaining = expiryKey - todayKey                               (in days)

if daysRemaining < 0                 -> no reminder (expired stock workflow)
if daysRemaining > leadDays          -> no reminder (outside the window)

elapsed          = leadDays - daysRemaining
windowIndex      = floor(elapsed / intervalDays)
windowStartOffset = leadDays - windowIndex * intervalDays
periodStartKey   = expiryKey - windowStartOffset days

dedupeKey        = "expiry-reminder:<batchId>:<periodStartKey>"
```

`periodStartKey` is the calendar date on which the current window opened. Because it is derived from the expiry date, every scan of the same batch inside the same window computes the same key.

### Window table (lead 90, interval 7)

| Window | Days remaining | Window opens on | `dedupeKey` suffix |
| --- | --- | --- | --- |
| 0 | 84–90 | expiry − 90 | `...:2026-10-03` (for a 2027-01-01 batch) |
| 1 | 77–83 | expiry − 83 | `...:2026-10-10` |
| 2 | 70–76 | expiry − 76 | `...:2026-10-17` |
| … | … | … | … |
| 11 | 7–13 | expiry − 13 | `...:2026-12-19` |
| 12 | 0–6 | expiry − 6 | `...:2026-12-26` |

With the defaults there are 13 windows per batch: the first opens at 90 days remaining and the last at 6 days remaining, so a batch still gets a reminder in its final week.

### Worked example

Batch `PC2451` expires on `2027-01-01`, today is `2026-11-16` in `Africa/Lagos`.

```text
daysRemaining      = 46
elapsed            = 90 - 46 = 44
windowIndex        = floor(44 / 7) = 6
windowStartOffset  = 90 - (6 * 7) = 48
periodStartKey     = 2027-01-01 - 48 days = 2026-11-14
dedupeKey          = "expiry-reminder:<batchId>:2026-11-14"
```

The next reminder for this batch opens when 41 days remain (`2026-11-21`), because window 7 starts at `expiry − 41`. Any scan between now and then is reported as `alreadyNotified`.

## What is skipped

| Condition | Reason | Scan counter |
| --- | --- | --- |
| `expiryDate` is null | No expiry anchor, cannot schedule | not counted |
| Balance `<= 0` | Depleted, written off or returned quantities need no reminder | counted in `batchesScanned` |
| `daysRemaining < 0` | Expired batches belong to the expired-stock workflow (`/pharmacy/expiry/expired`), not to approaching-expiry reminders | counted |
| `daysRemaining > leadDays` | Outside the reminder window | counted |
| `expiryRemindersEnabled` is false, or both `inAppEnabled` and `emailEnabled` are false | Organisation opted out, or has no delivery channel | organisation skipped |
| A notification with the same `dedupeKey` exists | One reminder per batch per window | `alreadyNotified` |
| Concurrent insert of the same key | Unique constraint `(organizationId, dedupeKey)` raises `P2002`, treated as already notified | `alreadyNotified` |

Depleted, written-off and returned stock all end with a zero or negative balance, which is why a single `quantity <= 0` check covers all three cases.

## Multiple batches per product

Reminders are created per batch. A product with three batches inside the window produces three reminders with three different dedupe keys, and the feed shows them separately with batch number and expiry date. Nothing is aggregated per product, because acting on a reminder (dispose, return, sell through) happens per batch.

## Severity and copy

Severity is `danger` when 30 days or fewer remain and `warning` otherwise.

Title: `<Product name> expires in N day(s)`, or `<Product name> expires today` at zero days.

Body: product name, batch number (or "an unnumbered batch"), expiry date formatted `DD Mon YYYY` in UTC, days remaining, recorded quantity with unit, an action prompt, and the workspace timezone.

Example:

```text
Paracetamol 500mg Tablet (batch PC2451) expires on 01 Jan 2027, in 46 day(s).
Recorded quantity: 240 tablet. Review disposal, return or sell-through options.
Times are shown for Africa/Lagos.
```

Expiry dates are stored as UTC midnight calendar dates and formatted with `timeZone: 'UTC'` so the printed date never shifts by a day for users east or west of UTC.

## Changing the schedule

Both settings are editable per workspace (OWNER, MANAGER). The API accepts `reminderLeadDays` 1–365 and `reminderIntervalDays` 1–30.

Changing either value changes the window grid. A batch may therefore receive one reminder under the new grid even if a reminder under the old grid was already sent: the dedupe key contains the current window start, not a count of reminders ever sent. This is deliberate - a configuration change is an explicit action, and dedupe still guarantees at most one reminder per batch per window for the active configuration. Existing notifications are never edited or deleted by a settings change.

## Scheduling and idempotency

- Scheduled: `NotificationScheduler` runs the scan for all organisations every `NOTIFICATION_SCAN_INTERVAL_MINUTES` (default 60) after `NOTIFICATION_SCAN_INITIAL_DELAY_SECONDS` (default 20). Disabled in tests and when the interval is `0`.
- Manual: `POST /api/v1/notifications/expiry-scan` (OWNER, MANAGER) scans only the caller's organisation and writes an `EXPIRY_REMINDER_SCAN` audit entry.
- Both paths call the same service, so they cannot disagree about a batch.

Scan summary fields: `organizationsScanned`, `batchesScanned`, `remindersCreated`, `emailsQueued`, `emailsSent`, `emailsFailed`, `alreadyNotified`.

## Verification

```bash
# Rules and date helpers
npx jest src/modules/platform/notifications/notification-rules.spec.ts
npx jest src/common/utils/time.spec.ts
```

`notification-rules.spec.ts` covers window membership at the boundaries (lead time, interval edges, expiry day, one day after expiry), dedupe key stability across scans, and message copy.

Manual end-to-end check:

1. Create a batch expiring in about 45 days with a non-zero balance.
2. Run `POST /api/v1/notifications/expiry-scan`; expect `remindersCreated: 1`.
3. Run it again; expect `remindersCreated: 0` and `alreadyNotified: 1`.
4. Clear the balance to zero and run again; the batch should no longer be scanned into a new reminder.

## Related documentation

- `NOTIFICATION_SYSTEM.md` for preferences, recipients and delivery.
- `DASHBOARD_METRICS.md` for the expiry views that share the same day-difference helpers.

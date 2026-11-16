# Notification System

Expiry reminders are the only notification type the platform produces today. Everything else (recipients, preferences, delivery history, retry) exists to make those reminders configurable per pharmacy workspace and to keep a durable record of what was sent.

Sales notifications are intentionally disabled: no sales module exists yet, so there is no event to notify about. See "Sales notifications" below.

## Data model

| Model | Purpose |
| --- | --- |
| `NotificationPreference` | One row per organisation. Switches, lead time and reminder interval. Created on first read with defaults. |
| `NotificationRecipient` | Email recipients for a workspace, filtered by `receivesExpiry` / `receivesSales`. Deactivated rather than deleted. |
| `Notification` | The reminder itself (`type`, `title`, `body`, `severity`, optional `productId` / `batchId`, `metadata`, `dedupeKey`). Unique on `(organizationId, dedupeKey)`. |
| `NotificationRead` | Per-user read state, unique on `(notificationId, userId)`. Read state is per user, not per workspace. |
| `NotificationDelivery` | One row per recipient per notification (`PENDING` / `SENT` / `FAILED`, `attempts`, `lastError`, `nextAttemptAt`). |

`Notification.metadata` stores the values used to compose the message (batch number, expiry date, days remaining, quantity, unit, lead time, interval, timezone) so a reminder remains self-describing after preferences change.

## Preferences

Defaults are created on first access (`upsert` with an empty update):

| Field | Default | API range |
| --- | --- | --- |
| `inAppEnabled` | `true` | boolean |
| `emailEnabled` | `false` | boolean |
| `expiryRemindersEnabled` | `true` | boolean |
| `saleNotificationsEnabled` | `false` | boolean (stored, not used while sales are unavailable) |
| `reminderLeadDays` | `90` | 1–365 |
| `reminderIntervalDays` | `7` | 1–30 |

Email is off by default because no provider is configured in a fresh environment. Turning it on without a transport still records deliveries; with the `log` transport the message is written to the application log instead of being delivered.

Preference changes take effect on the next scheduled scan or on the next manual scan. Changing `reminderLeadDays` re-anchors future reminder windows; it does not delete reminders already created.

## Endpoints

All endpoints require a bearer token and are scoped to the caller's organisation (`/api/v1` prefix).

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/notifications` | any member | Query: `limit` (1–100, default 50), `unreadOnly=true`. Returns `{ data, meta: { total, unread, inAppEnabled } }`. Returns an empty list when in-app notifications are disabled. |
| `GET` | `/notifications/unread-count` | any member | `{ data: { unread, inAppEnabled } }`. Polled by the header bell. |
| `GET` | `/notifications/capabilities` | any member | `{ inAppNotifications, emailNotifications, expiryReminders, salesNotificationsAvailable: false, emailTransport }`. |
| `GET` | `/notifications/preferences` | any member | Current preferences (creates defaults on first call). |
| `PATCH` | `/notifications/preferences` | OWNER, MANAGER | Partial update. Audited as `NOTIFICATION_PREFERENCES_UPDATED`. |
| `GET` | `/notifications/recipients` | any member | Active and inactive recipients. |
| `POST` | `/notifications/recipients` | OWNER, MANAGER | `email` required; duplicate email in the same workspace returns `DUPLICATE_REQUEST`. |
| `PATCH` | `/notifications/recipients/:id` | OWNER, MANAGER | Update email, name, `receivesExpiry`, `receivesSales`, `active`. |
| `DELETE` | `/notifications/recipients/:id` | OWNER, MANAGER | Soft delete: sets `active: false`. |
| `GET` | `/notifications/deliveries` | OWNER, MANAGER | Query: `status`, `limit` (1–200, default 50). Returns `{ data, meta: { maxAttempts, transport } }`. |
| `POST` | `/notifications/deliveries/:id/retry` | OWNER, MANAGER | Re-sends one delivery. Returns `VALIDATION_ERROR` when it was already sent. |
| `POST` | `/notifications/read-all` | any member | Marks every unread notification read for the caller. |
| `POST` | `/notifications/:id/read` | any member | Idempotent per user. |
| `POST` | `/notifications/expiry-scan` | OWNER, MANAGER | Runs the scan for the caller's workspace and returns the scan summary. Audited as `EXPIRY_REMINDER_SCAN`. |

## Read state

Read state is stored per user in `NotificationRead`. `unread-count` and the `unread` meta value count notifications with no read row for the calling user, so two staff members can have different unread counts for the same reminder.

When `inAppEnabled` is false the feed endpoints return an empty result and the bell hides itself rather than showing a stale badge.

## Email delivery pipeline

1. The scan creates a `Notification` and, when `emailEnabled` is true and at least one active recipient exists, queues a `NotificationDelivery` per recipient (`createMany` with `skipDuplicates`).
2. Pending deliveries for that notification are attempted immediately (`sendPendingForNotification`, up to 25 per call).
3. The scheduler retries due deliveries (`processDueDeliveries`, 20 per tick) for any notification.
4. A failed attempt increments `attempts`, stores `lastError` (truncated to 500 characters) and sets `nextAttemptAt`.

Backoff is exponential: 5, 10, 20, 40 then 60 minutes, capped at 60 minutes and at `EMAIL_MAX_ATTEMPTS` attempts (default 5). When attempts are exhausted the delivery stays `FAILED` with `nextAttemptAt: null` and can only be retried manually from the notification settings page.

### Transports

`EMAIL_TRANSPORT=log` (default) writes the recipient, sender and subject to the application log and marks the delivery `SENT`. It is intended for local development and for deployments without a provider, and the UI shows a warning when it is active.

`EMAIL_TRANSPORT=http` posts JSON to `EMAIL_HTTP_URL`:

```json
{ "from": "Pharmacy Stock Intelligence <notifications@example.com>", "to": "owner@example.com", "subject": "...", "text": "..." }
```

with `Authorization: Bearer $EMAIL_HTTP_API_KEY`. Non-2xx responses fail the attempt and record the status and body excerpt. Credentials are read from the environment only; nothing is stored in source.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOTIFICATION_SCAN_INTERVAL_MINUTES` | `60` | Scheduler interval. `0` disables the scheduler (for an external runner). |
| `NOTIFICATION_SCAN_INITIAL_DELAY_SECONDS` | `20` | Delay before the first scheduled run after boot. |
| `EMAIL_TRANSPORT` | `log` | `log` or `http`. |
| `EMAIL_FROM` | `notifications@pharmacy.local` | Sender address. |
| `EMAIL_HTTP_URL` | empty | Provider endpoint for the `http` transport. |
| `EMAIL_HTTP_API_KEY` | empty | Bearer token for the provider endpoint. |
| `EMAIL_MAX_ATTEMPTS` | `5` | Attempt cap per delivery. |

## Scheduler

`NotificationScheduler` runs inside the API process. Each tick runs the expiry scan for every organisation and then processes due deliveries. It is disabled when `NODE_ENV=test` and when the interval is `0`.

The timer does not hold the process open (`unref`), guards against overlapping ticks with an in-process flag, and logs failures without crashing the process. Running multiple API instances is safe because reminders are deduplicated by `(organizationId, dedupeKey)` in the database and delivery rows are unique per notification and recipient; at worst two instances attempt the same delivery, and the row-level status reflects the last outcome. For larger deployments, set the interval to `0` and trigger `POST /notifications/expiry-scan` (or a scheduled job outside the API) from a single runner.

## Audit trail

Notification-related audit actions: `NOTIFICATION_PREFERENCES_UPDATED`, `NOTIFICATION_RECIPIENT_ADDED`, `NOTIFICATION_RECIPIENT_UPDATED`, `NOTIFICATION_RECIPIENT_REMOVED`, `EXPIRY_REMINDER_SCAN`. Scheduled scans are not audited per organisation to avoid writing an audit row every hour; they are logged instead.

## Sales notifications

`capabilities.salesNotificationsAvailable` is `false` and `saleNotificationsEnabled` is stored but unused. Enabling sale notifications requires, at minimum:

1. A confirmed sales transaction entity (distinct from `StockMovement`), with product, batch, quantity, unit price charged, timestamp and actor.
2. A publish point after the transaction is committed.
3. A recipient filter (`receivesSales`) and a dedupe key per transaction.

Creating an event from `ISSUE` movements or from the import pipeline would fabricate sales data, so it is deliberately not implemented.

## Verifying locally

```bash
# 1. Preferences and recipients
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/notifications/preferences

# 2. Run a scan and inspect the summary
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/notifications/expiry-scan

# 3. Feed, unread count, deliveries
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3001/api/v1/notifications?limit=20"
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/notifications/unread-count
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/notifications/deliveries
```

The scan summary reports `organizationsScanned`, `batchesScanned`, `remindersCreated`, `emailsQueued`, `emailsSent`, `emailsFailed` and `alreadyNotified`. A second identical run should report `remindersCreated: 0` and `alreadyNotified` equal to the number of batches still inside the current window.

## Related documentation

- `EXPIRY_REMINDER_RULES.md` for the window and deduplication algorithm.
- `OPEN_PRODUCT_DECISIONS.md` for the sales module decision.
- `../business-platform-web/docs/API_INTEGRATION_NOTES.md` for the frontend integration.

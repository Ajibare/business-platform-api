# Open Product Decisions

Items in this document need a product owner decision. Until each is decided, the implementation keeps the conservative behaviour described in "Current behaviour" rather than guessing.

| # | Decision | Blocking | Status |
| --- | --- | --- | --- |
| 1 | Sales module and transaction entity | Sales metrics, sales notifications, sale action after a scan | Open, blocking |
| 2 | Profit / gain definition | Gain card | Open, blocking |
| 3 | Commission rules | Commission card | Open, blocking |
| 4 | XLSX import support | Bulk import convenience | Open, not blocking |
| 5 | Persistent barcode scan history | Audit of scans | Open, not blocking |
| 6 | Prisma migration baseline | Deployment | Open, blocking for release |
| 7 | Email provider and sender domain | Real email delivery | Open, blocking for email |
| 8 | Scheduler execution model at scale | Reliable reminders at >1 instance | Open, not blocking for single instance |
| 9 | Notification retention | Database growth | Open, not blocking |
| 10 | Duplicate barcode resolution and uniqueness scope | Barcode cleanup | Open, not blocking |
| 11 | Import create-vs-update behaviour | Catalogue maintenance | Open, not blocking |
| 12 | Multi-currency and per-branch scope | Reporting | Open, not blocking |
| 13 | Swagger / OpenAPI document | External integrators | Open, not blocking |
| 14 | Shared rate-limit store | Horizontal scaling | Open, blocking for >1 API replica |
| 15 | Abandoned registration retention | Database growth | Open, not blocking |
| 16 | Phone verification and phone password reset | Phone sign-in is unverified | Open, not blocking |

## 1. Sales module and transaction entity

**Question:** Do we build a sales module, and what does a sale record?

**Current behaviour:** There is no sales entity. `ISSUE` movements record stock leaving the shelf but are explicitly not sales. `/pharmacy/reports/daily` returns `sales.available: false`, `/notifications/capabilities` returns `salesNotificationsAvailable: false`, and the scan result offers no sale action.

**Options:**

- A. Minimal `Sale` + `SaleLine` (quantity, unit price charged, cashier, status) confirmed together with the stock issue.
- B. Full point-of-sale with payments, discounts, customers and returns.
- C. Keep stock-only and integrate with an external POS later.

**Recommendation:** A, scoped to what the dashboard needs, with the same organisation scoping, audit and idempotency as movements. B is a product in itself; C leaves the dashboard permanently incomplete.

**Needed to close:** Entities, statuses, confirmation flow, whether a sale can be voided and how stock is reversed, and which roles may sell.

## 2. Profit / gain definition

**Question:** Which profit figure does the dashboard show?

**Current behaviour:** `gain.available: false` with a reason. No profit is calculated.

**Options:**

- Gross profit per line using a cost snapshot at sale time.
- Gross profit using the current weighted average cost.
- Net profit including operating costs and commissions.

**Recommendation:** Gross profit with a per-line cost snapshot, labelled "Gross profit". Net profit needs an operating-cost model that does not exist and would otherwise be a guess.

**Needed to close:** Cost basis (batch cost, weighted average, or FIFO/FEFO consumption), treatment of returns, discounts and expired stock, and the label shown to users.

## 3. Commission rules

**Question:** Who earns commission, on what basis, and how are reversals handled?

**Current behaviour:** `commission.available: false`. The preferences model stores `receivesSales` and `saleNotificationsEnabled` but nothing is computed.

**Options:**

- Fixed amount per transaction.
- Percentage of line value or of gross profit.
- Tiered targets per staff member.

**Recommendation:** A commission ledger (append-only entries) driven by an explicit rule record, so historic payouts do not change when a rule is edited. Do not compute commission from batch prices.

**Needed to close:** Earner identity, base (revenue vs profit), rate, per-product exceptions, and refund/void behaviour.

## 4. XLSX import support

**Question:** Should users upload `.xlsx` directly?

**Current behaviour:** CSV only. The API rejects other extensions with a message telling the user to save as CSV. Templates are CSV with `#` instruction lines.

**Options:**

- A. Keep CSV; the template instructions already say "save as CSV".
- B. Add server-side XLSX parsing behind a feature flag.
- C. Client-side conversion in the browser before upload.

**Recommendation:** A until uploads show that CSV is the actual blocker. B adds a dependency and a second parsing path to maintain; C fails on large files and in locked-down browsers.

## 5. Persistent barcode scan history

**Question:** Do we store every scan?

**Current behaviour:** `ProductScanHistory` keeps the last five codes in memory for the current visit only. Scans that change stock are recorded as movements with an actor and idempotency key.

**Options:**

- A. Keep session-only.
- B. Record scans that fail lookup ("unknown barcode" demand signal).
- C. Record all scans with a retention window.

**Recommendation:** B first if the business wants to know which products staff scan but cannot find. C needs a retention policy and a privacy review before it is worth the storage.

## 6. Prisma migration baseline

**Question:** How is the schema change delivered to existing databases?

**Current behaviour:** `prisma/schema.prisma` contains the new models and columns, but `prisma/migrations/` does not exist in this repository. The change has not been applied to any database from here.

New or changed schema:

- `Product.barcode` (nullable) with `@@unique([organizationId, barcode])` and `@@index([organizationId, barcode])`.
- `NotificationPreference`, `NotificationRecipient`, `Notification` (unique `organizationId + dedupeKey`), `NotificationRead`, `NotificationDelivery`.
- `AuditLog`.
- `ImportJob`, `ImportJobRow`.

**Action required before release:** run the following against the target database from `business-platform-api`:

```bash
npx prisma migrate dev --name notifications_barcodes_imports
npx prisma generate
```

For an existing production database without a migration history, create a baseline migration first (`prisma migrate diff` against the current database, committed as the initial migration) and then apply this change on top. Do not use `db push` on production data.

**Recommendation:** Baseline + one migration, reviewed by whoever owns the database backups.

## 7. Email provider and sender domain

**Question:** Which provider sends notification email, and from which address?

**Current behaviour:** `EMAIL_TRANSPORT=log` by default: attempts are recorded and the message is logged, not delivered. The settings page warns when the log transport is active. `EMAIL_FROM` defaults to `notifications@pharmacy.local`.

**Options:** An HTTP provider (the `http` transport expects a JSON endpoint with a bearer key), a transactional provider SDK, or SMTP via a relay that exposes an HTTP endpoint.

**Recommendation:** Keep the `http` transport and point `EMAIL_HTTP_URL` at the chosen provider's send endpoint. Configure SPF/DKIM for the sending domain before switching the transport on, otherwise reminders land in spam.

## 8. Scheduler execution model at scale

**Question:** Who runs the hourly scan in production?

**Current behaviour:** An in-process timer in each API instance, interval `NOTIFICATION_SCAN_INTERVAL_MINUTES` (default 60), disabled with `0`. Dedupe makes multiple instances safe, but they still duplicate work.

**Options:**

- A. Leave it in-process for a single instance.
- B. Set the interval to `0` and drive `POST /notifications/expiry-scan` from one external scheduler.
- C. Move the scan into a queue/worker.

**Recommendation:** B as soon as there is more than one API instance. C only when scan volume justifies the infrastructure; no queue exists today and adding Redis for one hourly job is not justified.

## 9. Notification retention

**Question:** How long do notifications and delivery rows live?

**Current behaviour:** Nothing is deleted. The feed is capped by `limit` (max 100), not by age.

**Options:** Keep everything; archive read notifications older than N months; delete read notifications older than N months.

**Recommendation:** Archive or delete read notifications and their deliveries after 12 months, once the audit requirements are confirmed. Delivery rows are the record of what was emailed, so they need the same policy.

## 10. Duplicate barcode resolution and uniqueness scope

**Question:** What happens when two products legitimately share a barcode (for example different pack sizes of the same SKU)?

**Current behaviour:** Barcodes are unique per organisation. Assigning a barcode already in use returns `DUPLICATE_REQUEST` naming the current owner. The user must clear the other product first.

**Options:**

- A. Keep strictly unique per product.
- B. Allow duplicates and return a disambiguation list from lookup.
- C. Model barcodes as a separate table with many-to-one product mapping.

**Recommendation:** A while the catalogue is small; C if multi-pack products become common. B silently weakens the "scan once, act" flow.

## 11. Import create-vs-update behaviour

**Question:** Should imports update existing records?

**Current behaviour:** Imports create only. Existing product names and batch keys are reported as duplicates and excluded. Catalogue edits happen through the product screens.

**Options:** Add an `UPDATE` mode per import type, or a separate "prices and thresholds" sheet.

**Recommendation:** Start with a dedicated price/reorder-threshold update sheet rather than a general upsert mode; upserts need field-level conflict rules and an audit story for overwritten values.

## 12. Multi-currency and per-branch scope

**Question:** Is `Organization.currency` (default `NGN`) and one timezone per workspace enough?

**Current behaviour:** Amounts are formatted with the organisation currency; the reminder schedule and daily metrics use one timezone per organisation.

**Options:** Per-branch currency/timezone, or per-user display timezone with the organisation timezone kept as the reporting basis.

**Recommendation:** Keep one reporting timezone per organisation; add per-branch configuration only when a multi-branch workspace exists. Daily metrics must not mix timezones, or the same movement can count twice or not at all.

## 13. Swagger / OpenAPI document

**Question:** Do we expose an OpenAPI document, and who consumes it?

**Current behaviour:** `@nestjs/swagger` is not a dependency and no route is decorated. The auth surface is documented in `AUTH_API_CONTRACTS.md`, which the web app's `src/types/auth.ts` mirrors by hand. There is no `/docs` route.

**Options:**

- A. Keep the markdown contracts and the hand-written client types.
- B. Add `@nestjs/swagger`, decorate every route and generate the document.
- C. Generate the document from a separate specification file.

**Recommendation:** A until an external integrator needs the spec. B duplicates knowledge that currently lives in one place and would need decorating ~25 auth routes plus the product routes; the drift risk is lower with one markdown file than with decorators nobody reads.

**Needed to close:** Whether a third party integrates directly against the API.

## 14. Shared rate-limit store

**Question:** Where do credential rate-limit counters live?

**Current behaviour:** `RateLimitService` keeps fixed-window counters in process memory. Every TTL, limit and message is in `auth.constants.ts` and `RateLimitService`; nothing else reads the counters.

**Options:**

- A. Keep in-process memory for a single API instance.
- B. Move the counters to Redis (`REDIS_URL` is already in `.env.example`).
- C. Push the limits to the reverse proxy / CDN.

**Recommendation:** A while there is one replica; B as soon as there are two. C cannot express the per-account lockout, only the per-IP budget. With more than one replica, A silently multiplies every limit by the replica count.

**Needed to close:** The expected number of API instances at launch.

## 15. Abandoned registration retention

**Question:** How long do unfinished registrations stay?

**Current behaviour:** A `PendingRegistration` row is replaced when the same email registers again, and nothing deletes it. Each row holds a bcrypt hash and a code hash for an unverified address.

**Options:** Delete unverified rows older than 7 days on a daily job; keep them until the address registers again; delete on code expiry.

**Recommendation:** A daily delete of `verifiedAt IS NULL AND updatedAt < now() - 7 days`. It bounds the table and removes password hashes for addresses that were never proven to belong to anyone.

**Needed to close:** Whether a scheduler job is acceptable in the API process (the notification scan already is).

## 16. Phone verification and phone password reset

**Question:** Should a phone number be a verified channel, or only a sign-in identifier?

**Current behaviour:** Phone numbers can be used to sign in and can be attached to an invitation, but they are never messaged: `User.phoneVerifiedAt` stays null, password reset links go to email only, and a phone-only invitation fails with `CHANNEL_UNAVAILABLE`.

**Options:**

- A. Keep phone as an identifier only and say so in the UI (current).
- B. Add an SMS provider and a phone verification code, then allow phone reset.
- C. Add WhatsApp or another messaging channel.

**Recommendation:** A until SMS is funded and its delivery is monitored. B without monitoring produces silent failures on the one channel a person may actually check.

**Needed to close:** Provider, sender ID, per-message budget, and whether a phone-only account is allowed to exist.

## Decision log conventions

When a decision is made, append a line with the date, decision, decider and the change it implies. Do not rewrite the question; the history matters when the same topic resurfaces.

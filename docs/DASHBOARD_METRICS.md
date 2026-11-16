# Dashboard Metrics

The pharmacy dashboard shows what the platform can prove and labels what it cannot. Today that means recorded stock issues are shown as numbers, while sales, gain and commission are shown as explicitly unavailable with the reason and the data they would require.

## Endpoint

`GET /api/v1/pharmacy/reports/daily?date=YYYY-MM-DD` (any authenticated member, scoped to the organisation).

`date` is optional. When omitted or malformed, the workspace-local current date is used. Query parameter is validated with `isValidDateKey`; the response always echoes the resolved `date`.

Response:

```json
{
  "data": {
    "date": "2026-11-16",
    "timeZone": "Africa/Lagos",
    "currency": "NGN",
    "recordedStockIssues": { "transactions": 12, "products": 7, "quantity": 84 },
    "sales": {
      "available": false,
      "transactions": null,
      "products": null,
      "amount": null,
      "reason": "Not available: the platform does not record sales transactions, prices charged or revenue. A dedicated sales module is required."
    },
    "gain": {
      "available": false,
      "amount": null,
      "reason": "Not available: gain requires reliable selling price and cost price data for each transaction. Stock movements alone cannot produce gross or net profit."
    },
    "commission": {
      "available": false,
      "amount": null,
      "reason": "Not available: no commission rules are defined (who earns commission, fixed or percentage, per product, transaction or user, and how returns are treated)."
    },
    "definitions": { "...": "..." }
  }
}
```

The `available: false` + `amount: null` + `reason` shape is deliberate: a client cannot render a number for these metrics even by accident, and the reason travels with the payload instead of living only in documentation.

## Metric definitions

| Metric | Definition | Source | Shown as |
| --- | --- | --- | --- |
| Stock issues (transactions) | Number of `ISSUE` stock movements recorded on the local date | `StockMovement` where `type = 'ISSUE'` | Number |
| Products issued | Distinct products with at least one `ISSUE` movement on the date | `StockMovement → Batch.productId` | Number |
| Quantity issued | Sum of the absolute quantity of those movements | `StockMovement.quantityDelta` | Number |
| Sales today | Total value of confirmed sales transactions | No source | "Not available" |
| Transactions (sales) | Count of confirmed sales transactions | No source | "Not available" |
| Gain / profit | Gross profit = selling price − cost price per sale; net profit additionally subtracts costs and commissions | No source | "Not available" |
| Commission | Amount payable under an approved commission rule | No rule defined | "Not available" |

`recordedStockIssues` is named that way on purpose. An `ISSUE` movement means stock left the shelf under a recorded reason; it is not proof of a sale, and it is never converted into revenue.

## Date window and timezone

Daily totals use the workspace calendar day in `Organization.timezone` (default `Africa/Lagos`), converted to a half-open UTC range `[start, end)` with `zonedDayRangeUtc`. This two-pass offset calculation handles zones whose UTC offset changes across the day.

Consequences:

- A movement at 00:30 local time belongs to that local day even if it is the previous UTC day.
- Changing the workspace timezone changes which movements fall into a given date.
- The response includes the exact UTC window in `definitions.dateWindow` so a number can be reproduced.

`currency` comes from `Organization.currency` (default `NGN`) and is used by the UI to format any amount, including the placeholder cards.

## Why sales, gain and commission are unavailable

The platform has no sales module. There is no entity that records a customer, a price actually charged, a discount, a return or a payment. `Batch.sellingPrice` and `Batch.unitCost` are catalogue/stock values, not transaction values:

- Selling price on a batch is what staff intend to charge, not what was charged.
- Cost price on a batch does not account for the specific batch consumed by a FIFO/FEFO rule in every case, freight, or price changes between receipts.
- Treating `ISSUE` movements as sales would count expired stock, damages and internal transfers as revenue.

Deriving profit or commission from these would produce confident-looking but wrong numbers. The API therefore returns `null` with a reason, and the UI renders "—" plus a "Not available" badge rather than zero (zero is a valid value and would be misread as "nothing was sold").

## What would be needed to enable them

### Sales today and transaction counts

1. `Sale` entity: organisation, local date derived from `occurredAt`, cashier, status (`DRAFT`, `CONFIRMED`, `VOIDED`), total amount, currency.
2. `SaleLine` entity: sale, product, batch, quantity, unit price charged, discount, line total. A price snapshot, not a join to the current batch price.
3. A confirmation step that also creates the corresponding `ISSUE` movement (so stock and sales stay consistent), or an explicit rule for when stock is decremented.
4. Aggregation by the same `zonedDayRangeUtc` window, counting only `CONFIRMED` sales.

### Gain / profit

5. Cost snapshot on each sale line (unit cost at the time of sale), because batch cost can change between receipts.
6. A definition decision: gross or net, and whether returns, discounts, damages and expired stock are included.

### Commission

7. An approved commission rule: who earns it, fixed amount or percentage, calculated per line/transaction/staff member, and how refunds reverse it.
8. A ledger of commission entries rather than a computed field, so historic numbers do not change when a rule changes.

Until items 1–8 exist, the dashboard stays honest. See `OPEN_PRODUCT_DECISIONS.md` for the open questions and the recommended order.

## UI behavior

`features/pharmacy/daily-performance.tsx` renders the section on both `/dashboard` and `/products/pharmacy`.

- Date control defaults to today in the user's locale (`toLocaleDateString('en-CA')`) and can be changed; the query key includes the date.
- Three real cards: stock issues, products issued, quantity issued. These are labeled "recorded stock issues" so they are not read as sales.
- Four unavailable cards: sales today, sales transactions, gain / profit, commission. Each shows "—", a "Not available" badge and the API-provided reason as a footnote.
- A `<details>` block lists `definitions` returned by the API, so the definition shown to users is the definition used by the server.
- Loading uses skeleton cards; an error renders an alert with a retry action. No client-side fallback numbers are substituted.

## Verification

```bash
npm run build
npx jest src/common/utils/time.spec.ts
```

Frontend:

```bash
npx tsc --noEmit
npm run lint
npx jest
```

Manual check:

1. Record an `ISSUE` movement of 10 tablets for a batch, then open the dashboard.
2. "Stock issues" should show 1 transaction, 1 product and 10 quantity for today.
3. Sales, gain and commission must all read "Not available" with reasons; no currency value may appear.
4. Change the date to yesterday; only movements in that local day should count.
5. Record a `DAMAGE` movement; stock issues must not change.

## Related documentation

- `API_CONVENTIONS.md` for the response envelope and error codes.
- `NOTIFICATION_SYSTEM.md` for the capability flags that also disable sales notifications.
- `../business-platform-web/docs/API_INTEGRATION_NOTES.md` for the frontend query and formatting rules.

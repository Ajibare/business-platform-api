# Bulk Import System

Bulk import lets a pharmacy load its catalogue, batches and opening quantities from a spreadsheet without typing every row. Validation happens before anything is written, the user reviews the outcome, and imported batches go through the same stock ledger as manual entries.

## Supported import types

| Type | Purpose | Writes |
| --- | --- | --- |
| `PRODUCTS` | Create catalogue products. | `Product` rows. |
| `BATCHES` | Add stock batches to existing products with quantity, cost and expiry. | `Batch` + `OPENING` `StockMovement` + `BatchBalance`. |
| `INITIAL_STOCK` | Load opening quantities during onboarding. Batch number, expiry and prices are optional. | Same as `BATCHES`. |

`BATCHES` and `INITIAL_STOCK` share one validation path; the difference is which fields are required.

## Templates

Templates are CSV files with `#` instruction lines, a blank line, the header row, then two sample rows. The parser ignores blank lines and lines starting with `#`, so an unedited template can be uploaded back for a dry run.

Every template documents required fields, accepted date formats and quantity rules in its instruction block. Deleting the sample rows is listed as a required step.

### Product catalogue columns

| Column | Required | Notes |
| --- | --- | --- |
| Product name | yes | Unique per pharmacy, compared ignoring case and punctuation. |
| Brand | no | |
| Strength | no | |
| Dosage form | no | Tablet, capsule, syrup, injection, cream. |
| Pack size | no | For example `10 x 10`. |
| Unit | yes | Base unit for movements (`tablet`, `bottle`, `sachet`). |
| Barcode | no | Must be unique per pharmacy; 4–64 characters, `A-Z`, `0-9`, `.`, `-`, `_`. |
| Reorder threshold | no | Zero or a positive number. |
| Active | no | `TRUE` / `FALSE`; defaults to `TRUE`. |

### Stock batch columns

| Column | Required | Notes |
| --- | --- | --- |
| Product name | yes | Must match an existing catalogue product. |
| Batch number | yes | |
| Expiry date | yes | Must not be in the past. |
| Quantity | yes | Greater than zero. |
| Unit | no | Defaults to the product unit. |
| Unit cost | no | Naira, numbers only. |
| Selling price | no | Naira, numbers only. Required later before profit can be calculated. |

### Initial stock columns

Product name and quantity are required; batch number, expiry date, unit, unit cost and selling price are optional.

Header matching is flexible: `Product name`, `product_name`, `PRODUCT_NAME`, `product`, `medicine`, `item`, `qty`, `batch_no`, `lot`, `exp_date`, `cost_price`, `sale_price` and similar aliases are all recognised. Extra columns in the file are ignored. When a header is unrecognisable, the UI can map it explicitly per column and re-validate without uploading again.

## Accepted value formats

| Value | Accepted input |
| --- | --- |
| Date | `YYYY-MM-DD`, `YYYY/MM/DD`, `DD/MM/YYYY`, `DD-MM-YYYY`. Invalid calendar dates (for example `31/02/2027`) are rejected. |
| Quantity | Plain number, commas allowed (`1,200`). Must be a finite number; quantities must be `> 0`. |
| Money | Plain number, `₦`, commas and spaces stripped. Must be `>= 0`. |
| Boolean | `true/yes/y/1/active` or `false/no/n/0/inactive`. Blank defaults per column. |

Dates are interpreted as UTC calendar dates, matching how batch expiry dates are stored.

## Workflow

1. Pick an import type. The UI loads the schema (`GET /pharmacy/imports/schema/:type`) with column definitions, instructions and limits, and offers the template download.
2. Download the template, fill it in, save as CSV.
3. Upload the file (drag and drop or file picker). The client checks the `.csv` extension and the size limit before sending.
4. The file is validated immediately. Nothing is written to the catalogue at this stage.
5. Review: total rows, valid, invalid, duplicates, file-level errors, the first 200 rows with per-row issues, and the resolved column mapping.
6. If a column was not recognised, change the mapping and validate again. A new validation replaces the previous result.
7. Confirm. Only `VALID` rows are imported.
8. Read the result summary: imported, failed, duplicate and invalid counts, with a downloadable error report for everything that did not go in.

## Endpoints

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/v1/pharmacy/imports/templates/:type` | any member | `{ filename, contentType, content }` with the CSV text. |
| `GET` | `/api/v1/pharmacy/imports/schema/:type` | any member | Label, summary, instructions, `fileTypes`, `maxRows`, column metadata. |
| `GET` | `/api/v1/pharmacy/imports?limit=10` | any member | Recent jobs for the workspace. |
| `POST` | `/api/v1/pharmacy/imports` | OWNER, MANAGER, INVENTORY_STAFF | Body `{ type, filename, content, mapping? }`. Parses, validates and stores the job with all rows. Returns the job detail. |
| `GET` | `/api/v1/pharmacy/imports/:id` | any member | Job detail with up to 200 rows (`previewLimit`). |
| `GET` | `/api/v1/pharmacy/imports/:id/errors` | any member | CSV error report. |
| `POST` | `/api/v1/pharmacy/imports/:id/confirm` | OWNER, MANAGER, INVENTORY_STAFF | Imports the valid rows of a `VALIDATED` job. |

`mapping` is optional and only needed to override automatic header matching: `{ "product_name": "Item", "unit": "UOM" }` maps template keys to header labels present in the file.

## Limits

| Limit | Value | Source |
| --- | --- | --- |
| File type | `.csv` only | filename check |
| File size | 5 MB | `IMPORT_MAX_FILE_BYTES` |
| Data rows per file | 2000 | `IMPORT_MAX_ROWS` |
| Rows returned in job detail | 200 | `PREVIEW_LIMIT` |

Both limits are exposed by the schema endpoint so the UI never advertises a limit the API does not enforce.

## Row statuses

| Status | Meaning |
| --- | --- |
| `VALID` | Passed every rule; will be imported on confirm. |
| `INVALID` | At least one field failed. Excluded from the import. |
| `DUPLICATE` | Conflicts with an earlier row in the file or with existing data. Excluded from the import. |
| `IMPORTED` | Written successfully during confirm. |
| `FAILED` | Passed validation but failed during confirm (for example a concurrent change); the error is recorded on the row. |

Nothing is ever skipped silently: every row ends in one of these states and appears in the summary or the error report.

### Duplicate rules

`PRODUCTS`:

- Same normalised product name twice in the file.
- Product already in the catalogue (normalised name match).
- Same barcode twice in the file.
- Barcode already assigned to another product in the workspace.

`BATCHES` / `INITIAL_STOCK`:

- Same product + batch number + expiry date twice in the file.
- Product name not found in the catalogue (the row is invalid, not duplicate).
- Expiry date in the past (invalid).
- Quantity missing, non-numeric or `<= 0` (invalid).

Validation is pure, so the same rules run at upload and again before the data is written.

## Confirm semantics

- Only jobs in `VALIDATED` status can be confirmed; a second confirm returns `VALIDATION_ERROR` ("This import has already been processed.").
- A job with zero valid rows returns `IMPORT_ROW_ERRORS`.
- Each valid row is applied in its own database transaction: batch creation, `OPENING` stock movement and balance upsert succeed or fail together.
- The movement idempotency key is deterministic: `import-<jobId>-<rowNumber>`, so a retried or duplicated write for the same row cannot double the balance.
- A failing row is marked `FAILED` with the error appended; the remaining rows continue. The job ends as `COMPLETED` or `COMPLETED_WITH_ERRORS`.
- Imported rows are not rolled back when a later row fails. Each row is an independent, complete operation, which is why the result summary reports imported and failed counts separately rather than claiming an all-or-nothing import.
- `OPENING` movements are attributed to the import rather than to a person in `actorId`; the job records `createdById` and an audit entry names the actor.

Audit actions: `IMPORT_VALIDATED` and `IMPORT_CONFIRMED`, each with type, filename, row counts and job id.

## Error report

`GET /pharmacy/imports/:id/errors` returns CSV with:

```text
Row,Status,Errors,<template columns...>
```

`Row` is the physical line number in the uploaded file (blank lines and `#` lines are not counted as records, but the number still refers to the file line, which is what spreadsheet software shows). `Errors` joins multiple messages with ` | `. The remaining columns repeat the uploaded values so the user can correct the row in place and re-upload.

It includes `INVALID`, `DUPLICATE` and `FAILED` rows. When everything imported successfully the endpoint returns a header-only file rather than an error.

## Frontend

| Component | Responsibility |
| --- | --- |
| `features/pharmacy/bulk-import.tsx` | Page content plus recent imports. |
| `components/imports/import-wizard.tsx` | Orchestrates type choice, upload, validation, mapping, preview and confirm. |
| `components/imports/download-template-button.tsx` | Fetches and saves the template. |
| `components/imports/file-upload.tsx` | Drag and drop, file picker, extension and size checks, reads the text. |
| `components/imports/column-mapping-table.tsx` | Per-column header selection plus "Validate again". |
| `components/imports/import-preview-table.tsx` | First rows with status and issues. |
| `components/imports/import-validation-summary.tsx` | Counts, file-level errors, next-step guidance. |
| `components/imports/import-error-report.tsx` | Downloads the error report. |
| `components/imports/import-progress.tsx` | Busy state with `role="status"`. |
| `components/imports/import-result-summary.tsx` | Post-confirm outcome and "start again". |

Route: `/products/pharmacy/import`, linked from the sidebar under Inventory ("Bulk import"). The page is desktop-friendly but usable on a tablet: upload buttons and table rows keep touch-sized targets, and the preview table scrolls horizontally.

## Known constraints

- CSV only. Excel files must be saved as CSV first; the API rejects other extensions with a clear message. See `OPEN_PRODUCT_DECISIONS.md` for XLSX.
- The file is sent as a JSON string in the request body, which is why the size cap is 5 MB rather than a streaming upload.
- Confirmation is synchronous. A 2000-row file is processed in one request; there is no queue, resume or cancellation.
- Imported products are created, never updated. A product that already exists is reported as a duplicate rather than merged; catalogue edits happen through the product screens.
- Row numbers refer to physical lines in the uploaded file, not to "data row index", so they match what the user sees in a spreadsheet.

## Verification

```bash
npm run build
npm run lint
npx jest src/modules/products/pharmacy/imports
npx tsc --noEmit
```

`csv.spec.ts` covers quoted fields, escaped quotes, CRLF, BOM and `#`/blank line skipping. `import-validation.spec.ts` covers date and quantity parsing, duplicate detection, past expiry dates, barcode conflicts and required columns. Frontend: `npx jest src/components/imports` covers the validation summary.

Manual check with a two-row file:

1. Upload a products file with one new product, one duplicate name and one invalid barcode.
2. The validation summary must report 3 rows: 1 valid, 1 duplicate, 1 invalid.
3. Confirm imports exactly one product.
4. The error report contains the two rejected rows with their line numbers and messages.

## Related documentation

- `BARCODE_SCANNING.md` for the barcode format and uniqueness rules reused here.
- `DASHBOARD_METRICS.md` for how imported opening stock affects reported quantities.

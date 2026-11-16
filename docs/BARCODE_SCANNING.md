# Barcode Scanning

Scanning is a lookup feature. A scan resolves a barcode to a product and its batches; it never changes stock. Every stock change still goes through `POST /api/v1/pharmacy/movements` with the existing validation, idempotency key and audit trail.

## Storage

`Product.barcode` is a nullable string with a unique constraint per workspace: `@@unique([organizationId, barcode])`, plus an index for lookups. The same barcode can exist in two different pharmacies and cannot be assigned twice inside one pharmacy.

Values are canonicalised before storage and before lookup: trimmed and upper-cased (`normalizeBarcode`). Letter casing therefore cannot create a duplicate or a lookup miss.

Accepted format: `/^[A-Z0-9._-]{4,64}$/` - letters, digits, dot, dash or underscore, 4 to 64 characters. EAN-13, EAN-8, UPC-A and UPC-E all satisfy this, as do internally printed SKUs. Separators such as `6151100010203` and `PC2451` are valid; spaces and slashes are not.

Barcodes can be set when creating or updating a medicine, when importing the product catalogue, or through the dedicated barcode endpoint. All three paths normalise the value and call the same uniqueness check.

## Endpoints

| Method | Path | Roles | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/v1/pharmacy/barcodes/lookup?code=...` | any member | Returns `{ data: { barcode, product, batches } }`. `404 NOT_FOUND` when nothing matches, `400 VALIDATION_ERROR` when `code` is empty. |
| `PUT` | `/api/v1/pharmacy/barcodes/product/:productId` | OWNER, MANAGER, INVENTORY_STAFF | Body `{ "barcode": "6151100010203" }`. Assigns or replaces a barcode. `null` or an empty string clears it. |

### Lookup response

```json
{
  "data": {
    "barcode": "6151100010203",
    "product": {
      "id": "...",
      "name": "Paracetamol 500mg Tablet",
      "brand": "Emzor",
      "strength": "500mg",
      "dosageForm": "Tablet",
      "packSize": "10 x 10",
      "unit": "tablet",
      "barcode": "6151100010203",
      "reorderThreshold": 50,
      "active": true,
      "totalRecordedQuantity": 240
    },
    "batches": [
      {
        "id": "...",
        "batchNumber": "PC2451",
        "expiryDate": "2027-01-01T00:00:00.000Z",
        "unit": "tablet",
        "unitCost": 18.5,
        "sellingPrice": 25,
        "balanceQuantity": 240,
        "daysToExpiry": 46,
        "expiryStatus": "EXPIRING_SOON"
      }
    ]
  }
}
```

Batches are ordered by expiry date (earliest first). `quantity` comes from `BatchBalance`, so it is the recorded balance, not a physical count. `totalRecordedQuantity` is the sum across batches.

`expiryStatus` is derived from the workspace-local day difference:

| Status | Condition |
| --- | --- |
| `EXPIRED` | `daysToExpiry < 0` |
| `EXPIRING_SOON` | `0 <= daysToExpiry <= 90` |
| `OK` | `daysToExpiry > 90` |
| `UNKNOWN` | no expiry date on the batch |

### Assignment errors

| Case | Response |
| --- | --- |
| Invalid characters or length | `400 VALIDATION_ERROR`: "Barcodes must be 4 to 64 characters and may only contain letters, numbers, dot, dash or underscore." |
| Barcode already used in the workspace | `409 DUPLICATE_REQUEST`: "This barcode is already assigned to `<product name>`." (the existing owner is named so staff can fix the label) |
| Product not in the caller's organisation | `404 NOT_FOUND` |
| Clearing a barcode | `200` with `barcode: null` |

Assignments, replacements and clears are audited as `BARCODE_ASSIGNED` and `BARCODE_CLEARED`, each recording the barcode (where one applies) and the product name in the audit metadata.

## Guarantee: scanning is read-only

The lookup endpoint performs no writes. There is no code path from a scan to a balance change.

After a successful scan the UI offers next actions that each open an explicit, reversible workflow:

| Action | What happens |
| --- | --- |
| View product / batches / movements | Read-only navigation. |
| Record movement | Opens the movement form pre-filled with the batch. Stock changes only when the movement is submitted and accepted by `POST /pharmacy/movements`. |
| Start stock count | Opens the stock count workflow (counted stock is a separate record from the balance until approved). |
| Sale | Not offered. There is no sales module; sale buttons are omitted rather than faked. |

The movement form supports `ISSUE`, `CUSTOMER_RETURN`, `SUPPLIER_RETURN`, `DAMAGE`, `EXPIRED` and `ADJUSTMENT` (with an increase/decrease selector). `ADJUSTMENT` requires a reason. Each submission sends an idempotency key (`scan-movement-<batchId>-<uuid>`) so a double tap cannot post twice, and insufficient stock is rejected by the ledger with `INSUFFICIENT_STOCK`.

## Frontend

| File | Responsibility |
| --- | --- |
| `src/app/products/pharmacy/scan/page.tsx` | Route `/products/pharmacy/scan`. |
| `src/features/pharmacy/scan-product.tsx` | Orchestrates camera, manual input, lookup, history and post-scan actions. Presentation only; no stock logic. |
| `src/components/barcode/barcode-scanner.tsx` | Camera capture and detection. |
| `src/components/barcode/barcode-input.tsx` | Manual barcode/SKU entry fallback. |
| `src/components/barcode/scan-result-card.tsx` | Product and batch result, expiry badges, next actions. Also exports `UnknownBarcodeCard`. |
| `src/components/barcode/assign-barcode-panel.tsx` | "Product not found" recovery: search the catalogue and attach the scanned barcode. |
| `src/components/barcode/product-scan-history.tsx` | Session history of codes scanned in this visit. |
| `src/components/pharmacy/movement-form.tsx` | Movement entry used by the scan result. |

The page is linked from the sidebar under Inventory ("Scan product") and from the mobile bottom navigation as "Scan".

### Camera behaviour

- The camera is not opened on page load. The user taps "Start camera", which calls `getUserMedia({ video: { facingMode: 'environment' } })`.
- Detection uses the browser-native `BarcodeDetector` API with candidate formats `ean_13`, `ean_8`, `upc_a`, `upc_e`, `code_128`, `code_39`, `itf`. The list is filtered with `getSupportedFormats()` and only supported formats are requested.
- A 350 ms polling loop feeds the video element to the detector. On the first match the camera stops, tracks are released and the raw value is passed to the lookup.
- If `BarcodeDetector` is unavailable (for example Firefox or older Safari), the scanner renders an explanatory message and the manual input remains available. Nothing is installed or shimmed.
- `NotAllowedError` (permission denied) and other failures show a specific message instead of a generic error.
- Tracks are released when the component unmounts, when scanning is stopped, and after a successful read.

Manual entry always works, including for SKUs that are not standard barcodes, and is the supported path on devices without camera support.

### "Product not found"

A `404` from the lookup produces `UnknownBarcodeCard` with the scanned code plus `AssignBarcodePanel`. The panel searches `/pharmacy/medicines?limit=10&q=` (minimum two characters), lets the user pick a product and calls the barcode endpoint. On success the lookup is refetched and the normal result card appears. Assigning a barcode is an explicit catalogue change, so the action is restricted to OWNER, MANAGER and INVENTORY_STAFF by the API.

### Scan history

`ProductScanHistory` keeps the last five distinct codes for the current visit, in memory, with "Open again" to repeat a lookup. It is intentionally not persisted:

- Storing every scan would mean a new storage model, retention rules and a privacy decision for no proven operational gain.
- The operational record of a scan that led to a stock change already exists as a stock movement with its actor and idempotency key.
- If audit-grade scan logging is required later, it belongs in a dedicated model with an explicit retention policy (see `OPEN_PRODUCT_DECISIONS.md`).

The scan page is therefore safe to close and reopen at any time; only the quick-repeat list is lost.

## Accessibility and mobile

- The scanner is a labelled button, not an always-on camera surface, so screen reader and keyboard users are not dropped into a video element.
- Manual input is a labelled form (`useId`), submits on Enter, and disables the submit button when empty.
- Result cards use headings and lists, expiry status is conveyed in text (not colour alone), and action buttons keep a 44px touch target.
- Layout is single column on small screens; batch rows stack.

## Known limitations

- Only 1D formats listed above are requested; 2D symbologies (QR, DataMatrix) and GS1 application identifier parsing are not implemented. The detected raw value is used as-is.
- The camera path depends on `BarcodeDetector`; manual entry is the universal fallback.
- A duplicate barcode inside a single workspace cannot be merged automatically; staff must clear or reassign one of the products.
- Lookup is exact after normalisation. It does not fall back to product name or SKU text; use the products search for that.

## Verification

```bash
# Backend
npm run build
npx jest src/common/utils/time.spec.ts

# Frontend
npm run lint
npx tsc --noEmit
npx jest src/components/barcode/scan-result-card.test.tsx
```

The component test asserts that "Record movement" calls back with the selected batch (it does not mutate stock), that product, batch and expiry status render, and that the "sales not available" note is present.

## Related documentation

- `BULK_IMPORT_SYSTEM.md` for barcode rules during catalogue import.
- `NOTIFICATION_SYSTEM.md` for expiry information that drives the status badges.

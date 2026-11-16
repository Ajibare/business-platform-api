# API Conventions

## Base path

All endpoints live under `/api/v1`.

## Request and response

JSON bodies with class-validator DTOs. Success responses use a stable envelope. Errors use stable codes.

Envelope: `{ data: T, meta?: Record<string, unknown> }`.

Error body: `{ statusCode, error, code, message }`.

## Auth endpoints

- `POST /api/v1/auth/signup`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

## Product endpoints (Pharmacy Stock Intelligence)

- Medicines: `GET /api/v1/pharmacy/medicines`, `POST /api/v1/pharmacy/medicines`, `GET /api/v1/pharmacy/medicines/:id`, `PATCH /api/v1/pharmacy/medicines/:id`
- Batches: `GET /api/v1/pharmacy/batches`, `POST /api/v1/pharmacy/batches`, `GET /api/v1/pharmacy/batches/:id`
- Movements: `POST /api/v1/pharmacy/movements`, `GET /api/v1/pharmacy/movements`
- Expiry: `GET /api/v1/pharmacy/expiry/near`, `GET /api/v1/pharmacy/expiry/expired`, `GET /api/v1/pharmacy/expiry/unknown`
- Reports: `GET /api/v1/pharmacy/reports/dashboard`, `GET /api/v1/pharmacy/reports/low-stock`, `GET /api/v1/pharmacy/reports/daily`
- Barcodes: `GET /api/v1/pharmacy/barcodes/lookup`, `PUT /api/v1/pharmacy/barcodes/product/:productId`
- Bulk import: `GET /api/v1/pharmacy/imports/templates/:type`, `GET /api/v1/pharmacy/imports/schema/:type`, `GET /api/v1/pharmacy/imports`, `POST /api/v1/pharmacy/imports`, `GET /api/v1/pharmacy/imports/:id`, `GET /api/v1/pharmacy/imports/:id/errors`, `POST /api/v1/pharmacy/imports/:id/confirm`
- Counts: `POST /api/v1/pharmacy/counts`, `POST /api/v1/pharmacy/counts/:id/lines`, `POST /api/v1/pharmacy/counts/:id/submit`, `POST /api/v1/pharmacy/counts/:id/approve`
- Receipts: `POST /api/v1/pharmacy/receipts`, `POST /api/v1/pharmacy/receipts/:id/confirm`
- Suppliers: `GET /api/v1/pharmacy/suppliers`, `POST /api/v1/pharmacy/suppliers`, `GET /api/v1/pharmacy/suppliers/:id`, `PATCH /api/v1/pharmacy/suppliers/:id`

## Notification endpoints

- Feed: `GET /api/v1/notifications`, `GET /api/v1/notifications/unread-count`, `POST /api/v1/notifications/:id/read`, `POST /api/v1/notifications/read-all`
- Capabilities and preferences: `GET /api/v1/notifications/capabilities`, `GET /api/v1/notifications/preferences`, `PATCH /api/v1/notifications/preferences`
- Recipients: `GET /api/v1/notifications/recipients`, `POST /api/v1/notifications/recipients`, `PATCH /api/v1/notifications/recipients/:id`, `DELETE /api/v1/notifications/recipients/:id`
- Deliveries: `GET /api/v1/notifications/deliveries`, `POST /api/v1/notifications/deliveries/:id/retry`
- Manual scan: `POST /api/v1/notifications/expiry-scan`
- Audit log: `GET /api/v1/audit`

The expiry scan is also scheduled inside the API process; see `NOTIFICATION_SYSTEM.md`.

## Errors

Stable error codes include `VALIDATION_ERROR`, `UNAUTHORIZED`, `NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `INSUFFICIENT_STOCK`, `STALE_COUNT`, `DUPLICATE_REQUEST`, `IMPORT_ROW_ERRORS`, `RATE_LIMITED`, `INTERNAL_ERROR`.

Business errors are raised with an explicit code, for example `INSUFFICIENT_STOCK` with HTTP status 409.

## Pagination

List endpoints use limit and cursor or offset conventions defined per endpoint.

## Versioning

Breaking changes require a new version. Additive changes are made under the current version.

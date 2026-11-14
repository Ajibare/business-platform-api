# API Conventions

## Base path

All endpoints live under `/api/v1`.

## Request and response

JSON bodies with class-validator DTOs. Success responses use a stable envelope. Errors use stable codes.

## Auth endpoints

- `POST /api/v1/auth/signup`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`

## Errors

Stable error codes include `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN`, `INSUFFICIENT_STOCK`, `STALE_COUNT`, `DUPLICATE_REQUEST`, `IMPORT_ROW_ERRORS`, `RATE_LIMITED`, `INTERNAL_ERROR`.

## Pagination

List endpoints use limit and cursor or offset conventions defined per endpoint.

## Versioning

Breaking changes require a new version. Additive changes are made under the current version.

export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'FORBIDDEN',
  'CONFLICT',
  'INSUFFICIENT_STOCK',
  'STALE_COUNT',
  'DUPLICATE_REQUEST',
  'IMPORT_ROW_ERRORS',
  'RATE_LIMITED',
  'DATABASE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ErrorBody {
  code: ApiErrorCode;
  message: string;
}

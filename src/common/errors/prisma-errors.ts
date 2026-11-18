import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiErrorCode } from '../interfaces/api-response.interface';

/**
 * A client-safe description of a database failure.
 *
 * `message` is what the caller sees, so it never contains SQL, column names,
 * connection strings or credentials. `logHint` is the opposite: it exists so the
 * server log tells an engineer exactly what to do about the error.
 */
export interface DescribedError {
  status: number;
  code: ApiErrorCode;
  message: string;
  logHint?: string;
}

const DATABASE_DOWN_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

// Migration history lives in `prisma/migrations`, so every environment applies it
// with `migrate deploy`; `migrate dev` is only for authoring a new migration locally.
const SCHEMA_BEHIND_HINT =
  'The database schema is behind the application schema, or has not been created. Run `npx prisma migrate deploy` against this environment, then restart the API.';

const DATABASE_DOWN_MESSAGE =
  'The service is temporarily unavailable. Please try again in a moment.';

/**
 * Maps the Prisma errors that have a meaningful HTTP equivalent and returns
 * `null` for everything else, so the caller can fall back to its own handling.
 */
export function describePrismaError(error: unknown): DescribedError | null {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'DATABASE_UNAVAILABLE',
      message: DATABASE_DOWN_MESSAGE,
      logHint:
        'Prisma could not open a connection. Check DATABASE_URL (user, password, host, port, database name), that the PostgreSQL service is running, and that the database exists.',
    };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return describeKnownError(error);
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    // A validation error means the application built a query the client rejects:
    // that is a bug, not a bad request.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'We could not complete your request. Please try again later.',
      logHint: 'Prisma rejected a query built by the application. Inspect the call site.',
    };
  }

  return null;
}

function describeKnownError(error: Prisma.PrismaClientKnownRequestError): DescribedError | null {
  const target = Array.isArray(error.meta?.target)
    ? (error.meta?.target as string[]).join(', ')
    : typeof error.meta?.target === 'string'
      ? error.meta.target
      : '';

  if (DATABASE_DOWN_CODES.has(error.code)) {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'DATABASE_UNAVAILABLE',
      message: DATABASE_DOWN_MESSAGE,
      logHint: `Prisma reported ${error.code}. The database is unreachable or the connection pool is exhausted.`,
    };
  }

  switch (error.code) {
    case 'P2002':
      return {
        status: HttpStatus.CONFLICT,
        code: 'CONFLICT',
        message: 'A record with these details already exists.',
        logHint: `Unique constraint violated${target ? ` on (${target})` : ''}.`,
      };
    case 'P2003':
      return {
        status: HttpStatus.CONFLICT,
        code: 'CONFLICT',
        message: 'This change conflicts with related records.',
        logHint: `Foreign key constraint violated${target ? ` on (${target})` : ''}.`,
      };
    case 'P2025':
      return {
        status: HttpStatus.NOT_FOUND,
        code: 'NOT_FOUND',
        message: 'The requested record could not be found.',
        logHint: 'The record the operation depended on does not exist.',
      };
    case 'P2000':
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_ERROR',
        message: 'One of the values is too long for its field.',
        logHint: `A value exceeds the column length${target ? ` of (${target})` : ''}.`,
      };
    case 'P2011':
    case 'P2012':
    case 'P2013':
    case 'P2014':
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_ERROR',
        message: 'A required value is missing from the request.',
        logHint: `Prisma reported ${error.code}: a required relation or value was not provided.`,
      };
    case 'P2021':
    case 'P2022':
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_ERROR',
        message: 'We could not complete your request. Please try again later.',
        logHint: `${error.code}: a table or column does not exist. ${SCHEMA_BEHIND_HINT}`,
      };
    case 'P2034':
      return {
        status: HttpStatus.CONFLICT,
        code: 'CONFLICT',
        message: 'The record changed while your request was being saved. Please try again.',
        logHint: 'Transaction write conflict or deadlock; the transaction was rolled back.',
      };
    default:
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_ERROR',
        message: 'We could not complete your request. Please try again later.',
        logHint: `Unhandled Prisma error ${error.code}.`,
      };
  }
}

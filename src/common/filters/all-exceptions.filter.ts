import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';
import { ApiErrorCode } from '../interfaces/api-response.interface';
import { describePrismaError } from '../errors/prisma-errors';

const STATUS_TO_ERROR_CODE: Record<number, ApiErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'DATABASE_UNAVAILABLE',
};

const STATUS_TO_PHRASE: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  423: 'Locked',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** Copy used when an error did not come from the application itself. */
const UNEXPECTED_MESSAGE = 'We could not complete your request. Please try again later.';

/**
 * `express.json()` raises a body-parser SyntaxError naming the byte offset of the
 * broken JSON. That offset is useful in the log and noise in a response.
 */
const MALFORMED_BODY_PATTERN =
  /JSON at position|Unexpected token|Unexpected end of JSON|Expected property name|Unterminated string/i;
const MALFORMED_BODY_MESSAGE = 'The request body could not be read. Send a valid JSON object.';

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_REQUEST_ID_LENGTH = 100;

interface ErrorParts {
  status: number;
  code: ApiErrorCode;
  message: string;
  /** Which request field the failure belongs to, when there is one. */
  field?: string;
  details?: unknown;
  retryAfterSeconds?: number;
  /** Server-side explanation that never reaches the client. */
  logHint?: string;
}

/**
 * The single place that turns any thrown value into the API's error envelope.
 *
 * Guarantees:
 * - HTTP status reflects the failure; a failed request never answers 2xx.
 * - The body is always `{ statusCode, error, code, message, requestId, ... }`.
 * - Stack traces, SQL, credentials and driver messages stay in the server log.
 * - Every response carries `x-request-id`, so a user can quote one identifier
 *   and the matching log line can be found immediately.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const requestId = this.requestId(request, response);
    const parts = this.describe(exception);
    const method = request?.method ?? 'UNKNOWN';
    const url = request?.originalUrl ?? request?.url ?? 'unknown';

    this.log(exception, parts, { requestId, method, url });

    const payload: Record<string, unknown> = {
      statusCode: parts.status,
      error: STATUS_TO_PHRASE[parts.status] ?? 'Error',
      code: parts.code,
      message: parts.message,
      requestId,
    };
    if (parts.field !== undefined) payload.field = parts.field;
    if (parts.details !== undefined) payload.details = parts.details;

    if (parts.retryAfterSeconds !== undefined) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil(parts.retryAfterSeconds))));
    }

    response.status(parts.status).json(payload);
  }

  /** Reuses an upstream correlation id when a proxy or client supplied one. */
  private requestId(request: Request, response: Response): string {
    const header = request?.headers?.[REQUEST_ID_HEADER];
    const supplied = Array.isArray(header) ? header[0] : header;
    const requestId =
      supplied && supplied.trim().length > 0 && supplied.length <= MAX_REQUEST_ID_LENGTH
        ? supplied.trim()
        : randomUUID();

    response.setHeader(REQUEST_ID_HEADER, requestId);
    return requestId;
  }

  private describe(exception: unknown): ErrorParts {
    if (exception instanceof HttpException) {
      return this.describeHttpException(exception);
    }

    const prisma = describePrismaError(exception);
    if (prisma) {
      return {
        status: prisma.status,
        code: prisma.code,
        message: prisma.message,
        logHint: prisma.logHint,
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: UNEXPECTED_MESSAGE,
    };
  }

  private describeHttpException(exception: HttpException): ErrorParts {
    const status = exception.getStatus();
    const body = exception.getResponse();
    const isObject = typeof body === 'object' && body !== null;
    const source = isObject ? (body as Record<string, unknown>) : {};

    const rawMessage = isObject ? source.message : body;
    // class-validator reports one message per failed rule; `details` carries the
    // complete list, `message` stays a single readable sentence.
    const message = Array.isArray(rawMessage)
      ? String(rawMessage[0] ?? STATUS_TO_PHRASE[status] ?? 'Request failed')
      : rawMessage !== undefined && typeof rawMessage !== 'object'
        ? String(rawMessage)
        : exception.message;

    const code = (
      typeof source.code === 'string' ? source.code : STATUS_TO_ERROR_CODE[status]
    ) as ApiErrorCode | undefined;

    const friendlyMessage =
      status === HttpStatus.BAD_REQUEST && MALFORMED_BODY_PATTERN.test(message)
        ? MALFORMED_BODY_MESSAGE
        : message;

    return {
      status,
      code: code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'),
      message: status >= 500 && code === undefined ? UNEXPECTED_MESSAGE : friendlyMessage,
      field: typeof source.field === 'string' ? source.field : undefined,
      details: source.details,
      retryAfterSeconds:
        typeof source.retryAfterSeconds === 'number' ? source.retryAfterSeconds : undefined,
    };
  }

  /**
   * Structured, one line per failure. The request body is never logged: it
   * contains passwords, codes and tokens on the auth routes.
   */
  private log(
    exception: unknown,
    parts: ErrorParts,
    context: { requestId: string; method: string; url: string },
  ) {
    const name = exception instanceof Error ? exception.name : typeof exception;
    const detail = exception instanceof Error ? exception.message : String(exception);
    const line =
      `${context.method} ${context.url} -> ${parts.status} ${parts.code} ` +
      `requestId=${context.requestId} error=${name}: ${detail}` +
      (parts.logHint ? ` | hint: ${parts.logHint}` : '');

    if (parts.status >= 500) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(line, stack);
      return;
    }

    this.logger.warn(line);
  }
}

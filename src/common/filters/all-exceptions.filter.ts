import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { ApiErrorCode } from '../interfaces/api-response.interface';

const STATUS_TO_ERROR_CODE: Record<number, ApiErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse = exception instanceof HttpException ? exception.getResponse() : undefined;
    const isObject = typeof exceptionResponse === 'object' && exceptionResponse !== null;
    const rawMessage = isObject ? (exceptionResponse as { message?: unknown }).message : undefined;
    // class-validator reports one message per failed rule; the first one is what
    // the form shows next to the field.
    const message = Array.isArray(rawMessage)
      ? String(rawMessage[0] ?? 'Internal server error')
      : rawMessage !== undefined
        ? String(rawMessage)
        : exception instanceof HttpException
          ? exception.message
          : 'Internal server error';
    const error = isObject && 'code' in exceptionResponse
      ? String((exceptionResponse as { code?: unknown }).code)
      : exception instanceof HttpException
        ? exception.name.replace('Exception', '')
        : 'Internal Server Error';
    const code = (
      isObject && 'code' in exceptionResponse
        ? String((exceptionResponse as { code?: unknown }).code)
        : STATUS_TO_ERROR_CODE[status]
    ) as ApiErrorCode;

    const payload: Record<string, unknown> = {
      statusCode: status,
      error,
      code,
      message,
    };

    // Extra, non-secret hints the client uses to render a useful form: which
    // field failed, how many attempts are left and how long to wait before
    // retrying. They are only forwarded when the exception set them.
    if (isObject) {
      for (const key of ['field', 'details', 'retryAfterSeconds'] as const) {
        const value = (exceptionResponse as Record<string, unknown>)[key];
        if (value !== undefined) payload[key] = value;
      }
    }

    response.status(status).json(payload);
  }
}

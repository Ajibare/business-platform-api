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
    const message = isObject && 'message' in exceptionResponse
      ? String((exceptionResponse as { message?: unknown }).message ?? 'Internal server error')
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

    response.status(status).json({
      statusCode: status,
      error,
      code,
      message,
    });
  }
}

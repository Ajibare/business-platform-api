import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ValidationError } from 'class-validator';
import { Response } from 'express';
import { collectFieldIssues, validationException } from '../validation/validation-exception';
import { AllExceptionsFilter } from './all-exceptions.filter';

function hostFor(request: Record<string, unknown> = {}) {
  const json = jest.fn();
  const setHeader = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status, setHeader } as unknown as Response;
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({
        method: 'POST',
        originalUrl: '/api/v1/auth/register',
        headers: {},
        ...request,
      }),
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json, setHeader };
}

const knownError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`Prisma failed with ${code}`, {
    code,
    clientVersion: '6.16.0',
    meta,
  });

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps a handled HttpException unchanged and adds a request id', () => {
    const { host, status, json, setHeader } = hostFor();

    filter.catch(
      new ConflictException({
        code: 'EMAIL_IN_USE',
        message: 'An account already exists for this email address.',
        field: 'email',
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(setHeader).toHaveBeenCalledWith(
      'x-request-id',
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    );
    expect(json).toHaveBeenCalledWith({
      statusCode: 409,
      error: 'Conflict',
      code: 'EMAIL_IN_USE',
      message: 'An account already exists for this email address.',
      field: 'email',
      requestId: expect.any(String),
    });
  });

  it('reuses a correlation id supplied by the client', () => {
    const { host, setHeader } = hostFor({ headers: { 'x-request-id': 'client-trace-1' } });

    filter.catch(new Error('boom'), host);

    expect(setHeader).toHaveBeenCalledWith('x-request-id', 'client-trace-1');
  });

  it('turns a validation failure into one message per field', () => {
    const errors = Object.assign(new ValidationError(), {
      property: 'email',
      constraints: { isEmail: 'Enter a valid email address.' },
    });
    const { host, status, json } = hostFor();

    filter.catch(validationException([errors]), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Enter a valid email address.',
        field: 'email',
        details: [{ field: 'email', message: 'Enter a valid email address.' }],
      }),
    );
  });

  it('uses the first message when a validation exception carries an array', () => {
    const { host, json } = hostFor();

    filter.catch(
      new BadRequestException({ message: ['Name is too short.', 'Email is invalid.'] }),
      host,
    );

    expect(json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Name is too short.' }));
  });

  it('maps a unique violation to 409 Conflict', () => {
    const { host, status, json } = hostFor();

    filter.catch(knownError('P2002', { target: ['email'] }), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CONFLICT', error: 'Conflict' }),
    );
  });

  it('maps a missing record to 404 Not Found', () => {
    const { host, status, json } = hostFor();

    filter.catch(knownError('P2025'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('maps an unreachable database to 503 instead of 500', () => {
    const { host, status, json } = hostFor();

    filter.catch(knownError('P1001'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DATABASE_UNAVAILABLE', error: 'Service Unavailable' }),
    );
  });

  it('never leaks database credentials when authentication fails', () => {
    const { host, status, json } = hostFor();
    const failure = new Prisma.PrismaClientInitializationError(
      'Authentication failed against database server at `localhost`. The provided database credentials for `postgres` are not valid. postgresql://postgres:secret@localhost:5432/db',
      'P1000',
      '6.16.0',
    );

    filter.catch(failure, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    const payload = json.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.message).toBe(
      'The service is temporarily unavailable. Please try again in a moment.',
    );
    expect(JSON.stringify(payload)).not.toContain('postgres:secret');
    expect(JSON.stringify(payload)).not.toContain('Authentication failed');
  });

  it('logs the full diagnostic and returns a generic message for unknown errors', () => {
    const { host, status, json } = hostFor();
    const logged = jest.spyOn(Logger.prototype, 'error');

    filter.catch(new Error('bcrypt blew up at line 42'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'INTERNAL_ERROR',
        message: 'We could not complete your request. Please try again later.',
      }),
    );
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('bcrypt blew up');
    // The stack trace belongs in the log, not the response.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('POST /api/v1/auth/register'),
      expect.any(String),
    );
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('bcrypt blew up'),
      expect.any(String),
    );
  });

  it('does not log a stack trace for client mistakes', () => {
    const { host } = hostFor();
    const error = jest.spyOn(Logger.prototype, 'error');
    const warn = jest.spyOn(Logger.prototype, 'warn');

    filter.catch(new BadRequestException('Nope'), host);

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('-> 400 VALIDATION_ERROR'));
  });

  it('replaces body-parser offsets with a sentence', () => {
    const { host, status, json } = hostFor();

    filter.catch(
      new BadRequestException('Unterminated string in JSON at position 12 (line 1 column 13)'),
      host,
    );

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: 'The request body could not be read. Send a valid JSON object.',
      }),
    );
  });

  it('sends Retry-After when the exception carries a wait time', () => {
    const { host, setHeader } = hostFor();

    filter.catch(
      new HttpException(
        { code: 'RATE_LIMITED', message: 'Slow down.', retryAfterSeconds: 42 },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
      host,
    );

    expect(setHeader).toHaveBeenCalledWith('Retry-After', '42');
  });
});

describe('collectFieldIssues', () => {
  it('flattens nested validation errors with dotted paths', () => {
    const errors = Object.assign(new ValidationError(), {
      property: 'items',
      children: [
        Object.assign(new ValidationError(), {
          property: '0',
          children: [
            Object.assign(new ValidationError(), {
              property: 'quantity',
              constraints: { min: 'Quantity must be positive.' },
            }),
          ],
        }),
      ],
    });

    expect(collectFieldIssues([errors])).toEqual([
      { field: 'items.0.quantity', message: 'Quantity must be positive.' },
    ]);
  });

  it('reports every failed rule for a field, not just the first', () => {
    const errors = Object.assign(new ValidationError(), {
      property: 'password',
      constraints: {
        minLength: 'Use at least 10 characters.',
        matches: 'Include a number.',
      },
    });

    expect(collectFieldIssues([errors])).toHaveLength(2);
  });
});

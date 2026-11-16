import { BadRequestException } from '@nestjs/common';
import { ValidationError } from 'class-validator';

/** One failed rule, tied to the request field it belongs to. */
export interface FieldIssue {
  field: string;
  message: string;
}

/**
 * Flattens class-validator's tree into a list the client can render next to the
 * matching input. Nested objects use dotted paths (`items.0.quantity`).
 */
export function collectFieldIssues(errors: ValidationError[], parent = ''): FieldIssue[] {
  const issues: FieldIssue[] = [];

  for (const error of errors) {
    const field = parent ? `${parent}.${error.property}` : error.property;
    for (const message of Object.values(error.constraints ?? {})) {
      issues.push({ field, message });
    }
    if (error.children?.length) {
      issues.push(...collectFieldIssues(error.children, field));
    }
  }

  return issues;
}

/**
 * The `ValidationPipe` factory used by every endpoint.
 *
 * The first issue becomes `field` + `message` so a form can highlight one input,
 * and the complete list travels in `details` so every field can be marked at
 * once. Status stays 400 and the body keeps the API's existing error shape.
 */
export function validationException(errors: ValidationError[]): BadRequestException {
  const issues = collectFieldIssues(errors);
  const [first] = issues;

  return new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: first?.message ?? 'The request contains invalid values.',
    ...(first ? { field: first.field } : {}),
    details: issues,
  });
}

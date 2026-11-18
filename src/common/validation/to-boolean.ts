import { Transform } from 'class-transformer';

/**
 * A query string only ever carries text, so `?active=true` arrives as the string
 * `'true'` and `@IsBoolean()` rejects it. Only the two literal spellings are
 * converted; anything else is passed through untouched so the validator still
 * reports it.
 */
export function ToBoolean() {
  return Transform(({ value }) => {
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  });
}

import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const MAX_DEPTH = 20;

/** True when a string, or any key or string value nested in `value`, contains a NUL character. */
export function containsNullByte(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') {
    return value.includes('\u0000');
  }
  if (depth >= MAX_DEPTH || typeof value !== 'object' || value === null) {
    return false;
  }
  return Object.entries(value).some(
    ([key, item]) =>
      key.includes('\u0000') || containsNullByte(item, depth + 1),
  );
}

/**
 * Refuses request input containing a NUL (`\u0000`) character with a 400. Postgres cannot store
 * it in `text` or `jsonb`, so without this check it surfaces as an unhandled database error (a
 * 500) from any field that reaches a query, such as a login slug or a customer's metadata.
 * Registered globally, before the `ValidationPipe`, so it sees body, query and path values.
 */
@Injectable()
export class NoNullBytesPipe implements PipeTransform {
  transform(value: unknown) {
    if (containsNullByte(value)) {
      throw new BadRequestException([
        'text must not contain NUL (\\u0000) characters',
      ]);
    }
    return value;
  }
}

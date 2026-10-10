import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, registerDecorator } from 'class-validator';

export const MAX_ALLOWED_ORIGINS = 20;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLocalHost(hostname: string) {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/**
 * The canonical form of a browser origin (`scheme://host[:port]`, lower case, default port
 * dropped), or null when the value is not an acceptable allow-list entry. Accepted: `https://`
 * origins, and `http://` only for localhost, 127.0.0.1 and [::1] (development). Refused: wildcards,
 * paths, queries, credentials and the literal "null". A request's `Origin` header goes through the
 * same function before it is compared, so both sides use one spelling.
 */
export function normalizeOrigin(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value || value.length > 255 || value === 'null') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (!url.hostname || /[*\s]/.test(url.hostname)) return null;
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) return null;
  // `https://example.com/` and `https://example.com` are the same origin. A bare "?" or "#"
  // after the host leaves `search`/`hash` empty, so refuse any such leftover explicitly.
  if (/[?#]/.test(value)) return null;
  return url.origin;
}

/** Normalises every entry that is a valid origin, drops duplicates and leaves the rest for validation. */
export const toNormalizedOrigins = ({ value }: { value: unknown }) =>
  Array.isArray(value)
    ? [...new Set(value.map((item) => normalizeOrigin(item) ?? item))]
    : value;

/** Class-validator rule: every entry is already a canonical origin (use after the transform). */
function IsOriginEntries() {
  return (target: object, propertyName: string | symbol) =>
    registerDecorator({
      name: 'isOriginEntries',
      target: target.constructor,
      propertyName: propertyName as string,
      validator: {
        validate: (value: unknown) =>
          Array.isArray(value) &&
          value.every((item) => normalizeOrigin(item) === item),
        defaultMessage: () =>
          `${String(propertyName)} must contain only origins like https://shop.example.com (https, or http for localhost; no wildcard, path or query)`,
      },
    });
}

/** `allowedOrigins`-style field: an array of at most 20 distinct, canonical web origins. */
export const AllowedOrigins = () =>
  applyDecorators(
    Transform(toNormalizedOrigins),
    IsArray(),
    ArrayMaxSize(MAX_ALLOWED_ORIGINS),
    IsOriginEntries(),
  );

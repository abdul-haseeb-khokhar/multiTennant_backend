import { randomBytes } from 'node:crypto';

/** 3-40 chars, lower-case letters, digits and single dashes, no dash at either end. */
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

// Would collide with routes, subdomains or look official.
const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'docs',
  'health',
  'login',
  'signup',
  'support',
  'www',
]);

export function isReservedSlug(slug: string) {
  return RESERVED_SLUGS.has(slug);
}

/** `"Acme Support Ltd."` -> `"acme-support-ltd"`; falls back to `"workspace"` for names with no usable characters. */
export function slugify(name: string) {
  const slug = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return SLUG_PATTERN.test(slug) && !isReservedSlug(slug) ? slug : 'workspace';
}

/** Appends a short random suffix so a derived slug can be retried after a collision. */
export function withSuffix(slug: string) {
  return `${slug.slice(0, 33).replace(/-+$/g, '')}-${randomBytes(3).toString('hex')}`;
}

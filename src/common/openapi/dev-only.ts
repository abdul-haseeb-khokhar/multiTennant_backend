/**
 * Spread into an `@ApiProperty*` option object to mark a response field as DEVELOPMENT ONLY in the
 * OpenAPI document (`x-dev-only: true`), so a generated client can tell it from a real field. Such
 * fields (emailed links) exist only when the server runs with `MAIL_MODE=link`, which production
 * refuses.
 */
export const DEV_ONLY = { 'x-dev-only': true } as object;

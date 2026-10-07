/**
 * Stable machine-readable error codes (F5). The frontend translates these through
 * `errors.<code>` (H7), so never rename one: add a new code instead.
 */
export const ErrorCode = {
  // generic, derived from the HTTP status when no specific code applies
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  // authentication / authorisation
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  OWNER_REQUIRED: 'OWNER_REQUIRED',

  // resources
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  CUSTOMER_NOT_FOUND: 'CUSTOMER_NOT_FOUND',

  // conflicts
  SLUG_TAKEN: 'SLUG_TAKEN',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  EXTERNAL_ID_TAKEN: 'EXTERNAL_ID_TAKEN',
  LAST_OWNER: 'LAST_OWNER',
  TENANT_HAS_DEPENDENCIES: 'TENANT_HAS_DEPENDENCIES',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { AuditInterceptor } from './audit.interceptor';

export const AUDIT_KEY = 'audit';

export interface AuditOptions {
  /** What the action was done to (`user`, `invite`, ...). */
  targetType?: string;
  /**
   * What to keep from the handler's return value: `after` (default) stores it as the new state,
   * `before` as the old state (use it for deletes, which return the removed row), `none` nothing.
   * Secret-looking keys are always stripped.
   */
  snapshot?: 'after' | 'before' | 'none';
}

export interface AuditMetadata extends AuditOptions {
  action: string;
}

/**
 * Records an audit entry after the handler succeeds, for example
 * `@Audit('user.deleted', { targetType: 'user', snapshot: 'before' })`. The tenant and actor come
 * from the authenticated request and the target id from the `:id` route param (or the returned
 * `id`). For richer entries (before and after in one entry) call `AuditService.record` from the
 * service instead.
 */
export const Audit = (action: string, options: AuditOptions = {}) =>
  applyDecorators(
    SetMetadata(AUDIT_KEY, { action, ...options } satisfies AuditMetadata),
    UseInterceptors(AuditInterceptor),
  );

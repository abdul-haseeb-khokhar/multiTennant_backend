import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, mergeMap } from 'rxjs';
import type { AuthUser } from '../auth/roles';
import { AUDIT_KEY, AuditMetadata } from './audit.decorator';
import { AuditService } from './audit.service';

/**
 * Writes the audit entry for handlers marked with `@Audit(...)`, after they succeed. A failure to
 * write is logged but does not turn a completed action into an error response; actions where the
 * trail must not have gaps should use `AuditService.record` inside their transaction instead.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.get<AuditMetadata | undefined>(
      AUDIT_KEY,
      context.getHandler(),
    );
    if (!metadata) {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest();

    return next.handle().pipe(
      mergeMap(async (result: unknown) => {
        const user = request.user as AuthUser | undefined;
        const tenantId = user?.tenantId ?? request.params?.tenantId;
        if (tenantId) {
          const snapshot = metadata.snapshot ?? 'after';
          try {
            await this.audit.record({
              tenantId,
              actor: { userId: user?.userId, role: user?.role },
              action: metadata.action,
              targetType: metadata.targetType,
              targetId:
                request.params?.id ??
                (result as { id?: string } | undefined)?.id,
              before: snapshot === 'before' ? result : undefined,
              after: snapshot === 'after' ? result : undefined,
            });
          } catch (error) {
            this.logger.error({
              message: 'audit entry could not be written',
              action: metadata.action,
              error: error instanceof Error ? error.message : 'unknown error',
            });
          }
        }
        return result;
      }),
    );
  }
}

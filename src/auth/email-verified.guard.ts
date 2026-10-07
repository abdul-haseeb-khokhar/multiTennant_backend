import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import type { AuthUser } from './roles';

/**
 * Use after `JwtAuthGuard`: refuses a user who has not confirmed their email (H4). Put it on
 * routes an unverified owner may not use: inviting staff today, moving to a paid plan once that
 * route exists (Phase 5).
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user as
      AuthUser | undefined;
    if (!user?.emailVerified) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.EMAIL_NOT_VERIFIED,
        'Verify your email address first',
      );
    }
    return true;
  }
}

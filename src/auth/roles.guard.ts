import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { AuthUser, Role, ROLES_KEY } from './roles';

/** Use after `JwtAuthGuard`: lets the request through only if the user's role is listed in `@Roles`. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    const user = context.switchToHttp().getRequest().user as
      AuthUser | undefined;

    if (!allowed?.length || !user || !allowed.includes(user.role)) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.INSUFFICIENT_ROLE,
        'Your role does not allow this action',
      );
    }
    return true;
  }
}

import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from './roles';

/** The authenticated staff member, as set by `JwtStrategy.validate`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser =>
    context.switchToHttp().getRequest().user,
);

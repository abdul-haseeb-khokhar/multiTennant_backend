import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { PlatformUser } from './platform-jwt.strategy';

/** The authenticated platform admin, as set by `PlatformJwtStrategy.validate`. */
export const CurrentPlatformAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PlatformUser =>
    context.switchToHttp().getRequest().user,
);

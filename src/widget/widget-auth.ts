import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { WidgetClaims } from './widget-token.service';

/** What `WidgetAuthGuard` puts on the request: the verified claims plus the checked origin. */
export interface WidgetAuth extends WidgetClaims {
  origin: string;
}

export const CurrentWidget = createParamDecorator(
  (_data: unknown, context: ExecutionContext): WidgetAuth =>
    context.switchToHttp().getRequest().widget,
);

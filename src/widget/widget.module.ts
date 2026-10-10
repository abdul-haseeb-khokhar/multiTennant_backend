import { Module } from '@nestjs/common';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { BillingCoreModule } from '../billing/billing-core.module';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { I18nModule } from '../i18n/i18n.module';
import { UsageModule } from '../usage/usage.module';
import { WidgetAuthGuard } from './widget-auth.guard';
import { WidgetCorsService } from './widget-cors.service';
import { WidgetMessagesService } from './widget-messages.service';
import { WidgetRateLimitService } from './widget-rate-limit.service';
import { WidgetSessionsService } from './widget-sessions.service';
import {
  DefaultWidgetSettingsProvider,
  WidgetSettingsProvider,
  WidgetTextService,
} from './widget-text.service';
import { WidgetTokenService } from './widget-token.service';
import { WidgetController } from './widget.controller';
import { DEFAULT_WIDGET_LIMITS, WIDGET_LIMITS } from './widget.constants';

/**
 * The gateway for the embedded chat widget (Phase 3). The engine (`EngineModule`, global) is
 * reached only through `EngineClient`. Widget tokens are signed with a secret derived from
 * `JWT_SECRET` (see `WidgetTokenService`), so the staff and platform guards cannot accept them.
 */
@Module({
  imports: [ApiKeysModule, BillingCoreModule, UsageModule, I18nModule],
  controllers: [WidgetController],
  providers: [
    // Its own limiter instance: the widget's counters are separate from the password-reset ones.
    RateLimiter,
    { provide: WIDGET_LIMITS, useValue: DEFAULT_WIDGET_LIMITS },
    {
      provide: WidgetSettingsProvider,
      useClass: DefaultWidgetSettingsProvider,
    },
    WidgetRateLimitService,
    WidgetTokenService,
    WidgetTextService,
    WidgetSessionsService,
    WidgetMessagesService,
    WidgetAuthGuard,
    WidgetCorsService,
  ],
  exports: [WidgetCorsService],
})
export class WidgetModule {}

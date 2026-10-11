import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { BillingCoreModule } from '../billing/billing-core.module';
import { EngineClient } from '../engine/engine-client';
import { MockEngineClient } from '../engine/mock-engine.client';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { RealtimeCoreModule } from '../realtime/realtime-core.module';
import { UsageModule } from '../usage/usage.module';
import { EngineEventsAuthGuard } from './engine-events-auth.guard';
import { EngineEventsController } from './engine-events.controller';
import { EngineEventsService } from './engine-events.service';

/**
 * The event receiver (D5, Phase 4). With the real engine events arrive over HTTP; with the mock
 * engine (`ENGINE_MODE=mock`) the mock hands them to the very same `EngineEventsService` in
 * process, so the dashboard, the notifications and the widget stream can be driven without it.
 */
@Module({
  imports: [
    BillingCoreModule,
    NotificationsCoreModule,
    RealtimeCoreModule,
    UsageModule,
  ],
  controllers: [EngineEventsController],
  providers: [EngineEventsService, EngineEventsAuthGuard],
  exports: [EngineEventsService],
})
export class EngineEventsModule implements OnModuleInit {
  private readonly logger = new Logger(EngineEventsModule.name);

  constructor(
    private readonly engine: EngineClient,
    private readonly events: EngineEventsService,
  ) {}

  onModuleInit() {
    if (!(this.engine instanceof MockEngineClient)) return;
    this.engine.setEventSink(async (envelope) => {
      try {
        await this.events.ingest(envelope);
      } catch (error) {
        // A delivery problem must never break the engine call that produced the event.
        this.logger.warn({
          message: 'The mock engine event could not be applied',
          eventType: envelope.type,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    });
  }
}

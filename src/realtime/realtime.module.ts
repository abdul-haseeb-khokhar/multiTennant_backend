import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingCoreModule } from '../billing/billing-core.module';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { RealtimeCoreModule } from './realtime-core.module';
import { StaffEventsController } from './staff-events.controller';
import { StaffStreamGuard } from './staff-stream.guard';
import { StreamTicketService } from './stream-ticket.service';

/** The dashboard event stream and its tickets (D5). The hub itself is `RealtimeCoreModule`. `PrismaModule` is global. */
@Module({
  imports: [AuthModule, BillingCoreModule, RealtimeCoreModule],
  controllers: [StaffEventsController],
  providers: [
    StreamTicketService,
    StaffStreamGuard,
    // Its own limiter instance: the ticket counters are separate from the other limits.
    RateLimiter,
  ],
  exports: [StreamTicketService, RealtimeCoreModule],
})
export class RealtimeModule {}

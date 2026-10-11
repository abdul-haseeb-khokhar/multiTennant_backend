import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingCoreModule } from '../billing/billing-core.module';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { MailModule } from '../mail/mail.module';
import { InviteAcceptController } from './invite-accept.controller';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';

@Module({
  imports: [AuthModule, MailModule, BillingCoreModule],
  controllers: [InvitesController, InviteAcceptController],
  // Its own limiter instance: the preview's counters are separate from the other limits.
  providers: [InvitesService, RateLimiter],
})
export class InvitesModule {}

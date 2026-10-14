import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { MailModule } from '../mail/mail.module';
import { AdminSubscriptionController } from './admin/admin-subscription.controller';
import { ManualBillingService } from './admin/manual-billing.service';
import { BillingCoreModule } from './billing-core.module';
import { PlansController } from './plans/plans.controller';
import { TenantBillingController } from './tenant/tenant-billing.controller';
import { AdminUpgradeRequestsController } from './upgrade/admin-upgrade-requests.controller';
import { TenantUpgradeRequestController } from './upgrade/tenant-upgrade-request.controller';
import { UpgradeRequestsService } from './upgrade/upgrade-requests.service';

/** Billing HTTP API: public price list, the owner's billing view, and the platform admin's manual billing. */
@Module({
  imports: [AuthModule, BillingCoreModule, MailModule],
  controllers: [
    PlansController,
    TenantBillingController,
    AdminSubscriptionController,
    TenantUpgradeRequestController,
    AdminUpgradeRequestsController,
  ],
  providers: [ManualBillingService, UpgradeRequestsService, RateLimiter],
})
export class BillingModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminSubscriptionController } from './admin/admin-subscription.controller';
import { ManualBillingService } from './admin/manual-billing.service';
import { BillingCoreModule } from './billing-core.module';
import { PlansController } from './plans/plans.controller';
import { TenantBillingController } from './tenant/tenant-billing.controller';

/** Billing HTTP API: public price list, the owner's billing view, and the platform admin's manual billing. */
@Module({
  imports: [AuthModule, BillingCoreModule],
  controllers: [
    PlansController,
    TenantBillingController,
    AdminSubscriptionController,
  ],
  providers: [ManualBillingService],
})
export class BillingModule {}

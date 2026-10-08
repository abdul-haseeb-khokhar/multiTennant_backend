import { Module } from '@nestjs/common';
import { BillingScheduler } from './billing.scheduler';
import { Clock, SystemClock } from './clock';
import { EntitlementsService } from './entitlements/entitlements.service';
import {
  DefaultUsageProvider,
  UsageProvider,
} from './entitlements/usage.provider';
import { PlansService } from './plans/plans.service';
import { BillingProviders } from './providers/billing-providers';
import { ManualProvider } from './providers/manual.provider';
import { InvoiceNumberService } from './subscriptions/invoice-number.service';
import { SubscriptionService } from './subscriptions/subscription.service';
import { TenantBillingService } from './tenant/tenant-billing.service';

/**
 * The billing services other modules depend on (signup, invites, users, /me, tenants). No
 * controllers and no auth imports, so `AuthModule` can import it without a cycle; the HTTP side
 * is `BillingModule`. `PrismaModule`, `AuditModule` and `ConfigModule` are global.
 *
 * To add a payment provider: implement `BillingProvider`, add it here and in `BillingProviders`.
 */
@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: UsageProvider, useClass: DefaultUsageProvider },
    InvoiceNumberService,
    SubscriptionService,
    EntitlementsService,
    PlansService,
    ManualProvider,
    BillingProviders,
    TenantBillingService,
    BillingScheduler,
  ],
  exports: [
    Clock,
    SubscriptionService,
    EntitlementsService,
    PlansService,
    BillingProviders,
    ManualProvider,
    TenantBillingService,
  ],
})
export class BillingCoreModule {}

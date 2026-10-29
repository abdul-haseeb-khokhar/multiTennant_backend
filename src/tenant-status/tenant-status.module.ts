import { Module } from '@nestjs/common';
import { BillingCoreModule } from '../billing/billing-core.module';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { InternalTenantStatusController } from './internal-tenant-status.controller';
import { TenantStatusService } from './tenant-status.service';

/**
 * The tenant status check the engine asks before it serves a call (his B1, Phase 5B-2):
 * `GET /internal/tenants/{tenantId}/status`. The service is exported so the mock engine's simulated
 * call consults the very same code the route runs.
 */
@Module({
  imports: [BillingCoreModule],
  controllers: [InternalTenantStatusController],
  providers: [TenantStatusService, RateLimiter, InternalTokenGuard],
  exports: [TenantStatusService],
})
export class TenantStatusModule {}

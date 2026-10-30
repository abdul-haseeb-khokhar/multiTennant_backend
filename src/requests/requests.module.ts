import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { InternalCustomersController } from './internal-customers.controller';
import { InternalRequestsController } from './internal-requests.controller';
import { RequestsController } from './requests.controller';
import { RequestsCoreModule } from './requests-core.module';
import { RequestsService } from './requests.service';

/**
 * Requests (Phase 5B-2, his B4): what the AI takes on a call and staff confirm. The staff routes
 * under `/v1/tenants/:tenantId/requests` and the engine's routes under
 * `/internal/tenants/{tenantId}/requests` and `…/customers/by-phone`.
 */
@Module({
  imports: [AuthModule, RequestsCoreModule],
  controllers: [
    RequestsController,
    InternalRequestsController,
    InternalCustomersController,
  ],
  providers: [RequestsService, RateLimiter, InternalTokenGuard],
})
export class RequestsModule {}

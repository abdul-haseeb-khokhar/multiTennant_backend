import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { enforceInternalLimit } from '../internal/internal-rate-limit';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { TenantStatusService } from './tenant-status.service';

/** Status checks per tenant and minute: the engine asks once per call and may keep the answer a few seconds. */
export const STATUS_CHECKS_PER_MINUTE = 1200;
/** The engine may keep an answer this long (a short window, so a suspension is felt quickly). */
export const STATUS_MAX_AGE_SECONDS = 10;

/**
 * `GET /internal/tenants/{tenantId}/status?agentId=`: may this business and agent be served right now
 * (his B1)? Service to service, OUTSIDE `/v1` (see `configureApp`), not in the public OpenAPI, private
 * network only; the contract is `docs/contracts/backend-internal.openapi.yaml`. The tenant is the
 * path segment and the agent is looked up under it. An unknown tenant is a normal 200
 * (`unknown_tenant`). Nothing personal is read or logged.
 */
@ApiExcludeController()
@Controller('internal/tenants/:tenantId/status')
@UseGuards(InternalTokenGuard)
export class InternalTenantStatusController {
  constructor(
    private readonly status: TenantStatusService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async get(
    @Param('tenantId') tenantId: string,
    @Query('agentId') agentId: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    enforceInternalLimit(
      this.limiter,
      `status:${tenantId}`,
      STATUS_CHECKS_PER_MINUTE,
    );
    if (agentId !== undefined && typeof agentId !== 'string') {
      throw new ApiException(
        400,
        ErrorCode.VALIDATION_ERROR,
        'agentId must be a single value',
      );
    }
    response.setHeader(
      'Cache-Control',
      `private, max-age=${STATUS_MAX_AGE_SECONDS}`,
    );
    return this.status.check(tenantId, agentId || undefined);
  }
}

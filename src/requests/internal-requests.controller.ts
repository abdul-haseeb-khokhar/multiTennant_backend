import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { enforceInternalLimit } from '../internal/internal-rate-limit';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { CreateRequestDto } from './dto/create-request.dto';
import {
  UpdateRequestDetailsDto,
  WithdrawRequestDto,
} from './dto/update-request-details.dto';
import { InternalRequestsService } from './internal-requests.service';
import { INTERNAL_WRITES_PER_MINUTE } from './requests.constants';

/**
 * The routes the AI engine calls to save and correct what it took on a call (his B4, Phase 5B-2):
 * `POST /internal/tenants/{tenantId}/requests` (201, or 200 `created: false` for a repeated
 * `submissionKey`), `PATCH …/requests/{reference}` and `POST …/requests/{reference}/withdraw`.
 * Service to service, OUTSIDE `/v1` (see `configureApp`), not in the public OpenAPI, private network
 * only; the contract is `docs/contracts/backend-internal.openapi.yaml`. Errors have the backend's
 * `{statusCode, code, message}` shape (the engine's own are `{error}`). Request contents are never
 * logged.
 */
@ApiExcludeController()
@Controller('internal/tenants/:tenantId/requests')
@UseGuards(InternalTokenGuard)
export class InternalRequestsController {
  constructor(
    private readonly requests: InternalRequestsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Post()
  async create(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateRequestDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.limit(tenantId);
    const saved = await this.requests.create(tenantId, dto);
    response.status(saved.created ? HttpStatus.CREATED : HttpStatus.OK);
    return saved;
  }

  @Patch(':reference')
  update(
    @Param('tenantId') tenantId: string,
    @Param('reference') reference: string,
    @Body() dto: UpdateRequestDetailsDto,
  ) {
    this.limit(tenantId);
    return this.requests.updateDetails(tenantId, normalise(reference), dto);
  }

  @Post(':reference/withdraw')
  @HttpCode(HttpStatus.OK)
  withdraw(
    @Param('tenantId') tenantId: string,
    @Param('reference') reference: string,
    @Body() dto: WithdrawRequestDto,
  ) {
    this.limit(tenantId);
    return this.requests.withdraw(tenantId, normalise(reference), dto);
  }

  private limit(tenantId: string) {
    enforceInternalLimit(
      this.limiter,
      `requests:${tenantId}`,
      INTERNAL_WRITES_PER_MINUTE,
    );
  }
}

/** A reference is stored trimmed and upper case; the engine may read it back in any case. */
function normalise(reference: string): string {
  return reference.trim().toUpperCase();
}

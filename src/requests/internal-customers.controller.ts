import {
  Body,
  Controller,
  HttpStatus,
  Param,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { PhoneCustomersService } from '../end-customers/phone-customers.service';
import { enforceInternalLimit } from '../internal/internal-rate-limit';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { UpsertCustomerByPhoneDto } from './dto/upsert-customer.dto';
import { INTERNAL_WRITES_PER_MINUTE } from './requests.constants';

/**
 * `PUT /internal/tenants/{tenantId}/customers/by-phone` (his B4, L4.3, M3.7): the backend creates the
 * end customers of callers. The caller's number is personal data (F1): it travels in the body, never
 * in the URL, and is never logged. Service to service, outside `/v1`, not in the public OpenAPI.
 * The agent (if named) must belong to the tenant: 404 `AGENT_NOT_FOUND` otherwise.
 */
@ApiExcludeController()
@Controller('internal/tenants/:tenantId/customers/by-phone')
@UseGuards(InternalTokenGuard)
export class InternalCustomersController {
  constructor(
    private readonly customers: PhoneCustomersService,
    private readonly limiter: RateLimiter,
  ) {}

  @Put()
  async upsert(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpsertCustomerByPhoneDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    enforceInternalLimit(
      this.limiter,
      `customers:${tenantId}`,
      INTERNAL_WRITES_PER_MINUTE,
    );
    const customer = await this.customers.upsertForCall(tenantId, {
      agentId: dto.agentId,
      phone: dto.phone,
      name: dto.name,
      locale: dto.locale,
    });
    response.status(customer.created ? HttpStatus.CREATED : HttpStatus.OK);
    return customer;
  }
}

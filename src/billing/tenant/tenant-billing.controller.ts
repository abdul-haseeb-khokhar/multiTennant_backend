import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { Roles } from '../../auth/roles';
import { RolesGuard } from '../../auth/roles.guard';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { TenantBilling } from '../entities/billing.entities';
import { TenantBillingService } from './tenant-billing.service';

@ApiTags('billing')
@ApiBearerAuth()
@Controller('tenants/:tenantId/billing')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantBillingController {
  constructor(private readonly billing: TenantBillingService) {}

  @Get()
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'Current plan, status, period, limits and invoices (owner/admin)',
    description:
      'Agents cannot read billing (403 INSUFFICIENT_ROLE). `skip` / `take` page the invoice list, newest first. Usage against the limits is not reported yet (the counters arrive with the gateway, Phase 3).',
  })
  @ApiOkResponse({ type: TenantBilling })
  get(@Param('tenantId') tenantId: string, @Query() query: PaginationQueryDto) {
    return this.billing.getForTenant(tenantId, query);
  }
}

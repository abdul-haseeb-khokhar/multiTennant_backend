import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { Roles } from '../../auth/roles';
import type { AuthUser } from '../../auth/roles';
import { RolesGuard } from '../../auth/roles.guard';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import {
  TenantBilling,
  TenantBillingSettings,
} from '../entities/billing.entities';
import { UpdateBillingSettingsDto } from './dto/update-billing-settings.dto';
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
    summary:
      'Current plan, status, period, limits, call-minute and conversation usage and invoices (owner/admin)',
    description:
      'Agents cannot read billing (403 INSUFFICIENT_ROLE). `skip` / `take` page the invoice list, newest first. `usage.callMinutes` (L6) shows the included minutes, the minutes used in the current period and, on plans with a minute price, the extra minutes and their amount in minor units; `usage.conversations` does the same for chat conversations (J6, chat is halted). `subscription.overage` carries the setting and both prices.',
  })
  @ApiOkResponse({ type: TenantBilling })
  get(@Param('tenantId') tenantId: string, @Query() query: PaginationQueryDto) {
    return this.billing.getForTenant(tenantId, query);
  }

  @Patch('settings')
  @Roles('owner')
  @ApiOperation({
    summary: 'Switch overage on or off (owner only)',
    description:
      'On plans with an overage price (Pro) the owner chooses what happens after the included call minutes (and chat conversations): `overageEnabled: true` (default) keeps the service going and bills each extra minute (or conversation) at the plan price, `false` is a hard stop (the engine status check answers `quota_exceeded`; chat customers get the fallback and the conversation goes to a human). One switch for both units. Audited as `billing.overage_changed`. Admins and agents get 403 INSUFFICIENT_ROLE; a plan without an overage price answers 409 OVERAGE_NOT_AVAILABLE. Other instances apply the change within 30 seconds.',
  })
  @ApiOkResponse({ type: TenantBillingSettings })
  @ApiConflictResponse({
    description: 'OVERAGE_NOT_AVAILABLE: the plan has no overage price',
  })
  updateSettings(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateBillingSettingsDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.billing.updateSettings(tenantId, actor, dto);
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPlatformAdmin } from '../../auth/current-platform-admin.decorator';
import { PlatformJwtAuthGuard } from '../../auth/platform-jwt-auth.guard';
import type { PlatformUser } from '../../auth/platform-jwt.strategy';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import {
  AdminTenantBilling,
  SubscriptionCommandResult,
} from '../entities/billing.entities';
import { TenantBillingService } from '../tenant/tenant-billing.service';
import {
  ActivateSubscriptionDto,
  CancelSubscriptionDto,
  ChangePlanDto,
  ExtendSubscriptionDto,
  RecordPaymentDto,
} from './dto/subscription-commands.dto';
import { ManualBillingService } from './manual-billing.service';

/**
 * Manual billing for platform admins (I6). Every command writes an audit entry and, for payments,
 * an invoice. 409 INVALID_SUBSCRIPTION_STATE when the current state cannot take the command
 * (for example cancelling a Free plan, or any change while the tenant is suspended or closed).
 */
@ApiTags('platform-admin')
@ApiBearerAuth()
@Controller('admin/tenants/:id/subscription')
@UseGuards(PlatformJwtAuthGuard)
export class AdminSubscriptionController {
  constructor(
    private readonly billing: TenantBillingService,
    private readonly manual: ManualBillingService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "A tenant's subscription, invoices and billing event log",
    description: '`skip` / `take` apply to both lists, newest first.',
  })
  @ApiOkResponse({ type: AdminTenantBilling })
  get(@Param('id') id: string, @Query() query: PaginationQueryDto) {
    return this.billing.getForAdmin(id, query);
  }

  @Post('activate')
  @ApiOperation({
    summary: 'Activate a paid plan after a payment (creates a paid invoice)',
    description:
      'Moves Starter/Free (or another plan) to `planCode`, starting now, until `periodEnd` or one `interval`. Use `record-payment` for a renewal of the current plan.',
  })
  @ApiCreatedResponse({ type: SubscriptionCommandResult })
  activate(
    @Param('id') id: string,
    @Body() dto: ActivateSubscriptionDto,
    @CurrentPlatformAdmin() admin: PlatformUser,
  ) {
    return this.manual.activate(id, admin.adminId, dto);
  }

  @Post('record-payment')
  @ApiOperation({
    summary:
      'Record a renewal payment of the current paid plan (creates a paid invoice)',
    description:
      'The new period starts when the current one ends (or now when it already ended) and lasts one `interval` or until `periodEnd`. A renewal also clears a pending cancellation and a past-due state.',
  })
  @ApiCreatedResponse({ type: SubscriptionCommandResult })
  recordPayment(
    @Param('id') id: string,
    @Body() dto: RecordPaymentDto,
    @CurrentPlatformAdmin() admin: PlatformUser,
  ) {
    return this.manual.recordPayment(id, admin.adminId, dto);
  }

  @Post('extend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Extend the current period (for example Starter), no invoice',
    description: 'Send `until` or `days`.',
  })
  @ApiOkResponse({ type: SubscriptionCommandResult })
  extend(
    @Param('id') id: string,
    @Body() dto: ExtendSubscriptionDto,
    @CurrentPlatformAdmin() admin: PlatformUser,
  ) {
    return this.manual.extend(id, admin.adminId, dto);
  }

  @Post('change-plan')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Change the plan without a payment (upgrade, downgrade, comp), no invoice',
  })
  @ApiOkResponse({ type: SubscriptionCommandResult })
  changePlan(
    @Param('id') id: string,
    @Body() dto: ChangePlanDto,
    @CurrentPlatformAdmin() admin: PlatformUser,
  ) {
    return this.manual.changePlan(id, admin.adminId, dto);
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a paid plan',
    description:
      'By default the plan is kept until the period ends (`status: canceled`) and then falls back to Free; `atPeriodEnd: false` falls back now.',
  })
  @ApiOkResponse({ type: SubscriptionCommandResult })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelSubscriptionDto,
    @CurrentPlatformAdmin() admin: PlatformUser,
  ) {
    return this.manual.cancel(id, admin.adminId, dto);
  }
}

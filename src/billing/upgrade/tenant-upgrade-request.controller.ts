import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../../auth/email-verified.guard';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { Roles } from '../../auth/roles';
import type { AuthUser } from '../../auth/roles';
import { RolesGuard } from '../../auth/roles.guard';
import { CreateUpgradeRequestDto } from './dto/upgrade-request.dto';
import {
  LatestUpgradeRequest,
  UpgradeRequestCreated,
} from './upgrade-request.entities';
import { UpgradeRequestsService } from './upgrade-requests.service';

/** The owner asks for a plan while payments are manual (J5). */
@ApiTags('billing')
@ApiBearerAuth()
@Controller('tenants/:tenantId/billing/upgrade-request')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantUpgradeRequestController {
  constructor(private readonly requests: UpgradeRequestsService) {}

  @Post()
  @UseGuards(EmailVerifiedGuard)
  @Roles('owner')
  @ApiOperation({
    summary:
      'Ask the platform team to move the workspace to another plan (owner only)',
    description:
      'The plan must be a public plan (GET /v1/plans) different from the current one (404 `PLAN_NOT_FOUND`, 409 `ALREADY_ON_PLAN`). A workspace has at most one pending request: asking again while one is pending REPLACES its plan and note (`replacedPending: true`). A platform admin is emailed (`notification`), activates the plan through the subscription routes and marks the request handled. Needs a verified email (403 `EMAIL_NOT_VERIFIED`); limited to 5 per hour (429). Audited as `upgrade.requested`.',
  })
  @ApiCreatedResponse({ type: UpgradeRequestCreated })
  @ApiConflictResponse({ description: '`ALREADY_ON_PLAN`' })
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateUpgradeRequestDto) {
    return this.requests.request(actor, dto);
  }

  @Get()
  @Roles('owner', 'admin')
  @ApiOperation({
    summary:
      "The workspace's latest upgrade request, as { request } (null if none)",
    description:
      'Any status, so the billing screen can show "request sent" or what the platform team answered.',
  })
  @ApiOkResponse({ type: LatestUpgradeRequest })
  latest(@CurrentUser() actor: AuthUser) {
    return this.requests.latest(actor.tenantId);
  }
}

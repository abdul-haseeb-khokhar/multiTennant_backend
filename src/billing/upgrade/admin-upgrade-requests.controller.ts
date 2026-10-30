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
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPlatformAdmin } from '../../auth/current-platform-admin.decorator';
import { PlatformJwtAuthGuard } from '../../auth/platform-jwt-auth.guard';
import type { PlatformUser } from '../../auth/platform-jwt.strategy';
import { ApiPaginatedResponse } from '../../common/pagination/api-paginated-response.decorator';
import {
  HandleUpgradeRequestDto,
  QueryUpgradeRequestsDto,
} from './dto/upgrade-request.dto';
import {
  AdminUpgradeRequestView,
  UpgradeRequestView,
} from './upgrade-request.entities';
import { UpgradeRequestsService } from './upgrade-requests.service';

/** Upgrade requests from every tenant, for the platform team (J5). */
@ApiTags('platform-admin')
@ApiBearerAuth()
@Controller('admin/upgrade-requests')
@UseGuards(PlatformJwtAuthGuard)
export class AdminUpgradeRequestsController {
  constructor(private readonly requests: UpgradeRequestsService) {}

  @Get()
  @ApiOperation({
    summary: 'List upgrade requests, newest first',
    description: 'Filter with `status=pending|handled|declined`.',
  })
  @ApiPaginatedResponse(AdminUpgradeRequestView)
  list(@Query() query: QueryUpgradeRequestsDto) {
    return this.requests.list(query);
  }

  @Post(':id/handle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a pending request handled or declined',
    description:
      "Does not change the plan: activate it through `POST /admin/tenants/:id/subscription/activate` or `change-plan`. Audited in the tenant's log as `upgrade.handled`.",
  })
  @ApiOkResponse({ type: UpgradeRequestView })
  @ApiConflictResponse({ description: '`UPGRADE_REQUEST_ALREADY_HANDLED`' })
  handle(
    @Param('id') id: string,
    @Body() dto: HandleUpgradeRequestDto,
    @CurrentPlatformAdmin() admin: PlatformUser,
  ) {
    return this.requests.handle(admin.adminId, id, dto);
  }
}

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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { ChangeRequestStatusDto } from './dto/change-request-status.dto';
import {
  QueryRequestCountsDto,
  QueryRequestDto,
} from './dto/query-request.dto';
import {
  RequestCounts,
  ServiceRequest,
} from './entities/service-request.entity';
import { RequestsService } from './requests.service';

@ApiTags('Requests')
@ApiBearerAuth()
@Controller('tenants/:tenantId/requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get()
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: 'List the requests the AI took on calls (every role)',
    description:
      "Newest first. Filters: `status`, `type`, `agentId` (the tenant's agent that took the call), a date range on when the request was saved (`from`, `to`) and `q` (part of the reference, the customer's name or their phone number). The list leaves out `details`; open one request to read what the caller said. Everyone works the requests: the staff role `agent` too.",
  })
  @ApiPaginatedResponse(ServiceRequest)
  findAll(
    @Param('tenantId') tenantId: string,
    @Query() query: QueryRequestDto,
  ) {
    return this.requests.findAll(tenantId, query);
  }

  @Get('counts')
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: 'How many requests are in each status (every role)',
    description:
      'For a badge such as "3 waiting". Optionally only for one agent (`agentId`).',
  })
  @ApiOkResponse({ type: RequestCounts })
  counts(
    @Param('tenantId') tenantId: string,
    @Query() query: QueryRequestCountsDto,
  ) {
    return this.requests.counts(tenantId, query);
  }

  @Get(':requestId')
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: 'One request with what the caller said (every role)',
    description:
      "Includes `details`, the document the AI collected (its field list is the engine's). A request of another workspace is a 404 REQUEST_NOT_FOUND.",
  })
  @ApiOkResponse({ type: ServiceRequest })
  findOne(
    @Param('tenantId') tenantId: string,
    @Param('requestId') requestId: string,
  ) {
    return this.requests.findOne(tenantId, requestId);
  }

  @Patch(':requestId/status')
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: 'Confirm, complete, cancel or reopen a request (every role)',
    description:
      'The workflow: `requested` -> `confirmed` or `cancelled`; `confirmed` -> `done`, `cancelled` or back to `requested`; `done` -> `confirmed`; `cancelled` -> `requested`. Once a person confirmed it, the AI can no longer change it. 409 REQUEST_TRANSITION_NOT_ALLOWED for a move the workflow does not have; 409 REQUEST_STATUS_CONFLICT (with `details.currentStatus`) when a colleague moved it first, when it is already in that status, or when `expectedStatus` is stale: reload and decide again. Audited as `request.confirmed|done|cancelled|reopened` with ids and statuses only.',
  })
  @ApiOkResponse({ type: ServiceRequest })
  changeStatus(
    @Param('tenantId') tenantId: string,
    @Param('requestId') requestId: string,
    @Body() dto: ChangeRequestStatusDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.requests.changeStatus(tenantId, requestId, dto, actor);
  }
}

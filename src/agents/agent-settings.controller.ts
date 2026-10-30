import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Put,
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
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { PaginationQueryDto } from '../common/pagination/pagination-query.dto';
import { AgentSettingsService } from './agent-settings.service';
import { UpdateAgentSettingsDto } from './dto/update-agent-settings.dto';
import {
  AgentSettingsVersion,
  AgentSettingsVersionSummary,
} from './entities/agent-settings.entity';

/** Version numbers are 32-bit integers in the database. */
const MAX_VERSION = 2_147_483_647;

@ApiTags('Agents')
@ApiBearerAuth()
@Controller('tenants/:tenantId/agents/:agentId/settings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentSettingsController {
  constructor(private readonly settings: AgentSettingsService) {}

  @Get()
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'The current settings of an agent (owner/admin)',
    description:
      "Owner and admin only: the document holds the forwarding contacts' phone numbers; the staff role `agent` gets the agent's name and status from the agents routes. `version` goes back as `expectedVersion` when saving.",
  })
  @ApiOkResponse({ type: AgentSettingsVersion })
  current(
    @Param('tenantId') tenantId: string,
    @Param('agentId') agentId: string,
  ) {
    return this.settings.getCurrent(tenantId, agentId);
  }

  @Put()
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'Save the settings of an agent as a new version (owner/admin)',
    description:
      'Send the keys to change and the `expectedVersion` you read: the keys you send replace those keys, the rest stay. Adds version n+1 and keeps the old ones. 409 AGENT_SETTINGS_VERSION_CONFLICT (with `currentVersion`) if someone saved in between; 400 AGENT_SETTINGS_INVALID with `details: [{ field, code, params? }]` for a structural problem (codes are translated in the `common` namespace as `agent_settings.problem.<code>`). Saving a change that alters nothing returns the current version and adds none. The engine reads the settings at the start of each call, so a new version applies to the next call.',
  })
  @ApiOkResponse({ type: AgentSettingsVersion })
  update(
    @Param('tenantId') tenantId: string,
    @Param('agentId') agentId: string,
    @Body() dto: UpdateAgentSettingsDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.settings.update(tenantId, agentId, dto, actor);
  }

  @Get('versions')
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: "The versions of an agent's settings, newest first (owner/admin)",
    description: 'Version number, who saved it and when; not the documents.',
  })
  @ApiPaginatedResponse(AgentSettingsVersionSummary)
  versions(
    @Param('tenantId') tenantId: string,
    @Param('agentId') agentId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.settings.listVersions(tenantId, agentId, query);
  }

  @Get('versions/:version')
  @Roles('owner', 'admin')
  @ApiOperation({ summary: 'One past version of the settings (owner/admin)' })
  @ApiOkResponse({ type: AgentSettingsVersion })
  version(
    @Param('tenantId') tenantId: string,
    @Param('agentId') agentId: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    if (version < 1 || version > MAX_VERSION) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.AGENT_SETTINGS_VERSION_NOT_FOUND,
        'This version of the settings does not exist',
      );
    }
    return this.settings.getVersion(tenantId, agentId, version);
  }
}

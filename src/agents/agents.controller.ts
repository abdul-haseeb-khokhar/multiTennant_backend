import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
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
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { QueryAgentDto } from './dto/query-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { Agent } from './entities/agent.entity';

@ApiTags('Agents')
@ApiBearerAuth()
@Controller('tenants/:tenantId/agents')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post()
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'Create an agent (owner/admin)',
    description:
      'An agent is the workspace\'s own setup that the AI uses for a call (not the staff role named `agent`). It starts with the default settings (see the settings routes). The plan limits how many agents a workspace has, disabled ones included: 403 PLAN_LIMIT_REACHED with `details: { limit: "agents", used, max }`. The name is unique within the workspace, ignoring case (409 AGENT_NAME_TAKEN).',
  })
  @ApiCreatedResponse({ type: Agent })
  create(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateAgentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.agents.create(tenantId, dto, actor);
  }

  @Get()
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: "List the workspace's agents (every role)",
    description:
      'The default agent first, then in the order they were created. Name, status and the default flag only: the settings are owner/admin only.',
  })
  @ApiPaginatedResponse(Agent)
  findAll(@Param('tenantId') tenantId: string, @Query() query: QueryAgentDto) {
    return this.agents.findAll(tenantId, query);
  }

  @Get(':agentId')
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({ summary: 'One agent (every role)' })
  @ApiOkResponse({ type: Agent })
  findOne(
    @Param('tenantId') tenantId: string,
    @Param('agentId') agentId: string,
  ) {
    return this.agents.findOne(tenantId, agentId);
  }

  @Patch(':agentId')
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'Rename, disable or enable an agent (owner/admin)',
    description:
      'A disabled agent can still be read and edited; callers hear the "not available" message. Disabling an agent that has phone numbers is refused (409 AGENT_HAS_NUMBERS). Changing nothing is a no-op.',
  })
  @ApiOkResponse({ type: Agent })
  update(
    @Param('tenantId') tenantId: string,
    @Param('agentId') agentId: string,
    @Body() dto: UpdateAgentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.agents.update(tenantId, agentId, dto, actor);
  }

  @Delete(':agentId')
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'Delete an agent and its settings (owner/admin)',
    description:
      'The default agent cannot be deleted (409 CANNOT_DELETE_DEFAULT_AGENT) and neither can an agent that has phone numbers (409 AGENT_HAS_NUMBERS). The deleted agent is returned.',
  })
  @ApiOkResponse({ type: Agent })
  remove(
    @Param('tenantId') tenantId: string,
    @Param('agentId') agentId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.agents.remove(tenantId, agentId, actor);
  }
}

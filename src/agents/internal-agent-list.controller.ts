import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { enforceInternalLimit } from '../internal/internal-rate-limit';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { AgentConfigService, EngineAgentSummary } from './agent-config.service';

/** Lists per tenant and minute: the engine reads the list for its screens and call routing, rarely. */
export const AGENT_LISTS_PER_MINUTE = 600;

/**
 * `GET /internal/tenants/{tenantId}/agents`: the tenant's agents for the engine (his B2, Phase 5B-3):
 * `{ agents: [{ agentId, name, status, isDefault }] }`, the default agent first. Service to service, so
 * it lives OUTSIDE `/v1` (see `configureApp`), is not in the public OpenAPI and must only be reachable
 * on the private network; the contract is `docs/contracts/backend-internal.openapi.yaml`. The tenant is
 * the verified path segment (404 `TENANT_NOT_FOUND` for one that does not exist, like the other
 * internal routes). Answered live. It carries names and ids only: no settings, no phone numbers.
 */
@ApiExcludeController()
@Controller('internal/tenants/:tenantId/agents')
@UseGuards(InternalTokenGuard)
export class InternalAgentListController {
  constructor(
    private readonly agents: AgentConfigService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get()
  async list(
    @Param('tenantId') tenantId: string,
  ): Promise<{ agents: EngineAgentSummary[] }> {
    enforceInternalLimit(
      this.limiter,
      `agent-list:${tenantId}`,
      AGENT_LISTS_PER_MINUTE,
    );
    return { agents: await this.agents.listForEngine(tenantId) };
  }
}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingCoreModule } from '../billing/billing-core.module';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { InternalTokenGuard } from '../internal/internal-token.guard';
import { AgentSettingsController } from './agent-settings.controller';
import { AgentSettingsService } from './agent-settings.service';
import { AgentsController } from './agents.controller';
import { AgentsCoreModule } from './agents-core.module';
import { AgentsService } from './agents.service';
import { InternalAgentConfigController } from './internal-agent-config.controller';

/**
 * Agents (L7, Phase 5B-1): the tenant's own setups that the one shared engine uses for a call.
 * Staff routes under `/v1/tenants/:tenantId/agents` and the engine's pull route
 * `GET /internal/tenants/{tenantId}/agents/{agentId}/config`.
 */
@Module({
  imports: [AuthModule, BillingCoreModule, AgentsCoreModule],
  controllers: [
    AgentsController,
    AgentSettingsController,
    InternalAgentConfigController,
  ],
  providers: [
    AgentsService,
    AgentSettingsService,
    RateLimiter,
    InternalTokenGuard,
  ],
  exports: [AgentsService],
})
export class AgentsModule {}

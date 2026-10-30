import { Module, OnModuleInit } from '@nestjs/common';
import { EngineClient } from '../engine/engine-client';
import { MockEngineClient } from '../engine/mock-engine.client';
import { AgentConfigService } from './agent-config.service';
import { AgentNumbersCheck, NoPhoneNumbersYet } from './agent-numbers.check';
import {
  AgentRequestsCheck,
  PrismaAgentRequestsCheck,
} from './agent-requests.check';
import { AgentProvisioningService } from './agent-provisioning.service';
import {
  AgentSettingsValidator,
  StructuralAgentSettingsValidator,
} from './agent-settings.validator';

/**
 * The agent services other modules depend on (signup creates the default agent). No controllers
 * and no auth imports, so `AuthModule` can import it without a cycle; the HTTP side is
 * `AgentsModule`. `PrismaModule` and `AuditModule` are global.
 *
 * With the mock engine (`ENGINE_MODE=mock`) it also hands the mock the SAME `AgentConfigService` the
 * engine's pull route uses, so a simulated call pulls the agent's settings the way the real engine
 * will (L7).
 */
@Module({
  providers: [
    AgentProvisioningService,
    AgentConfigService,
    // Structural checks only. To add the engine's own validation (Q28), provide another
    // `AgentSettingsValidator` here (see the class comment).
    {
      provide: AgentSettingsValidator,
      useClass: StructuralAgentSettingsValidator,
    },
    // Phase 5D replaces this with a count of the phone_numbers rows.
    { provide: AgentNumbersCheck, useClass: NoPhoneNumbersYet },
    // Requests exist since Phase 5B-2: an agent that has any cannot be deleted (it can be disabled).
    { provide: AgentRequestsCheck, useClass: PrismaAgentRequestsCheck },
  ],
  exports: [
    AgentProvisioningService,
    AgentConfigService,
    AgentSettingsValidator,
    AgentNumbersCheck,
    AgentRequestsCheck,
  ],
})
export class AgentsCoreModule implements OnModuleInit {
  constructor(
    private readonly engine: EngineClient,
    private readonly config: AgentConfigService,
  ) {}

  onModuleInit() {
    if (!(this.engine instanceof MockEngineClient)) return;
    this.engine.setAgentConfigSource((tenantId, agentId) =>
      this.config.pullForCall(tenantId, agentId),
    );
  }
}

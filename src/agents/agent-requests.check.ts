import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * "Does this agent have requests?" (Phase 5B-2; decided 2026-10-29). `AgentsService` refuses to DELETE
 * an agent that does (409 `AGENT_HAS_REQUESTS`): its requests are the business's records of what
 * callers asked for and must not vanish with a setup that is no longer wanted. The agent can be
 * DISABLED instead (a disabled agent is still readable, its requests stay on the staff screen).
 *
 * The count carries the tenant AND the agent. Pass `tx` so the check runs in the caller's transaction.
 * The foreign key `requests.agent_id` is RESTRICT, so a request saved at the very same moment still
 * blocks the delete (the service maps the foreign-key error to the same code).
 */
export abstract class AgentRequestsCheck {
  abstract countForAgent(
    tenantId: string,
    agentId: string,
    tx?: unknown,
  ): Promise<number>;
}

@Injectable()
export class PrismaAgentRequestsCheck extends AgentRequestsCheck {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  countForAgent(
    tenantId: string,
    agentId: string,
    tx?: unknown,
  ): Promise<number> {
    const client =
      (tx as Pick<PrismaService, 'customerRequest'> | undefined) ?? this.prisma;
    return client.customerRequest.count({ where: { tenantId, agentId } });
  }
}

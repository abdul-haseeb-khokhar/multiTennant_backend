import { Injectable } from '@nestjs/common';

/**
 * "Does this agent still have phone numbers?" (L7: each number belongs to exactly one agent).
 * `AgentsService` refuses to disable or delete an agent that does (409 `AGENT_HAS_NUMBERS`).
 *
 * Phone numbers arrive in Phase 5D. Until then the table does not exist and the answer is 0.
 * 5D plugs in here: provide a class that counts that tenant's `phone_numbers` rows for the agent
 * (tenant AND agent in the `where`) in `AgentsCoreModule`, and make the `phone_numbers.agent_id`
 * foreign key RESTRICT so a number assigned at the same moment still blocks the delete (the service
 * maps the foreign-key error to the same code). Pass `tx` so the check runs in the caller's
 * transaction.
 */
export abstract class AgentNumbersCheck {
  abstract countForAgent(
    tenantId: string,
    agentId: string,
    tx?: unknown,
  ): Promise<number>;
}

/** No phone numbers exist yet (before Phase 5D). */
@Injectable()
export class NoPhoneNumbersYet extends AgentNumbersCheck {
  countForAgent(): Promise<number> {
    return Promise.resolve(0);
  }
}

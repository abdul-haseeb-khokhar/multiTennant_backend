import { Injectable } from '@nestjs/common';
import { EntitlementsService } from '../billing/entitlements/entitlements.service';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Why a call cannot be served (his B1). `suspended`, `quota_exceeded` and `unknown_tenant` are his
 * words; `agent_disabled` and `unknown_agent` are ours (L7: the engine asks about an agent); `unpaid`
 * is RESERVED: nobody gets it (a tenant that does not renew is served within its plan during the
 * grace period and falls to Free afterwards).
 */
export type StatusReason =
  | 'suspended'
  | 'unpaid'
  | 'quota_exceeded'
  | 'agent_disabled'
  | 'unknown_agent'
  | 'unknown_tenant';

export interface TenantStatusAnswer {
  tenantId: string;
  /** The agent the answer is about (the default agent when none was asked for); null for an unknown tenant or agent. */
  agentId: string | null;
  serviceable: boolean;
  reason: StatusReason | null;
  /** The plan code (`starter`, `free`, `pro`, `enterprise`); null for an unknown tenant. */
  plan: string | null;
  /**
   * True when the call is served only because overage applies: the included call minutes are used up
   * and the owner left overage on, so the extra minutes are billed (rule 10, L6).
   */
  overage: boolean;
}

/** An agent id longer than this cannot exist (ids are UUIDs): answered as unknown without a query. */
const MAX_AGENT_ID_LENGTH = 100;

/**
 * "May this business and agent be served right now?" (his B1, Phase 5B-2), asked by the engine before
 * it serves a call. Derived ONLY through the effective subscription (`EntitlementsService`, which reads
 * `SubscriptionService.getEffective`) and the agent's own status: never from the denormalised
 * `tenants.plan` / `tenants.status` mirrors (rule 10). The answer is live (`fresh`: it skips the 30 s
 * entitlements cache, so a suspension or a used-up allowance shows at once on this instance).
 *
 * Order, so the answer never reveals more than the engine needs:
 *  1. no such tenant -> `unknown_tenant` (200, nothing else about it);
 *  2. suspended, closed (or, impossibly, no subscription: fail closed) -> `suspended`;
 *  3. an agent that is not this tenant's -> `unknown_agent`, the SAME answer as an id that does not
 *     exist (the lookup carries the tenant, so another tenant's agent is never confirmed);
 *  4. a disabled agent -> `agent_disabled`;
 *  5. no voice in the plan, or not one more call minute available (`check('callMinutes')`: within
 *     the allowance, or `past_due` which is served within it but never into overage, or overage on and
 *     the plan prices extra minutes) -> `quota_exceeded`;
 *  6. otherwise serviceable, with `overage: true` when the extra minutes are billed.
 */
@Injectable()
export class TenantStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async check(tenantId: string, agentId?: string): Promise<TenantStatusAnswer> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      return {
        tenantId,
        agentId: null,
        serviceable: false,
        reason: 'unknown_tenant',
        plan: null,
        overage: false,
      };
    }

    // `allowPastDue`: an overdue payment is served within the plan (like chat, I5); only the
    // minute check below decides, and it never lets a past-due tenant run into overage.
    const voice = await this.entitlements.check(tenantId, 'voice', 1, {
      fresh: true,
      allowPastDue: true,
    });
    if (!voice.allowed && voice.code !== ErrorCode.PLAN_FEATURE_UNAVAILABLE) {
      return this.no(tenantId, null, 'suspended', voice.planCode);
    }
    const plan = voice.planCode;

    const agent = await this.findAgent(tenantId, agentId);
    if (!agent) return this.no(tenantId, null, 'unknown_agent', plan);
    if (agent.status === 'disabled') {
      return this.no(tenantId, agent.id, 'agent_disabled', plan);
    }

    // A plan without voice (only possible through an override) has no minutes to give: the closest
    // of his reasons is an empty allowance (open question 1 in the draft contract).
    if (!voice.allowed) {
      return this.no(tenantId, agent.id, 'quota_exceeded', plan);
    }

    const minutes = await this.entitlements.check(tenantId, 'callMinutes');
    if (!minutes.allowed) {
      return this.no(
        tenantId,
        agent.id,
        stateReason(minutes.code) ?? 'quota_exceeded',
        minutes.planCode ?? plan,
      );
    }
    return {
      tenantId,
      agentId: agent.id,
      serviceable: true,
      reason: null,
      plan: minutes.planCode,
      overage: minutes.overage === true,
    };
  }

  private findAgent(tenantId: string, agentId: string | undefined) {
    if (agentId !== undefined && agentId.length > MAX_AGENT_ID_LENGTH) {
      return Promise.resolve(null);
    }
    return this.prisma.agent.findFirst({
      // Tenant AND agent: an agent of another tenant is "not found", like one that does not exist.
      where: agentId
        ? { id: agentId, tenantId }
        : { tenantId, isDefault: true },
      select: { id: true, status: true },
    });
  }

  private no(
    tenantId: string,
    agentId: string | null,
    reason: StatusReason,
    plan: string | null,
  ): TenantStatusAnswer {
    return {
      tenantId,
      agentId,
      serviceable: false,
      reason,
      plan,
      overage: false,
    };
  }
}

/** The entitlement refusals that mean "the account is not in service" rather than "out of minutes". */
function stateReason(code: ErrorCode): StatusReason | null {
  switch (code) {
    case ErrorCode.TENANT_SUSPENDED:
    case ErrorCode.TENANT_CLOSED:
    case ErrorCode.NO_ACTIVE_SUBSCRIPTION:
      return 'suspended';
    default:
      return null;
  }
}

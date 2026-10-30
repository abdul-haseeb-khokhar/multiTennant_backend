import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import {
  buildDefaultSettings,
  defaultAgentName,
} from './agent-settings.defaults';

export interface AgentTenantInfo {
  id: string;
  name: string;
  timezone: string;
  defaultLocale: string;
}

export interface AgentActor {
  userId?: string | null;
  role?: string | null;
}

/** An agent as it leaves the database for the API (no `createdBy`). */
export const AGENT_OMIT = { createdBy: true } as const;

/**
 * Creates an agent together with its first settings version, inside the caller's transaction
 * (L7). The only place that does so: signup creates the tenant's default agent through it, and
 * `AgentsService.create` the others. It does NOT check the plan limit (the default agent of a new
 * tenant must always exist; `AgentsService` asks `EntitlementsService.assertCountAvailable` first).
 * No settings content goes into the audit entry.
 */
@Injectable()
export class AgentProvisioningService {
  constructor(private readonly audit: AuditService) {}

  async provision(
    tx: Prisma.TransactionClient,
    tenant: AgentTenantInfo,
    options: { name?: string; isDefault: boolean; actor?: AgentActor },
  ) {
    const createdBy = options.actor?.userId ?? null;
    const agent = await tx.agent.create({
      data: {
        tenantId: tenant.id,
        name: options.name ?? defaultAgentName(tenant.name),
        isDefault: options.isDefault,
        createdBy,
      },
      omit: AGENT_OMIT,
    });
    await tx.agentSettings.create({
      data: {
        tenantId: tenant.id,
        agentId: agent.id,
        version: 1,
        document: buildDefaultSettings({
          tenantName: tenant.name,
          timezone: tenant.timezone,
          defaultLocale: tenant.defaultLocale,
        }) as unknown as Prisma.InputJsonObject,
        createdBy,
      },
    });
    await this.audit.record(
      {
        tenantId: tenant.id,
        actor: options.actor,
        action: AuditAction.AGENT_CREATED,
        targetType: 'agent',
        targetId: agent.id,
        after: {
          name: agent.name,
          status: agent.status,
          isDefault: agent.isDefault,
        },
      },
      tx,
    );
    return agent;
  }
}

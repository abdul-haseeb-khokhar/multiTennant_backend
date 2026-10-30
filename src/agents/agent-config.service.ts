import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PrismaService } from '../prisma/prisma.service';
import { AgentSettingsDocument } from './agent-settings.defaults';

/** One agent in the list the engine pulls (his `GET /internal/tenants/{tenantId}/agents`). */
export interface EngineAgentSummary {
  agentId: string;
  name: string;
  /** `disabled` is the engine's `archived`: it answers no call but is kept. */
  status: 'active' | 'disabled';
  isDefault: boolean;
}

/** What the engine receives when it pulls an agent's settings at the start of a call (L7). */
export interface PulledAgentConfig {
  tenantId: string;
  agentId: string;
  /** The settings version the `config` is. */
  version: number;
  /** `disabled`: the engine plays the "not available" message and takes no call. */
  status: 'active' | 'disabled';
  config: AgentSettingsDocument;
  /** Changes whenever the body would: the version and the status. */
  etag: string;
}

/**
 * Reads an agent's settings for the engine (L7: the backend owns and versions them, the engine
 * pulls them at call start). The ONE reader behind both `GET /internal/tenants/{tenantId}/agents/
 * {agentId}/config` and the mock engine's simulated call, so a test through the mock proves what the
 * real route returns. Tenant AND agent in every `where`: an agent of another tenant is
 * `AGENT_NOT_FOUND`, indistinguishable from one that does not exist. Never logs the document (it can
 * hold forwarding phone numbers).
 */
@Injectable()
export class AgentConfigService {
  constructor(private readonly prisma: PrismaService) {}

  /** `version` pins a past version (the call ticket names the version it was issued for); default the current one. */
  async pull(
    tenantId: string,
    agentId: string,
    version?: number,
  ): Promise<PulledAgentConfig> {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId },
      select: { id: true, status: true },
    });
    if (!agent) throw this.agentNotFound();
    const settings =
      version === undefined
        ? await this.prisma.agentSettings.findFirst({
            where: { tenantId, agentId },
            orderBy: { version: 'desc' },
          })
        : await this.prisma.agentSettings.findFirst({
            where: { tenantId, agentId, version },
          });
    if (!settings) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.AGENT_SETTINGS_VERSION_NOT_FOUND,
        'This version of the settings does not exist',
      );
    }
    const status = agent.status === 'disabled' ? 'disabled' : 'active';
    return {
      tenantId,
      agentId,
      version: settings.version,
      status,
      config: settings.document as unknown as AgentSettingsDocument,
      etag: etagOf(agentId, settings.version, status),
    };
  }

  /**
   * The tenant's agents for the engine's list route (his B2, Phase 5B-3): the default agent first, then
   * by age. Tenant in the `where`; an unknown tenant is 404 `TENANT_NOT_FOUND` (every tenant has a default
   * agent, so an empty list can only mean "no such tenant", and the engine is told so instead of being
   * handed an empty list it might mistake for "no agents yet").
   */
  async listForEngine(tenantId: string): Promise<EngineAgentSummary[]> {
    const rows = await this.prisma.agent.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, status: true, isDefault: true },
    });
    if (rows.length === 0) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true },
      });
      if (!tenant) {
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          ErrorCode.TENANT_NOT_FOUND,
          'Tenant not found',
        );
      }
    }
    return rows.map((row) => ({
      agentId: row.id,
      name: row.name,
      status: row.status === 'disabled' ? 'disabled' : 'active',
      isDefault: row.isDefault,
    }));
  }

  /** The tenant's default agent id, or null when the tenant has none (cannot happen after the Phase 5B-1 backfill). */
  async defaultAgentId(tenantId: string): Promise<string | null> {
    const agent = await this.prisma.agent.findFirst({
      where: { tenantId, isDefault: true },
      select: { id: true },
    });
    return agent?.id ?? null;
  }

  /** A call without an agent id belongs to the tenant's default agent (the engine is agent-aware from Q28 on; until then it sends none). */
  async pullForCall(
    tenantId: string,
    agentId?: string,
  ): Promise<PulledAgentConfig | null> {
    const id = agentId ?? (await this.defaultAgentId(tenantId));
    return id ? this.pull(tenantId, id) : null;
  }

  private agentNotFound() {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.AGENT_NOT_FOUND,
      'Agent not found',
    );
  }
}

/** A strong ETag over what the body depends on: nothing secret goes into it. */
export function etagOf(
  agentId: string,
  version: number,
  status: string,
): string {
  const digest = createHash('sha256')
    .update(`${agentId}:${version}:${status}`)
    .digest('hex')
    .slice(0, 24);
  return `"${digest}"`;
}

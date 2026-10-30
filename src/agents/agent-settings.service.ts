import { isDeepStrictEqual } from 'node:util';
import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/roles';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { resolvePage, toPage } from '../common/pagination/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { AgentSettingsValidator } from './agent-settings.validator';
import { UpdateAgentSettingsDto } from './dto/update-agent-settings.dto';

interface SettingsRow {
  agentId: string;
  version: number;
  document: Prisma.JsonValue;
  createdBy: string | null;
  createdAt: Date;
}

const summary = (row: Omit<SettingsRow, 'document'>) => ({
  agentId: row.agentId,
  version: row.version,
  createdAt: row.createdAt,
  createdBy: row.createdBy,
});

const full = (row: SettingsRow) => ({
  ...summary(row),
  document: row.document as Record<string, unknown>,
});

/**
 * The settings of an agent, versioned (L7). Owner and admin only at the controller: the document
 * holds forwarding phone numbers. A save adds version n+1 and never edits an older row; the highest
 * version is the current one. The audit entry carries version numbers only. Nothing here logs the
 * document.
 */
@Injectable()
export class AgentSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly validator: AgentSettingsValidator,
  ) {}

  async getCurrent(tenantId: string, agentId: string) {
    await this.assertAgent(tenantId, agentId);
    const row = await this.prisma.agentSettings.findFirst({
      where: { tenantId, agentId },
      orderBy: { version: 'desc' },
    });
    if (!row) throw this.versionNotFound();
    return full(row);
  }

  async listVersions(
    tenantId: string,
    agentId: string,
    query: { skip?: number; take?: number },
  ) {
    await this.assertAgent(tenantId, agentId);
    const page = resolvePage(query);
    const where = { tenantId, agentId };
    const [rows, total] = await Promise.all([
      this.prisma.agentSettings.findMany({
        where,
        skip: page.skip,
        take: page.take,
        orderBy: { version: 'desc' },
        omit: { document: true },
      }),
      this.prisma.agentSettings.count({ where }),
    ]);
    return toPage(rows.map(summary), total, page);
  }

  async getVersion(tenantId: string, agentId: string, version: number) {
    await this.assertAgent(tenantId, agentId);
    const row = await this.prisma.agentSettings.findFirst({
      where: { tenantId, agentId, version },
    });
    if (!row) throw this.versionNotFound();
    return full(row);
  }

  /**
   * Saves `dto.settings` on top of the current document as the next version. `expectedVersion` is
   * the optimistic-concurrency guard: a stale one is 409 `AGENT_SETTINGS_VERSION_CONFLICT`, and so
   * is a save that loses a race for the same version number (the database has a unique key on
   * (agent, version)). A change that leaves the document as it is adds no version and no audit
   * entry (the current version is returned).
   */
  async update(
    tenantId: string,
    agentId: string,
    dto: UpdateAgentSettingsDto,
    actor: AuthUser,
  ) {
    await this.assertAgent(tenantId, agentId);
    const current = await this.prisma.agentSettings.findFirst({
      where: { tenantId, agentId },
      orderBy: { version: 'desc' },
    });
    if (!current) throw this.versionNotFound();
    if (current.version !== dto.expectedVersion) {
      throw this.conflict(current.version);
    }

    const base = current.document as Record<string, unknown>;
    // Outside any transaction: a validator may one day call the engine.
    const checked = await this.validator.validate({ ...base, ...dto.settings });
    if (!checked.ok) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.AGENT_SETTINGS_INVALID,
        'Some of the agent settings are not valid',
        { details: checked.problems },
      );
    }
    if (isDeepStrictEqual(checked.document, base)) return full(current);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.agentSettings.create({
          data: {
            tenantId,
            agentId,
            version: current.version + 1,
            document: checked.document as unknown as Prisma.InputJsonObject,
            createdBy: actor.userId,
          },
        });
        await this.audit.record(
          {
            tenantId,
            actor: { userId: actor.userId, role: actor.role },
            action: AuditAction.AGENT_SETTINGS_UPDATED,
            targetType: 'agent',
            targetId: agentId,
            // Version numbers only: the document holds phone numbers.
            before: { version: current.version },
            after: { version: created.version },
          },
          tx,
        );
        return full(created);
      });
    } catch (error) {
      if (isPrismaError(error, 'P2002')) {
        // Someone saved the same next version first.
        const latest = await this.prisma.agentSettings.findFirst({
          where: { tenantId, agentId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        throw this.conflict(latest?.version ?? current.version + 1);
      }
      if (isPrismaError(error, 'P2003')) {
        // The agent was deleted meanwhile.
        throw this.agentNotFound();
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------------------------

  private async assertAgent(tenantId: string, agentId: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId },
      select: { id: true },
    });
    if (!agent) throw this.agentNotFound();
  }

  private conflict(currentVersion: number) {
    return new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.AGENT_SETTINGS_VERSION_CONFLICT,
      'The settings were changed by someone else; reload the latest version',
      { currentVersion },
    );
  }

  private agentNotFound() {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.AGENT_NOT_FOUND,
      'Agent not found',
    );
  }

  private versionNotFound() {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.AGENT_SETTINGS_VERSION_NOT_FOUND,
      'This version of the settings does not exist',
    );
  }
}

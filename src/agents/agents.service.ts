import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/roles';
import { EntitlementsService } from '../billing/entitlements/entitlements.service';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { resolvePage, toPage } from '../common/pagination/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { AgentNumbersCheck } from './agent-numbers.check';
import { AgentRequestsCheck } from './agent-requests.check';
import {
  AGENT_OMIT,
  AgentProvisioningService,
} from './agent-provisioning.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { QueryAgentDto } from './dto/query-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';

/**
 * The tenant's agents (L7): the identity of each agent (name, status, default flag). Their settings
 * are `AgentSettingsService`. Every query carries `tenantId`, which comes from the verified staff
 * token. Audit entries hold names and status only, never settings.
 */
@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly provisioning: AgentProvisioningService,
    private readonly numbers: AgentNumbersCheck,
    private readonly requests: AgentRequestsCheck,
  ) {}

  async create(tenantId: string, dto: CreateAgentDto, actor: AuthUser) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Takes the subscription row lock and counts the agents (disabled ones too): two
        // simultaneous creations cannot both take the last slot.
        await this.entitlements.assertCountAvailable(tx, tenantId, 'agents');
        const tenant = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { id: true, name: true, timezone: true, defaultLocale: true },
        });
        if (!tenant) throw this.tenantMissing(tenantId);
        return this.provisioning.provision(tx, tenant, {
          name: dto.name,
          isDefault: false,
          actor: { userId: actor.userId, role: actor.role },
        });
      });
    } catch (error) {
      throw this.mapNameConflict(error);
    }
  }

  async findAll(tenantId: string, query: QueryAgentDto) {
    const page = resolvePage(query);
    const where: Prisma.AgentWhereInput = {
      tenantId,
      ...(query.status && { status: query.status }),
    };
    const [data, total] = await Promise.all([
      this.prisma.agent.findMany({
        where,
        skip: page.skip,
        take: page.take,
        // The default agent first, then in the order they were made.
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        omit: AGENT_OMIT,
      }),
      this.prisma.agent.count({ where }),
    ]);
    return toPage(data, total, page);
  }

  async findOne(tenantId: string, id: string) {
    const row = await this.prisma.agent.findFirst({
      where: { id, tenantId },
      omit: AGENT_OMIT,
    });
    if (!row) throw this.notFound();
    return row;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateAgentDto,
    actor: AuthUser,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const before = await tx.agent.findFirst({
          where: { id, tenantId },
          omit: AGENT_OMIT,
        });
        if (!before) throw this.notFound();
        const renamed = dto.name !== undefined && dto.name !== before.name;
        const statusChanged =
          dto.status !== undefined && dto.status !== before.status;
        if (!renamed && !statusChanged) return before;

        if (statusChanged && dto.status === 'disabled') {
          await this.assertNoNumbers(tenantId, id, tx);
        }
        const result = await tx.agent.updateMany({
          where: { id, tenantId },
          data: {
            ...(renamed && { name: dto.name }),
            ...(statusChanged && { status: dto.status }),
          },
        });
        if (result.count === 0) throw this.notFound();
        const after = await tx.agent.findFirstOrThrow({
          where: { id, tenantId },
          omit: AGENT_OMIT,
        });
        const who = { userId: actor.userId, role: actor.role };
        if (renamed) {
          await this.audit.record(
            {
              tenantId,
              actor: who,
              action: AuditAction.AGENT_RENAMED,
              targetType: 'agent',
              targetId: id,
              before: { name: before.name },
              after: { name: after.name },
            },
            tx,
          );
        }
        if (statusChanged) {
          await this.audit.record(
            {
              tenantId,
              actor: who,
              action:
                after.status === 'disabled'
                  ? AuditAction.AGENT_DISABLED
                  : AuditAction.AGENT_ENABLED,
              targetType: 'agent',
              targetId: id,
              before: { status: before.status },
              after: { status: after.status },
            },
            tx,
          );
        }
        return after;
      });
    } catch (error) {
      throw this.mapNameConflict(error);
    }
  }

  async remove(tenantId: string, id: string, actor: AuthUser) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const agent = await tx.agent.findFirst({
          where: { id, tenantId },
          omit: AGENT_OMIT,
        });
        if (!agent) throw this.notFound();
        if (agent.isDefault) {
          throw new ApiException(
            HttpStatus.CONFLICT,
            ErrorCode.CANNOT_DELETE_DEFAULT_AGENT,
            'The default agent cannot be deleted',
          );
        }
        await this.assertNoNumbers(tenantId, id, tx);
        await this.assertNoRequests(tenantId, id, tx);
        // The settings versions go with the agent (cascade).
        const result = await tx.agent.deleteMany({
          where: { id, tenantId, isDefault: false },
        });
        if (result.count === 0) throw this.notFound();
        await this.audit.record(
          {
            tenantId,
            actor: { userId: actor.userId, role: actor.role },
            action: AuditAction.AGENT_DELETED,
            targetType: 'agent',
            targetId: id,
            before: { name: agent.name, status: agent.status },
          },
          tx,
        );
        return agent;
      });
    } catch (error) {
      // Something that references the agent (a request saved at this very moment, or phone numbers
      // from Phase 5D) appeared after the check: say which.
      if (isPrismaError(error, 'P2003')) {
        throw (await this.requests.countForAgent(tenantId, id)) > 0
          ? this.hasRequests()
          : this.hasNumbers();
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------------------------

  private async assertNoNumbers(
    tenantId: string,
    agentId: string,
    tx: Prisma.TransactionClient,
  ) {
    if ((await this.numbers.countForAgent(tenantId, agentId, tx)) > 0) {
      throw this.hasNumbers();
    }
  }

  private async assertNoRequests(
    tenantId: string,
    agentId: string,
    tx: Prisma.TransactionClient,
  ) {
    if ((await this.requests.countForAgent(tenantId, agentId, tx)) > 0) {
      throw this.hasRequests();
    }
  }

  private hasRequests() {
    return new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.AGENT_HAS_REQUESTS,
      'This agent has requests from callers; disable it instead of deleting it',
    );
  }

  private hasNumbers() {
    return new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.AGENT_HAS_NUMBERS,
      'This agent still has phone numbers; move them to another agent first',
    );
  }

  private mapNameConflict(error: unknown): unknown {
    if (isPrismaError(error, 'P2002')) {
      return new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.AGENT_NAME_TAKEN,
        'You already have an agent with this name',
      );
    }
    return error;
  }

  private notFound() {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.AGENT_NOT_FOUND,
      'Agent not found',
    );
  }

  private tenantMissing(tenantId: string) {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.TENANT_NOT_FOUND,
      `Tenant ${tenantId} not found`,
    );
  }
}

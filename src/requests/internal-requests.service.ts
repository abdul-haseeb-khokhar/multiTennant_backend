import { HttpStatus, Injectable } from '@nestjs/common';
import { Notification, Prisma } from '@prisma/client';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRequestDto } from './dto/create-request.dto';
import {
  UpdateRequestDetailsDto,
  WithdrawRequestDto,
} from './dto/update-request-details.dto';
import { RequestsLive, requestSubmittedNotification } from './request-views';
import { MAX_DETAILS_BYTES } from './requests.constants';

/** What the engine gets back for a request. */
export interface RequestResult {
  id: string;
  agentId: string;
  reference: string;
  type: string;
  status: string;
  /** true for the call that saved it, false for a repeat of the same `submissionKey`. */
  created: boolean;
}

const RESULT_SELECT = {
  id: true,
  agentId: true,
  reference: true,
  type: true,
  status: true,
  cancelledBy: true,
  updatedAt: true,
} satisfies Prisma.CustomerRequestSelect;

type ResultRow = Prisma.CustomerRequestGetPayload<{
  select: typeof RESULT_SELECT;
}>;

/**
 * The routes the AI engine calls to save and correct what it took on a call (Phase 5B-2, his B4):
 * create (idempotent), change the details, withdraw. The tenant is the verified path segment and the
 * agent and the customer are looked up UNDER it, so an id of another tenant in a body is a 404, never
 * a way to reach that tenant's rows (the composite foreign keys are the database's second lock).
 *
 * The engine may touch a request ONLY while it is `requested`: both writes are conditional updates
 * (`WHERE … AND status = 'requested'`), so a staff confirmation that lands at the same moment wins and
 * the engine's write is refused with 409 `REQUEST_LOCKED` (his `locked`). The AI never confirms
 * anything (L1). The request's contents are personal data: nothing here logs them, and the notification
 * and the live message carry ids only.
 */
@Injectable()
export class InternalRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly live: RequestsLive,
  ) {}

  async create(
    tenantId: string,
    dto: CreateRequestDto,
  ): Promise<RequestResult> {
    const details = checkedDetails(dto.data);
    await this.assertTenant(tenantId);

    // Idempotent by (tenant, submissionKey): a repeat is the same request, whatever the body says now.
    const repeat = await this.bySubmissionKey(tenantId, dto.submissionKey);
    if (repeat) return result(repeat, false);

    const agent = await this.resolveAgent(tenantId, dto.agentId);
    const customer = await this.prisma.endCustomer.findFirst({
      where: { id: dto.endCustomerId, tenantId },
      select: { id: true },
    });
    if (!customer) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.CUSTOMER_NOT_FOUND,
        'Customer not found',
      );
    }

    let created: { row: ResultRow; notified: Notification[] };
    try {
      created = await this.insert(tenantId, agent, customer.id, dto, details);
    } catch (error) {
      // The agent or the customer was deleted between the lookup and the insert (the composite
      // foreign keys caught it): it does not exist any more, which is what the engine is told.
      if (isPrismaError(error, 'P2003')) {
        throw await this.vanished(tenantId, agent.id);
      }
      if (!isPrismaError(error, 'P2002')) throw error;
      // Two parallel saves of the same call: the other one won, hand back its request ...
      const winner = await this.bySubmissionKey(tenantId, dto.submissionKey);
      if (winner) return result(winner, false);
      // ... otherwise the reference belongs to another request: the engine draws another one.
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.REQUEST_REFERENCE_TAKEN,
        'This reference is already used by another request',
      );
    }

    // After the commit, so nothing is announced that rolled back.
    this.notifications.announce(tenantId, created.notified);
    this.live.created(tenantId, created.row);
    return result(created.row, true);
  }

  async updateDetails(
    tenantId: string,
    reference: string,
    dto: UpdateRequestDetailsDto,
  ): Promise<RequestResult> {
    const details = checkedDetails(dto.data);
    if (
      dto.summary === undefined &&
      dto.scheduledLocal === undefined &&
      details === undefined
    ) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Send at least one of summary, scheduledLocal and data',
      );
    }
    const changed = await this.prisma.customerRequest.updateMany({
      // Conditional on `requested`: once a person acted, the engine may not rewrite what they acted on.
      where: { tenantId, reference, status: 'requested' },
      data: {
        ...(dto.summary !== undefined && { summary: dto.summary }),
        ...(dto.scheduledLocal !== undefined && {
          scheduledLocal: dto.scheduledLocal,
        }),
        ...(details !== undefined && { details }),
      },
    });
    if (changed.count === 0) throw await this.notChanged(tenantId, reference);
    const row = await this.byReference(tenantId, reference);
    if (!row) throw this.notFound();
    this.live.updated(tenantId, row);
    return result(row, false);
  }

  async withdraw(
    tenantId: string,
    reference: string,
    dto: WithdrawRequestDto,
  ): Promise<RequestResult> {
    const changed = await this.prisma.customerRequest.updateMany({
      where: { tenantId, reference, status: 'requested' },
      data: {
        status: 'cancelled',
        cancelledBy: 'caller',
        statusChangedAt: new Date(),
        statusChangedBy: null,
        ...(dto.reason && { note: dto.reason }),
      },
    });
    if (changed.count === 0) {
      const row = await this.byReference(tenantId, reference);
      if (!row) throw this.notFound();
      // Withdrawing twice is harmless; withdrawing what a person already acted on (or cancelled) is not.
      if (row.status === 'cancelled' && row.cancelledBy === 'caller') {
        return result(row, false);
      }
      throw this.locked();
    }
    const row = await this.byReference(tenantId, reference);
    if (!row) throw this.notFound();
    this.live.updated(tenantId, row);
    return result(row, false);
  }

  // ---------------------------------------------------------------------------------------------

  private async insert(
    tenantId: string,
    agent: { id: string; name: string },
    endCustomerId: string,
    dto: CreateRequestDto,
    details: Prisma.InputJsonObject | undefined,
  ): Promise<{ row: ResultRow; notified: Notification[] }> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.customerRequest.create({
        data: {
          tenantId,
          agentId: agent.id,
          endCustomerId,
          reference: dto.reference,
          type: dto.type,
          submissionKey: dto.submissionKey,
          source: 'call',
          channel: dto.channel ?? 'voice',
          conversationId: dto.conversationId ?? null,
          language: dto.language ?? null,
          summary: dto.summary,
          scheduledLocal: dto.scheduledLocal ?? null,
          timezone: dto.timezone ?? null,
          configVersion: dto.configVersion ?? null,
          ...(details !== undefined && { details }),
        },
        select: RESULT_SELECT,
      });
      const recipients = await this.notifications.activeStaffIds(
        tenantId,
        undefined,
        tx,
      );
      const notified = await this.notifications.create(
        tenantId,
        recipients,
        requestSubmittedNotification({
          id: row.id,
          reference: row.reference,
          type: row.type,
          agentId: agent.id,
          agentName: agent.name,
        }),
        tx,
      );
      return { row, notified };
    });
  }

  private async vanished(tenantId: string, agentId: string) {
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, tenantId },
      select: { id: true },
    });
    return agent
      ? new ApiException(
          HttpStatus.NOT_FOUND,
          ErrorCode.CUSTOMER_NOT_FOUND,
          'Customer not found',
        )
      : new ApiException(
          HttpStatus.NOT_FOUND,
          ErrorCode.AGENT_NOT_FOUND,
          'Agent not found',
        );
  }

  private async assertTenant(tenantId: string) {
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

  /** The agent named in the call, or the tenant's default one; always looked up under the tenant. */
  private async resolveAgent(tenantId: string, agentId?: string) {
    const agent = await this.prisma.agent.findFirst({
      where: agentId
        ? { id: agentId, tenantId }
        : { tenantId, isDefault: true },
      select: { id: true, name: true },
    });
    if (!agent) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.AGENT_NOT_FOUND,
        'Agent not found',
      );
    }
    return agent;
  }

  private bySubmissionKey(tenantId: string, submissionKey: string) {
    return this.prisma.customerRequest.findFirst({
      where: { tenantId, submissionKey },
      select: RESULT_SELECT,
    });
  }

  private byReference(tenantId: string, reference: string) {
    return this.prisma.customerRequest.findFirst({
      where: { tenantId, reference },
      select: RESULT_SELECT,
    });
  }

  /** The engine's conditional write matched nothing: no such request, or a person got there first. */
  private async notChanged(tenantId: string, reference: string) {
    const row = await this.byReference(tenantId, reference);
    return row ? this.locked() : this.notFound();
  }

  private locked() {
    return new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.REQUEST_LOCKED,
      'A team member already acted on this request',
    );
  }

  private notFound() {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.REQUEST_NOT_FOUND,
      'Request not found',
    );
  }
}

function result(row: ResultRow, created: boolean): RequestResult {
  return {
    id: row.id,
    agentId: row.agentId,
    reference: row.reference,
    type: row.type,
    status: row.status,
    created,
  };
}

/** The engine's document, size-capped; opaque to the backend. */
function checkedDetails(
  data: Record<string, unknown> | undefined,
): Prisma.InputJsonObject | undefined {
  if (data === undefined) return undefined;
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > MAX_DETAILS_BYTES) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      ErrorCode.VALIDATION_ERROR,
      `data may be at most ${MAX_DETAILS_BYTES} bytes`,
    );
  }
  return data as Prisma.InputJsonObject;
}

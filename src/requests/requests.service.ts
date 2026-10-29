import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditAction, AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/roles';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { resolvePage, toPage } from '../common/pagination/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { ChangeRequestStatusDto } from './dto/change-request-status.dto';
import {
  QueryRequestCountsDto,
  QueryRequestDto,
} from './dto/query-request.dto';
import { RequestCounts } from './entities/service-request.entity';
import {
  REQUEST_DETAIL_SELECT,
  REQUEST_LIST_SELECT,
  RequestsLive,
  toRequestView,
} from './request-views';
import {
  REQUEST_STATUSES,
  RequestStatus,
  evaluateMove,
  isRequestStatus,
  staffActionOf,
} from './state-machine';

const AUDIT_ACTIONS = {
  confirmed: AuditAction.REQUEST_CONFIRMED,
  done: AuditAction.REQUEST_DONE,
  cancelled: AuditAction.REQUEST_CANCELLED,
  reopened: AuditAction.REQUEST_REOPENED,
} as const;

/**
 * The staff side of the requests the AI took on calls (Phase 5B-2, his B4): list, counts, detail and
 * the status moves. EVERY query carries `tenantId`, which comes from the verified staff token; a request
 * id of another tenant is a 404. Every role works requests (decided proposal: the staff role `agent`
 * answers the phone queue too). The workflow is the pure state machine; a move is a conditional update
 * (`WHERE status = the one that was read`) in one transaction with its audit entry, so two people acting
 * at once cannot both win: the loser gets 409 `REQUEST_STATUS_CONFLICT` and nothing changes. Audit
 * entries hold ids and statuses, never the note, the caller's details or their number.
 */
@Injectable()
export class RequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly live: RequestsLive,
  ) {}

  async findAll(tenantId: string, query: QueryRequestDto) {
    const page = resolvePage(query);
    const where = this.listFilter(tenantId, query);
    const [rows, total] = await Promise.all([
      this.prisma.customerRequest.findMany({
        where,
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: REQUEST_LIST_SELECT,
      }),
      this.prisma.customerRequest.count({ where }),
    ]);
    return toPage(rows.map(toRequestView), total, page);
  }

  /** How many requests are in each status (for a badge); optionally for one agent. */
  async counts(
    tenantId: string,
    query: QueryRequestCountsDto,
  ): Promise<RequestCounts> {
    const grouped = await this.prisma.customerRequest.groupBy({
      by: ['status'],
      where: { tenantId, ...(query.agentId && { agentId: query.agentId }) },
      _count: { _all: true },
    });
    const counts: Record<string, number> = Object.fromEntries(
      REQUEST_STATUSES.map((status) => [status, 0]),
    );
    for (const group of grouped) counts[group.status] = group._count._all;
    return {
      requested: counts.requested,
      confirmed: counts.confirmed,
      done: counts.done,
      cancelled: counts.cancelled,
      total: REQUEST_STATUSES.reduce((sum, status) => sum + counts[status], 0),
    };
  }

  async findOne(tenantId: string, id: string) {
    const row = await this.prisma.customerRequest.findFirst({
      where: { id, tenantId },
      select: REQUEST_DETAIL_SELECT,
    });
    if (!row) throw this.notFound();
    return toRequestView(row);
  }

  async changeStatus(
    tenantId: string,
    id: string,
    dto: ChangeRequestStatusDto,
    actor: AuthUser,
  ) {
    const to = dto.status as RequestStatus;
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.customerRequest.findFirst({
        where: { id, tenantId },
        select: { status: true },
      });
      if (!current) throw this.notFound();
      const from = current.status as RequestStatus;

      // The screen was looking at another status: somebody was quicker.
      if (
        dto.expectedStatus !== undefined &&
        isRequestStatus(dto.expectedStatus) &&
        dto.expectedStatus !== from
      ) {
        throw this.conflict(from);
      }
      const verdict = evaluateMove('staff', from, to);
      if (!verdict.ok) {
        throw verdict.reason === 'same'
          ? this.conflict(from)
          : new ApiException(
              HttpStatus.CONFLICT,
              ErrorCode.REQUEST_TRANSITION_NOT_ALLOWED,
              `A ${from} request cannot be moved to ${to}`,
              { details: { currentStatus: from } },
            );
      }

      const now = new Date();
      // Conditional on the status that was read: a colleague who got in between makes this match
      // nothing (under row locking the second writer waits, then finds the status changed).
      const changed = await tx.customerRequest.updateMany({
        where: { id, tenantId, status: from },
        data: {
          status: to,
          statusChangedAt: now,
          statusChangedBy: actor.userId,
          cancelledBy: to === 'cancelled' ? 'staff' : null,
          ...(dto.note !== undefined && { note: dto.note || null }),
        },
      });
      if (changed.count === 0) {
        const latest = await tx.customerRequest.findFirst({
          where: { id, tenantId },
          select: { status: true },
        });
        if (!latest) throw this.notFound();
        throw this.conflict(latest.status);
      }
      await this.audit.record(
        {
          tenantId,
          actor: { userId: actor.userId, role: actor.role },
          action: AUDIT_ACTIONS[staffActionOf(to)],
          targetType: 'request',
          targetId: id,
          before: { status: from },
          after: { status: to },
        },
        tx,
      );
      return tx.customerRequest.findFirstOrThrow({
        where: { id, tenantId },
        select: REQUEST_DETAIL_SELECT,
      });
    });
    this.live.updated(tenantId, result);
    return toRequestView(result);
  }

  // ---------------------------------------------------------------------------------------------

  private listFilter(
    tenantId: string,
    query: QueryRequestDto,
  ): Prisma.CustomerRequestWhereInput {
    const search = query.q?.trim();
    const digits = search?.replace(/[\s()-]/g, '');
    return {
      tenantId,
      ...(query.status && { status: query.status }),
      ...(query.type && { type: query.type }),
      ...(query.agentId && { agentId: query.agentId }),
      ...((query.from || query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
      ...(search && {
        OR: [
          { reference: { contains: search, mode: 'insensitive' } },
          {
            customer: {
              is: {
                OR: [
                  { name: { contains: search, mode: 'insensitive' } },
                  ...(digits && digits.length >= 3
                    ? [{ externalId: { contains: digits } }]
                    : []),
                ],
              },
            },
          },
        ],
      }),
    };
  }

  private notFound() {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.REQUEST_NOT_FOUND,
      'Request not found',
    );
  }

  private conflict(currentStatus: string) {
    return new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.REQUEST_STATUS_CONFLICT,
      'This request was changed by someone else',
      { details: { currentStatus } },
    );
  }
}

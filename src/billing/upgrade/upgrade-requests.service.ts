import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, UpgradeRequest } from '@prisma/client';
import { AuditAction, AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/roles';
import { ApiException } from '../../common/errors/api.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isPrismaError } from '../../common/errors/prisma-errors';
import { RateLimitedException } from '../../common/errors/rate-limited.exception';
import { resolvePage, toPage } from '../../common/pagination/pagination';
import { RateLimiter } from '../../common/throttle/rate-limiter';
import { DEFAULT_LOCALE } from '../../i18n/locales';
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionService } from '../subscriptions/subscription.service';
import {
  CreateUpgradeRequestDto,
  HandleUpgradeRequestDto,
  QueryUpgradeRequestsDto,
} from './dto/upgrade-request.dto';

/** How often one tenant may send or change an upgrade request: each one can email the platform. */
const REQUESTS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

type NotificationStatus = 'sent' | 'failed' | 'skipped' | 'not_configured';

/**
 * Upgrading while payments are manual (J5). The owner asks for a plan; a platform admin sees the
 * request, activates the plan through the subscription routes (that is where plans change) and
 * marks the request handled, or declines it. Handling does not change the plan by itself.
 *
 * One request per tenant can be pending (a partial unique index): asking again while one is
 * pending REPLACES its plan and note instead of adding a second row or answering 409, so changing
 * your mind never needs an admin. Every ask, including a replacement, emails the platform address
 * (`PLATFORM_ADMIN_NOTIFY_EMAIL`, optional); the per-tenant limit above keeps that from becoming a
 * way to flood it. A mail problem never undoes the request.
 */
@Injectable()
export class UpgradeRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly limiter: RateLimiter,
  ) {}

  // ---- the owner's side ---------------------------------------------------------------------

  async request(actor: AuthUser, dto: CreateUpgradeRequestDto) {
    const { tenantId } = actor;
    const limit = this.limiter.hit(
      `upgrade-request:${tenantId}`,
      REQUESTS_PER_HOUR,
      HOUR_MS,
    );
    if (!limit.allowed) {
      throw new RateLimitedException(limit.retryAfterSeconds);
    }

    // A plan that is not public does not exist for the tenant: no hint that it is there.
    const plan = await this.prisma.plan.findUnique({
      where: { code: dto.planCode },
    });
    if (!plan || plan.visibility !== 'public' || !plan.active) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.PLAN_NOT_FOUND,
        'Plan not found',
      );
    }
    const current = await this.subscriptions.getEffective(tenantId);
    if (!current) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.SUBSCRIPTION_NOT_FOUND,
        'This tenant has no subscription',
      );
    }
    if (current.planCode === plan.code) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.ALREADY_ON_PLAN,
        'The workspace is already on this plan',
      );
    }

    const note = dto.note?.trim() || null;
    const { row, replacedPending } = await this.saveRequest(
      actor,
      plan.code,
      note,
      current.planCode,
    );
    const notification = await this.notifyPlatform(
      tenantId,
      current.planName,
      plan.name,
      note,
    );
    return {
      ...this.view(row, plan.name),
      replacedPending,
      notification,
    };
  }

  /**
   * The tenant's latest request (any status), as `{ request }` with `request: null` when there never
   * was one; so the screen can show "request sent". Wrapped, because an empty 200 is awkward to parse.
   */
  async latest(tenantId: string) {
    const row = await this.prisma.upgradeRequest.findFirst({
      where: { tenantId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { plan: { select: { name: true } } },
    });
    return { request: row ? this.view(row, row.plan.name) : null };
  }

  // ---- the platform admin's side ------------------------------------------------------------

  async list(query: QueryUpgradeRequestsDto) {
    const page = resolvePage(query);
    const where: Prisma.UpgradeRequestWhereInput = query.status
      ? { status: query.status }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.upgradeRequest.findMany({
        where,
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          plan: { select: { name: true } },
          tenant: { select: { id: true, name: true, slug: true } },
        },
      }),
      this.prisma.upgradeRequest.count({ where }),
    ]);

    // The tenant's plan now and who asked: two small lookups for the page, by the ids on it.
    const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
    const userIds = [...new Set(rows.map((r) => r.requestedBy))];
    const [subscriptions, users] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { tenantId: { in: tenantIds } },
        select: { tenantId: true, planCode: true },
      }),
      this.prisma.tenantUser.findMany({
        where: { id: { in: userIds }, tenantId: { in: tenantIds } },
        select: { id: true, tenantId: true, email: true },
      }),
    ]);
    const planOf = new Map(subscriptions.map((s) => [s.tenantId, s.planCode]));
    const emailOf = new Map(
      users.map((u) => [`${u.tenantId}:${u.id}`, u.email]),
    );

    return toPage(
      rows.map((row) => ({
        ...this.view(row, row.plan.name),
        tenant: row.tenant,
        currentPlanCode: planOf.get(row.tenantId) ?? null,
        requestedByEmail:
          emailOf.get(`${row.tenantId}:${row.requestedBy}`) ?? null,
        handledBy: row.handledBy,
      })),
      total,
      page,
    );
  }

  /** Marks a pending request handled or declined. Handling twice is 409. */
  async handle(adminId: string, id: string, dto: HandleUpgradeRequestDto) {
    const note = dto.note?.trim() || null;
    const handled = await this.prisma.$transaction(async (tx) => {
      // The status condition makes this safe against two admins handling it at once.
      const claimed = await tx.upgradeRequest.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: dto.status,
          handledBy: adminId,
          handledAt: new Date(),
          handledNote: note,
        },
      });
      const row = await tx.upgradeRequest.findUnique({
        where: { id },
        include: { plan: { select: { name: true } } },
      });
      if (!row) {
        throw this.notFound();
      }
      if (claimed.count !== 1) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          ErrorCode.UPGRADE_REQUEST_ALREADY_HANDLED,
          'This upgrade request has already been handled',
        );
      }
      await this.audit.record(
        {
          tenantId: row.tenantId,
          actor: { userId: adminId, role: 'platform_admin' },
          action: AuditAction.UPGRADE_HANDLED,
          targetType: 'upgrade_request',
          targetId: row.id,
          before: { status: 'pending' },
          after: {
            status: dto.status,
            requestedPlanCode: row.requestedPlanCode,
          },
        },
        tx,
      );
      return row;
    });
    return this.view(handled, handled.plan.name);
  }

  // ---- internals ----------------------------------------------------------------------------

  /** Creates the pending request, or replaces the pending one; both audited in the same transaction. */
  private async saveRequest(
    actor: AuthUser,
    planCode: string,
    note: string | null,
    currentPlanCode: string,
  ) {
    const { tenantId } = actor;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          const pending = await tx.upgradeRequest.findFirst({
            where: { tenantId, status: 'pending' },
          });
          const row = pending
            ? await tx.upgradeRequest.update({
                where: { id: pending.id, tenantId },
                data: {
                  requestedPlanCode: planCode,
                  note,
                  requestedBy: actor.userId,
                },
              })
            : await tx.upgradeRequest.create({
                data: {
                  tenantId,
                  requestedPlanCode: planCode,
                  note,
                  requestedBy: actor.userId,
                },
              });
          await this.audit.record(
            {
              tenantId,
              actor: { userId: actor.userId, role: actor.role },
              action: AuditAction.UPGRADE_REQUESTED,
              targetType: 'upgrade_request',
              targetId: row.id,
              before: pending
                ? { requestedPlanCode: pending.requestedPlanCode }
                : { planCode: currentPlanCode },
              after: { requestedPlanCode: planCode },
            },
            tx,
          );
          return { row, replacedPending: pending !== null };
        });
      } catch (error) {
        // Two first requests at the same moment: the partial unique index refuses the second, which
        // then finds the first one pending and replaces it.
        if (isPrismaError(error, 'P2002') && attempt < 3) continue;
        throw error;
      }
    }
  }

  private async notifyPlatform(
    tenantId: string,
    currentPlanName: string,
    requestedPlanName: string,
    note: string | null,
  ): Promise<NotificationStatus> {
    const to = this.config.get<string>('PLATFORM_ADMIN_NOTIFY_EMAIL');
    if (!to) return 'not_configured';
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    const result = await this.mail.sendNow({
      to,
      template: 'upgrade-request',
      locale: DEFAULT_LOCALE,
      params: {
        tenantName: tenant?.name ?? '',
        currentPlan: currentPlanName,
        requestedPlan: requestedPlanName,
        note: note ?? '-',
      },
    });
    return result.delivery;
  }

  private view(row: UpgradeRequest, requestedPlanName: string) {
    return {
      id: row.id,
      requestedPlanCode: row.requestedPlanCode,
      requestedPlanName,
      note: row.note,
      status: row.status,
      handledAt: row.handledAt,
      handledNote: row.handledNote,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private notFound() {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.UPGRADE_REQUEST_NOT_FOUND,
      'Upgrade request not found',
    );
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { currentRequestMeta } from '../common/request-context/request-store';
import { resolvePage, toPage } from '../common/pagination/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

/** The actions recorded so far. Add new ones here so the names stay in one place. */
export const AuditAction = {
  USER_INVITED: 'user.invited',
  INVITE_ACCEPTED: 'invite.accepted',
  INVITE_REVOKED: 'invite.revoked',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_DISABLED: 'user.disabled',
  USER_ENABLED: 'user.enabled',
  USER_EMAIL_CHANGED: 'user.email_changed',
  USER_DELETED: 'user.deleted',
  PASSWORD_RESET: 'password.reset',
  TENANT_SUSPENDED: 'tenant.suspended',
  TENANT_REACTIVATED: 'tenant.reactivated',
  // billing (section I)
  SUBSCRIPTION_CREATED: 'subscription.created',
  SUBSCRIPTION_PAYMENT_RECORDED: 'subscription.payment_recorded',
  SUBSCRIPTION_PAYMENT_FAILED: 'subscription.payment_failed',
  SUBSCRIPTION_PLAN_CHANGED: 'subscription.plan_changed',
  SUBSCRIPTION_CANCELED: 'subscription.canceled',
  SUBSCRIPTION_PERIOD_ENDED: 'subscription.period_ended',
  SUBSCRIPTION_EXTENDED: 'subscription.extended',
  SUBSCRIPTION_CLOSED: 'subscription.closed',
  DATA_USE_GRANTED: 'data_use.granted',
  DATA_USE_REVOKED: 'data_use.revoked',
  // gateway (Phase 3)
  API_KEY_CREATED: 'apikey.created',
  API_KEY_UPDATED: 'apikey.updated',
  API_KEY_REVOKED: 'apikey.revoked',
  // human takeover (Phase 4); never the message text
  CONVERSATION_CLAIMED: 'conversation.claimed',
  CONVERSATION_RELEASED: 'conversation.released',
  CONVERSATION_RESOLVED: 'conversation.resolved',
} as const;

export interface AuditEntry {
  tenantId: string;
  /** Who did it: a tenant user, or a platform admin (role `platform_admin`). Null for the system. */
  actor?: { userId?: string | null; role?: string | null };
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
}

// Keys that must never reach the log, at any depth: credentials, token material and emailed links.
const SECRET_KEY = /password|token|secret|hash|link|authorization/i;
const MAX_DEPTH = 6;

/**
 * Append-only staff audit trail (H6), distinct from `ai_engine.agent_actions`. Two ways in: the
 * `@Audit('action')` decorator for simple handlers (see `AuditInterceptor`), and `record()` for
 * services that know the before/after state. Request id, IP and user agent come from the
 * request context, so callers do not pass them.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes one entry. Pass the transaction client as `tx` to make the entry commit or roll back
   * together with the change it describes.
   */
  async record(
    entry: AuditEntry,
    tx: Pick<Prisma.TransactionClient, 'auditLog'> = this.prisma,
  ) {
    const meta = currentRequestMeta();
    await tx.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        actorUserId: entry.actor?.userId ?? null,
        actorRole: entry.actor?.role ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        before: sanitize(entry.before),
        after: sanitize(entry.after),
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 512),
        requestId: meta.requestId,
      },
    });
  }

  async findAll(tenantId: string, query: QueryAuditLogDto) {
    const page = resolvePage(query);
    const where: Prisma.AuditLogWhereInput = {
      tenantId,
      ...(query.actor && { actorUserId: query.actor }),
      ...(query.action && { action: query.action }),
      ...((query.from || query.to) && {
        createdAt: {
          ...(query.from && { gte: query.from }),
          ...(query.to && { lte: query.to }),
        },
      }),
    };
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return toPage(data, total, page);
  }
}

/** Plain JSON copy of `value` with every secret-looking key removed. */
export function sanitize(
  value: unknown,
  depth = 0,
): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return depth >= MAX_DEPTH
      ? []
      : value.map((item) => sanitize(item, depth + 1) ?? null);
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return {};
    const out: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) continue;
      const clean = sanitize(item, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return undefined;
}

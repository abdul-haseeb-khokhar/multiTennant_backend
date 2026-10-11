import { HttpStatus, Injectable } from '@nestjs/common';
import { Notification, Prisma } from '@prisma/client';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { resolvePage, toPage } from '../common/pagination/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeHub, staffChannel } from '../realtime/realtime.hub';
import { StaffEvent } from '../realtime/realtime.constants';
import { QueryNotificationDto } from './dto/query-notification.dto';
import {
  NOTIFICATION_RETENTION_DAYS,
  NotificationType,
} from './notification-types';

type Tx = Prisma.TransactionClient;

export interface NewNotification {
  type: NotificationType;
  params: Record<string, unknown>;
  link?: string | null;
  /**
   * Makes the notification idempotent: a recipient never gets two rows with the same key (a
   * reminder for the same period and threshold). Leave out for event-driven notifications.
   */
  dedupeKey?: string;
}

/**
 * In-app notifications (H5): one row per recipient, created from engine events and billing
 * reminders, read through the API, purged after 90 days. Every query is scoped to the tenant AND
 * the user: nobody reads another person's notifications, not even an owner.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hub: RealtimeHub,
  ) {}

  /** The ids of the tenant's active staff (optionally only some roles): who a notification goes to. */
  async activeStaffIds(
    tenantId: string,
    roles?: string[],
    tx: Pick<Tx, 'tenantUser'> = this.prisma,
  ): Promise<string[]> {
    const users = await tx.tenantUser.findMany({
      where: {
        tenantId,
        status: 'active',
        ...(roles && { role: { in: roles } }),
      },
      select: { id: true },
    });
    return users.map((user) => user.id);
  }

  /**
   * Creates one notification per recipient and returns the rows that were actually created (rows
   * that already existed for a `dedupeKey` are skipped). Call `announce` with the result AFTER the
   * surrounding transaction committed, so the live stream never announces a row that rolled back.
   */
  async create(
    tenantId: string,
    recipientIds: string[],
    input: NewNotification,
    tx: Pick<Tx, 'notification'> = this.prisma,
  ): Promise<Notification[]> {
    if (recipientIds.length === 0) return [];
    return tx.notification.createManyAndReturn({
      data: [...new Set(recipientIds)].map((userId) => ({
        tenantId,
        userId,
        type: input.type,
        params: input.params as Prisma.InputJsonObject,
        link: input.link ?? null,
        dedupeKey: input.dedupeKey ?? null,
      })),
      skipDuplicates: true,
    });
  }

  /** Tells each recipient's open dashboard streams that a notification arrived (ids only). */
  announce(
    tenantId: string,
    rows: Pick<Notification, 'id' | 'type' | 'userId'>[],
  ) {
    for (const row of rows) {
      this.hub.publish(
        staffChannel(tenantId),
        StaffEvent.NOTIFICATION_CREATED,
        { notificationId: row.id, type: row.type },
        { userId: row.userId },
      );
    }
  }

  async findAll(tenantId: string, userId: string, query: QueryNotificationDto) {
    const page = resolvePage(query);
    const where: Prisma.NotificationWhereInput = {
      tenantId,
      userId,
      ...(query.unread && { readAt: null }),
    };
    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: SELECT,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return toPage(data, total, page);
  }

  async unreadCount(tenantId: string, userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { tenantId, userId, readAt: null },
    });
  }

  /** Marks one of the caller's notifications read. Idempotent; someone else's id is a 404. */
  async markRead(tenantId: string, userId: string, id: string) {
    const existing = await this.prisma.notification.findFirst({
      where: { id, tenantId, userId },
      select: SELECT,
    });
    if (!existing) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOTIFICATION_NOT_FOUND,
        `Notification ${id} not found`,
      );
    }
    if (existing.readAt) return existing;
    const readAt = new Date();
    // Only an unread row is touched, so a repeat (or a race) keeps the first read time.
    await this.prisma.notification.updateMany({
      where: { id, tenantId, userId, readAt: null },
      data: { readAt },
    });
    return { ...existing, readAt };
  }

  /** Marks every unread notification of the caller read; returns how many changed. */
  async markAllRead(tenantId: string, userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { tenantId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  /** Deletes notifications older than the retention period (housekeeping). */
  async purgeExpired(now: Date): Promise<number> {
    const cutoff = new Date(
      now.getTime() - NOTIFICATION_RETENTION_DAYS * 86_400_000,
    );
    const result = await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return result.count;
  }
}

const SELECT = {
  id: true,
  type: true,
  params: true,
  link: true,
  readAt: true,
  createdAt: true,
} as const;

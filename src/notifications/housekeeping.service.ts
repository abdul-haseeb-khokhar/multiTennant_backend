import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

/** Delivered engine events are kept this long for duplicate detection (the engine retries within minutes). */
export const ENGINE_EVENT_RETENTION_DAYS = 30;

/**
 * Deletes what has outlived its purpose: notifications after 90 days (H5), the inbox of engine
 * events after 30 days, and expired stream tickets. Idempotent; run by the hourly billing job.
 */
@Injectable()
export class HousekeepingService {
  private readonly logger = new Logger(HousekeepingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async purge(now: Date) {
    const notifications = await this.notifications.purgeExpired(now);
    const events = await this.prisma.engineEvent.deleteMany({
      where: {
        receivedAt: {
          lt: new Date(
            now.getTime() - ENGINE_EVENT_RETENTION_DAYS * 86_400_000,
          ),
        },
      },
    });
    const tickets = await this.prisma.streamTicket.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - 60 * 60_000) } },
    });
    const result = {
      notifications,
      engineEvents: events.count,
      streamTickets: tickets.count,
    };
    if (notifications + events.count + tickets.count > 0) {
      this.logger.log(
        `Housekeeping removed ${notifications} notifications, ${events.count} engine events, ${tickets.count} stream tickets`,
      );
    }
    return result;
  }
}

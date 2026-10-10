import { Injectable } from '@nestjs/common';
import { Clock } from '../billing/clock';
import { RateLimitedException } from '../common/errors/rate-limited.exception';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { generateToken, hashToken } from '../common/tokens/tokens';
import { PrismaService } from '../prisma/prisma.service';
import {
  STREAM_TICKET_TTL_SECONDS,
  TICKET_REQUESTS_PER_MINUTE,
} from './realtime.constants';

export interface RedeemedTicket {
  userId: string;
  /** When the ticket was issued, to refuse one older than a password change. */
  issuedAt: Date;
}

/**
 * Tickets for the dashboard event stream. A browser's `EventSource` cannot send an `Authorization`
 * header and the token must never go into a URL (logs, history), so a signed-in client asks for a
 * ticket (with its normal header) and opens the stream with `?ticket=`. A ticket works ONCE and for
 * 30 seconds, and is stored hashed in the database, so it works on any backend instance and a
 * ticket that shows up in an access log is already dead.
 */
@Injectable()
export class StreamTicketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly limiter: RateLimiter,
  ) {}

  async issue(tenantId: string, userId: string) {
    const attempt = this.limiter.hit(
      `stream-ticket:${tenantId}:${userId}`,
      TICKET_REQUESTS_PER_MINUTE,
      60_000,
    );
    if (!attempt.allowed) {
      throw new RateLimitedException(attempt.retryAfterSeconds);
    }
    const { token, tokenHash } = generateToken();
    const now = this.clock.now();
    await this.prisma.streamTicket.create({
      data: {
        tenantId,
        userId,
        tokenHash,
        expiresAt: new Date(now.getTime() + STREAM_TICKET_TTL_SECONDS * 1000),
      },
    });
    return { ticket: token, expiresInSeconds: STREAM_TICKET_TTL_SECONDS };
  }

  /**
   * Uses a ticket. Null when it is unknown, expired, already used or was issued for another tenant
   * (`tenantId` is the URL's, which must match the ticket's). The claim is one atomic update, so two
   * simultaneous requests with the same ticket cannot both win.
   */
  async redeem(
    ticket: string,
    tenantId: string,
  ): Promise<RedeemedTicket | null> {
    const tokenHash = hashToken(ticket);
    const now = this.clock.now();
    const claimed = await this.prisma.streamTicket.updateMany({
      where: { tokenHash, tenantId, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) return null;
    const row = await this.prisma.streamTicket.findUnique({
      where: { tokenHash },
      select: { userId: true, tenantId: true, createdAt: true },
    });
    if (!row || row.tenantId !== tenantId) return null;
    return { userId: row.userId, issuedAt: row.createdAt };
  }
}

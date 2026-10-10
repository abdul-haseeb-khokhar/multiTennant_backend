import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { FakeClock } from '../billing/clock';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { hashToken } from '../common/tokens/tokens';
import { StreamTicketService } from './stream-ticket.service';

describe('StreamTicketService', () => {
  let prisma: PrismaMock;
  let clock: FakeClock;
  let service: StreamTicketService;

  beforeEach(() => {
    prisma = createPrismaMock();
    clock = new FakeClock(new Date('2026-10-10T10:00:00.000Z'));
    service = new StreamTicketService(
      prisma as never,
      clock,
      new RateLimiter(),
    );
  });

  describe('issue', () => {
    it('returns the ticket once, stores only its hash, and bounds it to 30 seconds and the tenant and user', async () => {
      prisma.streamTicket.create.mockResolvedValue({});
      const { ticket, expiresInSeconds } = await service.issue('t1', 'u1');
      expect(expiresInSeconds).toBe(30);
      expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const data = prisma.streamTicket.create.mock.calls[0][0].data;
      expect(data).toEqual({
        tenantId: 't1',
        userId: 'u1',
        tokenHash: hashToken(ticket),
        expiresAt: new Date('2026-10-10T10:00:30.000Z'),
      });
      expect(JSON.stringify(data)).not.toContain(ticket);
    });

    it('every ticket is different', async () => {
      prisma.streamTicket.create.mockResolvedValue({});
      const a = await service.issue('t1', 'u1');
      const b = await service.issue('t1', 'u1');
      expect(a.ticket).not.toBe(b.ticket);
    });

    it('is limited per user, with Retry-After', async () => {
      prisma.streamTicket.create.mockResolvedValue({});
      for (let i = 0; i < 30; i++) await service.issue('t1', 'u1');
      await expect(service.issue('t1', 'u1')).rejects.toMatchObject({
        status: 429,
        retryAfterSeconds: expect.any(Number),
      });
      await expect(service.issue('t1', 'u2')).resolves.toBeDefined();
      await expect(service.issue('t2', 'u1')).resolves.toBeDefined();
    });
  });

  describe('redeem', () => {
    const row = {
      userId: 'u1',
      tenantId: 't1',
      createdAt: new Date('2026-10-10T09:59:50.000Z'),
    };

    it('claims the ticket with ONE conditional update (unused, unexpired, for the URL tenant)', async () => {
      prisma.streamTicket.updateMany.mockResolvedValue({ count: 1 });
      prisma.streamTicket.findUnique.mockResolvedValue(row);
      await expect(service.redeem('the-ticket', 't1')).resolves.toEqual({
        userId: 'u1',
        issuedAt: row.createdAt,
      });
      expect(prisma.streamTicket.updateMany).toHaveBeenCalledWith({
        where: {
          tokenHash: hashToken('the-ticket'),
          tenantId: 't1',
          usedAt: null,
          expiresAt: { gt: clock.now() },
        },
        data: { usedAt: clock.now() },
      });
    });

    it('returns null when nothing could be claimed: unknown, used, expired or another tenant', async () => {
      prisma.streamTicket.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.redeem('x', 't1')).resolves.toBeNull();
      expect(prisma.streamTicket.findUnique).not.toHaveBeenCalled();
    });

    it('lets only one of two simultaneous redemptions win (the claim is one atomic update)', async () => {
      let claimed = false;
      prisma.streamTicket.updateMany.mockImplementation(async () => {
        if (claimed) return { count: 0 };
        claimed = true;
        return { count: 1 };
      });
      prisma.streamTicket.findUnique.mockResolvedValue(row);
      const results = await Promise.all([
        service.redeem('t', 't1'),
        service.redeem('t', 't1'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('never trusts the row over the URL: a ticket row of another tenant is refused', async () => {
      prisma.streamTicket.updateMany.mockResolvedValue({ count: 1 });
      prisma.streamTicket.findUnique.mockResolvedValue({
        ...row,
        tenantId: 't2',
      });
      await expect(service.redeem('t', 't1')).resolves.toBeNull();
    });
  });
});

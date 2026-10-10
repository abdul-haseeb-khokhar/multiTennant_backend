import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { HousekeepingService } from './housekeeping.service';

describe('HousekeepingService', () => {
  let prisma: PrismaMock;
  let notifications: { purgeExpired: jest.Mock };
  let service: HousekeepingService;
  const now = new Date('2026-10-10T12:00:00.000Z');

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.engineEvent.deleteMany.mockResolvedValue({ count: 2 });
    prisma.streamTicket.deleteMany.mockResolvedValue({ count: 3 });
    notifications = { purgeExpired: jest.fn().mockResolvedValue(5) };
    service = new HousekeepingService(prisma as never, notifications as never);
  });

  it('removes old notifications, delivered engine events (30 days) and expired tickets (1 hour)', async () => {
    await expect(service.purge(now)).resolves.toEqual({
      notifications: 5,
      engineEvents: 2,
      streamTickets: 3,
    });
    expect(notifications.purgeExpired).toHaveBeenCalledWith(now);
    expect(prisma.engineEvent.deleteMany).toHaveBeenCalledWith({
      where: { receivedAt: { lt: new Date('2026-09-10T12:00:00.000Z') } },
    });
    expect(prisma.streamTicket.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: new Date('2026-10-10T11:00:00.000Z') } },
    });
  });

  it('is quiet when there is nothing to remove', async () => {
    notifications.purgeExpired.mockResolvedValue(0);
    prisma.engineEvent.deleteMany.mockResolvedValue({ count: 0 });
    prisma.streamTicket.deleteMany.mockResolvedValue({ count: 0 });
    const log = jest
      .spyOn(service['logger'], 'log')
      .mockImplementation(() => undefined);
    await service.purge(now);
    expect(log).not.toHaveBeenCalled();
  });
});

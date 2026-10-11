import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { RealtimeHub, staffChannel } from '../realtime/realtime.hub';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let prisma: PrismaMock;
  let hub: RealtimeHub;
  let service: NotificationsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    hub = new RealtimeHub();
    service = new NotificationsService(prisma as never, hub);
  });

  describe('activeStaffIds', () => {
    it('lists the ACTIVE users of the tenant, optionally by role', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([
        { id: 'u1' },
        { id: 'u2' },
      ]);
      await expect(service.activeStaffIds('t1')).resolves.toEqual(['u1', 'u2']);
      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith({
        where: { tenantId: 't1', status: 'active' },
        select: { id: true },
      });
      await service.activeStaffIds('t1', ['owner', 'admin']);
      expect(prisma.tenantUser.findMany).toHaveBeenLastCalledWith({
        where: {
          tenantId: 't1',
          status: 'active',
          role: { in: ['owner', 'admin'] },
        },
        select: { id: true },
      });
    });
  });

  describe('create', () => {
    it('inserts one row per distinct recipient, skipping rows that already exist', async () => {
      prisma.notification.createManyAndReturn.mockResolvedValue([{ id: 'n1' }]);
      await service.create('t1', ['u1', 'u2', 'u1'], {
        type: 'conversation.escalated',
        params: { conversationId: 'c1' },
        link: '/conversations/c1',
        dedupeKey: 'k',
      });
      expect(prisma.notification.createManyAndReturn).toHaveBeenCalledWith({
        data: [
          {
            tenantId: 't1',
            userId: 'u1',
            type: 'conversation.escalated',
            params: { conversationId: 'c1' },
            link: '/conversations/c1',
            dedupeKey: 'k',
          },
          {
            tenantId: 't1',
            userId: 'u2',
            type: 'conversation.escalated',
            params: { conversationId: 'c1' },
            link: '/conversations/c1',
            dedupeKey: 'k',
          },
        ],
        skipDuplicates: true,
      });
    });

    it('does nothing without recipients, and defaults link and dedupeKey to null', async () => {
      await expect(
        service.create('t1', [], { type: 'action.proposed', params: {} }),
      ).resolves.toEqual([]);
      expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
      prisma.notification.createManyAndReturn.mockResolvedValue([]);
      await service.create('t1', ['u1'], {
        type: 'action.proposed',
        params: {},
      });
      expect(
        prisma.notification.createManyAndReturn.mock.calls[0][0].data[0],
      ).toMatchObject({
        link: null,
        dedupeKey: null,
      });
    });

    it('uses the transaction client it is given', async () => {
      const tx = {
        notification: { createManyAndReturn: jest.fn().mockResolvedValue([]) },
      };
      await service.create(
        't1',
        ['u1'],
        { type: 'action.proposed', params: {} },
        tx as never,
      );
      expect(tx.notification.createManyAndReturn).toHaveBeenCalled();
      expect(prisma.notification.createManyAndReturn).not.toHaveBeenCalled();
    });
  });

  it('announce tells only the recipient of each notification, with ids and no params', () => {
    const forU1 = jest.fn();
    const forU2 = jest.fn();
    hub.subscribe(staffChannel('t1'), forU1, { userId: 'u1' });
    hub.subscribe(staffChannel('t1'), forU2, { userId: 'u2' });
    service.announce('t1', [
      { id: 'n1', type: 'conversation.escalated', userId: 'u1' },
    ]);
    expect(forU1).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'notification.created',
        data: { notificationId: 'n1', type: 'conversation.escalated' },
      }),
    );
    expect(forU2).not.toHaveBeenCalled();
  });

  describe('reading', () => {
    it('lists only my own notifications of this tenant, newest first, with the unread filter', async () => {
      prisma.notification.findMany.mockResolvedValue([]);
      prisma.notification.count.mockResolvedValue(0);
      await service.findAll('t1', 'u1', { unread: true, skip: 5, take: 10 });
      expect(prisma.notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 't1', userId: 'u1', readAt: null },
          skip: 5,
          take: 10,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        }),
      );
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { tenantId: 't1', userId: 'u1', readAt: null },
      });
      await service.findAll('t1', 'u1', {});
      expect(prisma.notification.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { tenantId: 't1', userId: 'u1' },
          skip: 0,
          take: 20,
        }),
      );
    });

    it('counts my unread notifications', async () => {
      prisma.notification.count.mockResolvedValue(3);
      await expect(service.unreadCount('t1', 'u1')).resolves.toBe(3);
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { tenantId: 't1', userId: 'u1', readAt: null },
      });
    });
  });

  describe('markRead', () => {
    const row = {
      id: 'n1',
      type: 'x',
      params: {},
      link: null,
      createdAt: new Date(),
      readAt: null,
    };

    it('marks one unread notification read, scoped to tenant AND user', async () => {
      prisma.notification.findFirst.mockResolvedValue(row);
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });
      const result = await service.markRead('t1', 'u1', 'n1');
      expect(result.readAt).toBeInstanceOf(Date);
      expect(prisma.notification.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'n1', tenantId: 't1', userId: 'u1' },
        }),
      );
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n1', tenantId: 't1', userId: 'u1', readAt: null },
        data: { readAt: expect.any(Date) },
      });
    });

    it('is idempotent: reading a read one changes nothing and keeps the first time', async () => {
      const first = new Date('2026-10-01');
      prisma.notification.findFirst.mockResolvedValue({
        ...row,
        readAt: first,
      });
      const result = await service.markRead('t1', 'u1', 'n1');
      expect(result.readAt).toEqual(first);
      expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    });

    it("somebody else's (or another tenant's) notification is a 404 and is not touched", async () => {
      prisma.notification.findFirst.mockResolvedValue(null);
      await expect(
        service.markRead('t1', 'u1', 'n-of-u2'),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'NOTIFICATION_NOT_FOUND' },
      });
      expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    });
  });

  it('markAllRead touches only my unread notifications and reports how many', async () => {
    prisma.notification.updateMany.mockResolvedValue({ count: 4 });
    await expect(service.markAllRead('t1', 'u1')).resolves.toEqual({
      updated: 4,
    });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 't1', userId: 'u1', readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });

  it('purgeExpired deletes notifications older than 90 days', async () => {
    prisma.notification.deleteMany.mockResolvedValue({ count: 7 });
    const now = new Date('2026-10-10T00:00:00.000Z');
    await expect(service.purgeExpired(now)).resolves.toBe(7);
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date('2026-07-12T00:00:00.000Z') } },
    });
  });
});

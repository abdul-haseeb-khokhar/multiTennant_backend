import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
} from '../../test/utils/prisma-mock';
import type { EngineEventEnvelope } from '../engine/engine.types';
import {
  RealtimeHub,
  staffChannel,
  widgetChannel,
} from '../realtime/realtime.hub';
import { EngineEventsService } from './engine-events.service';

const envelope = (
  type: string,
  data: Record<string, unknown>,
  over: Partial<EngineEventEnvelope> = {},
): EngineEventEnvelope => ({
  id: 'evt-1',
  type,
  tenantId: 'tenant-a',
  occurredAt: '2026-10-10T10:00:00.000Z',
  data,
  ...over,
});

describe('EngineEventsService', () => {
  let prisma: PrismaMock;
  let notifications: {
    activeStaffIds: jest.Mock;
    create: jest.Mock;
    announce: jest.Mock;
  };
  let usage: { recordMessage: jest.Mock };
  let hub: RealtimeHub;
  let service: EngineEventsService;
  let published: { channel: string; event: string; data: unknown }[];

  beforeEach(() => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-a' });
    prisma.engineEvent.createMany.mockResolvedValue({ count: 1 });
    prisma.gatewayConversation.findFirst.mockResolvedValue({
      endCustomerId: 'ec-1',
      channel: 'widget',
    });
    prisma.gatewayConversation.updateMany.mockResolvedValue({ count: 0 });
    prisma.endCustomer.findFirst.mockResolvedValue({
      name: null,
      externalId: 'web_abcdef0123456789abcdef',
    });
    notifications = {
      activeStaffIds: jest.fn().mockResolvedValue(['u1', 'u2']),
      create: jest.fn().mockResolvedValue([]),
      announce: jest.fn(),
    };
    usage = { recordMessage: jest.fn().mockResolvedValue(true) };
    hub = new RealtimeHub();
    published = [];
    const original = hub.publish.bind(hub);
    jest
      .spyOn(hub, 'publish')
      .mockImplementation((channel, event, data, options) => {
        published.push({ channel, event, data });
        return original(channel, event, data, options);
      });
    service = new EngineEventsService(
      prisma as never,
      notifications as never,
      usage as never,
      hub,
    );
  });

  describe('the envelope and the inbox', () => {
    it('refuses an event for a tenant that does not exist (404) and applies nothing', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      await expect(
        service.ingest(
          envelope('conversation.escalated', { conversationId: 'c1' }),
        ),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'TENANT_NOT_FOUND' },
      });
      expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: 'tenant-a' },
        select: { id: true },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(published).toEqual([]);
    });

    it('records the event id in the inbox in the SAME transaction as its effects, without any text', async () => {
      await service.ingest(
        envelope('usage.recorded', {
          conversationId: 'c1',
          messageId: 'm1',
          tokensIn: 3,
          tokensOut: 4,
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.engineEvent.createMany).toHaveBeenCalledWith({
        data: [
          {
            tenantId: 'tenant-a',
            eventId: 'evt-1',
            type: 'usage.recorded',
            occurredAt: new Date('2026-10-10T10:00:00.000Z'),
          },
        ],
        skipDuplicates: true,
      });
      // the usage write got the transaction client
      expect(usage.recordMessage).toHaveBeenCalledWith(
        'tenant-a',
        { messageId: 'm1', tokensIn: 3, tokensOut: 4 },
        prisma,
      );
    });

    it('a repeated event id is a no-op: nothing applied, nothing published', async () => {
      prisma.engineEvent.createMany.mockResolvedValue({ count: 0 });
      await expect(
        service.ingest(
          envelope('conversation.escalated', { conversationId: 'c1' }),
        ),
      ).resolves.toEqual({ status: 'duplicate' });
      expect(notifications.create).not.toHaveBeenCalled();
      expect(usage.recordMessage).not.toHaveBeenCalled();
      expect(published).toEqual([]);
      expect(notifications.announce).not.toHaveBeenCalled();
    });

    it('a failure inside the transaction publishes nothing and lets the engine retry', async () => {
      notifications.create.mockRejectedValue(new Error('db down'));
      await expect(
        service.ingest(
          envelope('conversation.escalated', { conversationId: 'c1' }),
        ),
      ).rejects.toThrow('db down');
      expect(published).toEqual([]);
      expect(notifications.announce).not.toHaveBeenCalled();
    });

    it('an unknown event type is acknowledged as ignored and affects nothing', async () => {
      await expect(
        service.ingest(envelope('ingestion.completed', { sourceId: 's1' })),
      ).resolves.toEqual({ status: 'ignored' });
      expect(published).toEqual([]);
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('a known event with a required field missing is a 400 and rolls back', async () => {
      await expect(
        service.ingest(envelope('conversation.escalated', {})),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        service.ingest(envelope('message.created', { conversationId: 'c1' })),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('conversation.escalated', () => {
    it('notifies every active staff member with params the translations can render', async () => {
      await service.ingest(
        envelope('conversation.escalated', {
          conversationId: 'c1',
          reason: 'customer_requested',
          endCustomerId: 'ec-from-event',
        }),
      );
      expect(notifications.activeStaffIds).toHaveBeenCalledWith(
        'tenant-a',
        undefined,
        prisma,
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'tenant-a',
        ['u1', 'u2'],
        {
          type: 'conversation.escalated',
          params: {
            conversationId: 'c1',
            customer: 'web_abcdef…',
            channel: 'widget',
            reason: 'customer_requested',
          },
          link: '/conversations/c1',
        },
        prisma,
      );
    });

    it('looks the customer up in THIS tenant only, and prefers the gateway record over the event', async () => {
      await service.ingest(
        envelope('conversation.escalated', {
          conversationId: 'c1',
          endCustomerId: 'ec-of-another-tenant',
        }),
      );
      expect(prisma.gatewayConversation.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a', conversationId: 'c1' },
        select: { endCustomerId: true, channel: true },
      });
      expect(prisma.endCustomer.findFirst).toHaveBeenCalledWith({
        where: { id: 'ec-1', tenantId: 'tenant-a' },
        select: { name: true, externalId: true },
      });
    });

    it('uses an endCustomerId from the event only when the gateway knows nothing, still scoped to the tenant', async () => {
      prisma.gatewayConversation.findFirst.mockResolvedValue(null);
      await service.ingest(
        envelope('conversation.escalated', {
          conversationId: 'c1',
          endCustomerId: 'ec-9',
        }),
      );
      expect(prisma.endCustomer.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ec-9', tenantId: 'tenant-a' },
        }),
      );
    });

    it('falls back to a short conversation id when the customer is unknown, and uses the name when there is one', async () => {
      prisma.endCustomer.findFirst.mockResolvedValue(null);
      await service.ingest(
        envelope('conversation.escalated', {
          conversationId: '123456789abcdef',
        }),
      );
      expect(notifications.create.mock.calls[0][2].params.customer).toBe(
        '#12345678',
      );
      prisma.endCustomer.findFirst.mockResolvedValue({
        name: 'Sana Malik',
        externalId: '+923001234567',
      });
      await service.ingest(
        envelope(
          'conversation.escalated',
          { conversationId: 'c1' },
          { id: 'evt-2' },
        ),
      );
      expect(notifications.create.mock.calls[1][2].params.customer).toBe(
        'Sana Malik',
      );
    });

    it('tells the dashboard and the widget, and clears an escalation the gateway could not deliver', async () => {
      await service.ingest(
        envelope('conversation.escalated', {
          conversationId: 'c1',
          reason: 'limit_reached',
        }),
      );
      expect(published).toEqual([
        {
          channel: staffChannel('tenant-a'),
          event: 'conversation.escalated',
          data: { conversationId: 'c1', reason: 'limit_reached' },
        },
        {
          channel: widgetChannel('tenant-a', 'c1'),
          event: 'status',
          data: { status: 'escalated' },
        },
      ]);
      expect(prisma.gatewayConversation.updateMany).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-a',
          conversationId: 'c1',
          escalationPending: true,
        },
        data: { escalationPending: false },
      });
    });

    it('announces the created notifications only after the transaction, and only the created ones', async () => {
      const rows = [{ id: 'n1', type: 'conversation.escalated', userId: 'u1' }];
      notifications.create.mockResolvedValue(rows);
      await service.ingest(
        envelope('conversation.escalated', { conversationId: 'c1' }),
      );
      expect(notifications.announce).toHaveBeenCalledWith('tenant-a', rows);
    });
  });

  describe('conversation.assigned', () => {
    it('notifies the assignee when somebody ELSE assigned it', async () => {
      await service.ingest(
        envelope('conversation.assigned', {
          conversationId: 'c1',
          assignedUserId: 'u2',
          assignedByUserId: 'u1',
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'tenant-a',
        ['u2'],
        expect.objectContaining({
          type: 'conversation.assigned',
          link: '/conversations/c1',
          params: expect.objectContaining({
            conversationId: 'c1',
            customer: 'web_abcdef…',
          }),
        }),
        prisma,
      );
    });

    it('sends no notification for a plain claim (assigned by themselves), but still updates the screens', async () => {
      await service.ingest(
        envelope('conversation.assigned', {
          conversationId: 'c1',
          assignedUserId: 'u1',
          assignedByUserId: 'u1',
        }),
      );
      expect(notifications.create).not.toHaveBeenCalled();
      expect(published.map((p) => p.event)).toEqual([
        'conversation.assigned',
        'status',
      ]);
      expect(published[1].data).toEqual({ status: 'human_active' });
    });

    it('does not notify somebody who is not an active member of this tenant', async () => {
      notifications.activeStaffIds.mockResolvedValue(['u1']);
      await service.ingest(
        envelope('conversation.assigned', {
          conversationId: 'c1',
          assignedUserId: 'user-of-another-tenant',
          assignedByUserId: 'u1',
        }),
      );
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('conversation.released and conversation.resolved', () => {
    it('release tells staff and sets the customer status to the target', async () => {
      await service.ingest(
        envelope('conversation.released', {
          conversationId: 'c1',
          to: 'escalated',
        }),
      );
      await service.ingest(
        envelope(
          'conversation.released',
          { conversationId: 'c1', to: 'active' },
          { id: 'evt-2' },
        ),
      );
      expect(published.map((p) => [p.event, p.data])).toEqual([
        ['conversation.released', { conversationId: 'c1', to: 'escalated' }],
        ['status', { status: 'escalated' }],
        ['conversation.released', { conversationId: 'c1', to: 'active' }],
        ['status', { status: 'active' }],
      ]);
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('resolve tells staff and the customer', async () => {
      await service.ingest(
        envelope('conversation.resolved', {
          conversationId: 'c1',
          resolvedBy: 'human',
        }),
      );
      expect(published).toEqual([
        {
          channel: staffChannel('tenant-a'),
          event: 'conversation.resolved',
          data: { conversationId: 'c1' },
        },
        {
          channel: widgetChannel('tenant-a', 'c1'),
          event: 'status',
          data: { status: 'resolved' },
        },
      ]);
    });
  });

  describe('message.created', () => {
    it('tells staff by id only, and sends the customer a staff reply WITHOUT the staff identity', async () => {
      await service.ingest(
        envelope('message.created', {
          conversationId: 'c1',
          messageId: 'm1',
          authorType: 'human',
          content: 'Hello, I can help',
          authorUserId: 'u1',
          createdAt: '2026-10-10T10:00:01.000Z',
        }),
      );
      const staff = published.find(
        (p) => p.channel === staffChannel('tenant-a'),
      )!;
      expect(staff).toMatchObject({
        event: 'message.created',
        data: { conversationId: 'c1', messageId: 'm1', authorType: 'human' },
      });
      expect(JSON.stringify(staff.data)).not.toContain('Hello');
      const widget = published.find(
        (p) => p.channel === widgetChannel('tenant-a', 'c1'),
      )!;
      expect(widget).toEqual({
        channel: widgetChannel('tenant-a', 'c1'),
        event: 'message',
        data: {
          id: 'm1',
          authorType: 'human',
          content: 'Hello, I can help',
          contentKey: null,
          createdAt: '2026-10-10T10:00:01.000Z',
        },
      });
      expect(JSON.stringify(widget.data)).not.toContain('u1');
    });

    it('sends a system line as a translation key', async () => {
      await service.ingest(
        envelope('message.created', {
          conversationId: 'c1',
          messageId: 'm2',
          authorType: 'system',
          content: '',
          contentKey: 'agent.joined',
        }),
      );
      expect(
        published.find((p) => p.channel.startsWith('widget:'))!.data,
      ).toMatchObject({
        id: 'm2',
        authorType: 'system',
        content: '',
        contentKey: 'agent.joined',
      });
    });

    it.each(['customer', 'ai', 'tool'])(
      'a %s message never goes to the widget stream',
      async (authorType) => {
        await service.ingest(
          envelope('message.created', {
            conversationId: 'c1',
            messageId: 'm3',
            authorType,
            content: 'the text must not travel',
          }),
        );
        expect(
          published.filter((p) => p.channel.startsWith('widget:')),
        ).toEqual([]);
        expect(JSON.stringify(published)).not.toContain('must not travel');
      },
    );

    it('a human message without text and a system line without a key are not forwarded', async () => {
      await service.ingest(
        envelope('message.created', {
          conversationId: 'c1',
          messageId: 'm4',
          authorType: 'human',
        }),
      );
      await service.ingest(
        envelope(
          'message.created',
          { conversationId: 'c1', messageId: 'm5', authorType: 'system' },
          { id: 'evt-2' },
        ),
      );
      expect(published.filter((p) => p.channel.startsWith('widget:'))).toEqual(
        [],
      );
    });

    it('delivers the same message once even if the event arrives twice under different ids', async () => {
      const event = (id: string) =>
        envelope(
          'message.created',
          {
            conversationId: 'c1',
            messageId: 'm1',
            authorType: 'human',
            content: 'hi',
          },
          { id },
        );
      const delivered = jest.fn();
      hub.subscribe(widgetChannel('tenant-a', 'c1'), delivered);
      await service.ingest(event('evt-1'));
      await service.ingest(event('evt-2'));
      expect(delivered).toHaveBeenCalledTimes(1);
    });
  });

  describe('usage.recorded', () => {
    it('counts the message once through the UsageService, for the envelope tenant', async () => {
      await service.ingest(
        envelope('usage.recorded', {
          conversationId: 'c1',
          messageId: 'm9',
          tokensIn: 10,
          tokensOut: 20,
          tenantId: 'tenant-b', // inside the payload: never trusted
        }),
      );
      expect(usage.recordMessage).toHaveBeenCalledWith(
        'tenant-a',
        { messageId: 'm9', tokensIn: 10, tokensOut: 20 },
        prisma,
      );
      expect(JSON.stringify(usage.recordMessage.mock.calls)).not.toContain(
        'tenant-b',
      );
    });

    it('ignores token counts that are not numbers', async () => {
      await service.ingest(
        envelope('usage.recorded', {
          messageId: 'm9',
          tokensIn: '10',
          tokensOut: null,
        }),
      );
      expect(usage.recordMessage).toHaveBeenCalledWith(
        'tenant-a',
        { messageId: 'm9', tokensIn: undefined, tokensOut: undefined },
        prisma,
      );
    });
  });

  describe('action.proposed', () => {
    it('notifies owners and admins only', async () => {
      notifications.activeStaffIds.mockResolvedValue(['owner-1', 'admin-1']);
      await service.ingest(
        envelope('action.proposed', {
          actionId: 'a1',
          conversationId: 'c1',
          action: 'refund',
        }),
      );
      expect(notifications.activeStaffIds).toHaveBeenCalledWith(
        'tenant-a',
        ['owner', 'admin'],
        prisma,
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'tenant-a',
        ['owner-1', 'admin-1'],
        {
          type: 'action.proposed',
          params: {
            actionId: 'a1',
            action: 'refund',
            conversationId: 'c1',
            customer: 'web_abcdef…',
          },
          link: '/conversations/c1',
        },
        prisma,
      );
      expect(published).toEqual([
        {
          channel: staffChannel('tenant-a'),
          event: 'action.proposed',
          data: { actionId: 'a1', conversationId: 'c1' },
        },
      ]);
    });

    it('works without a conversation', async () => {
      await service.ingest(envelope('action.proposed', { actionId: 'a2' }));
      expect(notifications.create.mock.calls[0][2]).toMatchObject({
        params: { actionId: 'a2', action: 'action' },
        link: null,
      });
    });
  });

  it('never logs message text, and logs an unknown tenant or type by id only', async () => {
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
    await service.ingest(envelope('something.new', { content: 'SECRET TEXT' }));
    prisma.tenant.findUnique.mockResolvedValue(null);
    await service
      .ingest(envelope('message.created', { content: 'SECRET TEXT' }))
      .catch(() => undefined);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('conversation.created is acknowledged without side effects', async () => {
    await expect(
      service.ingest(
        envelope('conversation.created', { conversationId: 'c1' }),
      ),
    ).resolves.toEqual({ status: 'processed' });
    expect(published).toEqual([]);
  });
});

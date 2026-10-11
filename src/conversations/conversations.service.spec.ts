import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { AuditService } from '../audit/audit.service';
import { EngineError } from '../engine/engine.types';
import type { EngineConversation, EngineMessage } from '../engine/engine.types';
import { Actor, ConversationsService } from './conversations.service';

const agent: Actor = { userId: 'u1', tenantId: 'tenant-a', role: 'agent' };
const other: Actor = { userId: 'u2', tenantId: 'tenant-a', role: 'agent' };
const admin: Actor = { userId: 'a1', tenantId: 'tenant-a', role: 'admin' };
const owner: Actor = { userId: 'o1', tenantId: 'tenant-a', role: 'owner' };

const conversation = (
  over: Partial<EngineConversation> = {},
): EngineConversation => ({
  id: 'c1',
  channel: 'widget',
  endCustomerId: 'ec-1',
  status: 'escalated',
  escalationReason: 'customer_requested',
  createdAt: '2026-10-10T09:00:00.000Z',
  lastMessageAt: '2026-10-10T09:05:00.000Z',
  assignedUserId: null,
  escalatedAt: '2026-10-10T09:05:00.000Z',
  summary: 'wants a human',
  resolvedAt: null,
  resolvedBy: null,
  ...over,
});
const held = (userId = 'u1') =>
  conversation({ status: 'human_active', assignedUserId: userId });

const message = (over: Partial<EngineMessage> = {}): EngineMessage => ({
  id: 'm1',
  conversationId: 'c1',
  authorType: 'customer',
  authorUserId: null,
  content: 'hello',
  contentKey: null,
  createdAt: '2026-10-10T09:01:00.000Z',
  ...over,
});

const conflict = (code?: string) =>
  new EngineError('conflict', 'conflict', 409, code);

describe('ConversationsService', () => {
  let prisma: PrismaMock;
  let engine: Record<string, jest.Mock>;
  let audit: { record: jest.Mock };
  let service: ConversationsService;

  /** The conversation the engine returns when the service reads it before a command. */
  const engineHolds = (c: EngineConversation) =>
    engine.getConversation.mockResolvedValue({
      conversation: c,
      messages: { data: [], total: 0, skip: 0, take: 1 },
    });

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.endCustomer.findMany.mockResolvedValue([
      { id: 'ec-1', name: null, externalId: 'web_abcdef0123456789abcdef' },
    ]);
    prisma.endCustomer.findFirst.mockResolvedValue({ name: 'Sana' });
    prisma.tenantUser.findMany.mockResolvedValue([
      { id: 'u1', name: 'Hina Agent', email: 'hina@acme.com' },
    ]);
    engine = {
      listConversations: jest.fn(),
      countConversations: jest.fn(),
      getConversation: jest.fn(),
      claimConversation: jest.fn(),
      releaseConversation: jest.fn(),
      resolveConversation: jest.fn(),
      sendHumanMessage: jest.fn(),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ConversationsService(
      prisma as never,
      engine as never,
      audit as unknown as AuditService,
    );
  });

  describe('every engine call carries the tenant of the verified token', () => {
    it('reads: tenant, acting user and role, and no idempotency key', async () => {
      engine.listConversations.mockResolvedValue({
        data: [],
        total: 0,
        skip: 0,
        take: 20,
      });
      await service.list(agent, {});
      expect(engine.listConversations).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-a',
          actingUserId: 'u1',
          actingRole: 'agent',
        }),
        expect.anything(),
      );
      expect(
        engine.listConversations.mock.calls[0][0].idempotencyKey,
      ).toBeUndefined();
    });

    it('commands always get an idempotency key; the caller key is scoped to the user', async () => {
      engineHolds(conversation());
      engine.claimConversation.mockResolvedValue(held());
      await service.claim(agent, 'c1');
      await service.claim(agent, 'c1', 'my-own-key-123');
      const keys = engine.claimConversation.mock.calls.map(
        ([ctx]) => ctx.idempotencyKey,
      );
      expect(keys[0]).toEqual(expect.any(String));
      expect(keys[1]).toBe('staff:u1:my-own-key-123');
    });
  });

  describe('list', () => {
    it('translates the filters: assignedTo=me is the caller, customerId and sort pass through', async () => {
      engine.listConversations.mockResolvedValue({
        data: [],
        total: 0,
        skip: 0,
        take: 20,
      });
      await service.list(agent, {
        status: ['escalated'],
        assignedTo: 'me',
        customerId: 'ec-1',
        sort: 'escalatedAt',
        skip: 5,
        take: 10,
      });
      expect(engine.listConversations).toHaveBeenCalledWith(expect.anything(), {
        status: ['escalated'],
        assignedUserId: 'u1',
        endCustomerId: 'ec-1',
        sort: 'escalatedAt',
        skip: 5,
        take: 10,
      });
      await service.list(agent, { assignedTo: 'some-user-id' });
      expect(engine.listConversations.mock.calls[1][1].assignedUserId).toBe(
        'some-user-id',
      );
    });

    it('adds the customer and the assignee name, looked up in the tenant, and shortens a visitor id', async () => {
      engine.listConversations.mockResolvedValue({
        data: [held('u1')],
        total: 1,
        skip: 0,
        take: 20,
      });
      const page = await service.list(agent, {});
      expect(prisma.endCustomer.findMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a', id: { in: ['ec-1'] } },
        select: { id: true, name: true, externalId: true },
      });
      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a', id: { in: ['u1'] } },
        select: { id: true, name: true, email: true },
      });
      expect(page).toMatchObject({ total: 1, skip: 0, take: 20 });
      expect(page.data[0]).toEqual({
        id: 'c1',
        endCustomerId: 'ec-1',
        customer: { name: null, externalId: 'web_abcdef…', channel: 'widget' },
        channel: 'widget',
        status: 'human_active',
        assignedUserId: 'u1',
        assignedUserName: 'Hina Agent',
        escalatedAt: '2026-10-10T09:05:00.000Z',
        escalationReason: 'customer_requested',
        summary: 'wants a human',
        lastMessageAt: '2026-10-10T09:05:00.000Z',
        resolvedAt: null,
        resolvedBy: null,
        createdAt: '2026-10-10T09:00:00.000Z',
      });
      // the full visitor id (that visitor's secret) is nowhere in the answer
      expect(JSON.stringify(page)).not.toContain('0123456789abcdef');
    });

    it('names a user without a name by their email, and a deleted user as null', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([
        { id: 'u1', name: null, email: 'hina@acme.com' },
      ]);
      engine.listConversations.mockResolvedValue({
        data: [held('u1'), { ...held('gone'), id: 'c2' }],
        total: 2,
        skip: 0,
        take: 20,
      });
      const page = await service.list(agent, {});
      expect(page.data[0].assignedUserName).toBe('hina@acme.com');
      expect(page.data[1].assignedUserName).toBeNull();
      expect(page.data[1].assignedUserId).toBe('gone');
    });

    it('a customer that no longer exists leaves the customer name and id empty, never an error', async () => {
      prisma.endCustomer.findMany.mockResolvedValue([]);
      engine.listConversations.mockResolvedValue({
        data: [conversation()],
        total: 1,
        skip: 0,
        take: 20,
      });
      const page = await service.list(agent, {});
      expect(page.data[0].customer).toEqual({
        name: null,
        externalId: null,
        channel: 'widget',
      });
    });

    it('asks the database nothing when the page is empty', async () => {
      engine.listConversations.mockResolvedValue({
        data: [],
        total: 0,
        skip: 0,
        take: 20,
      });
      await service.list(agent, {});
      expect(prisma.endCustomer.findMany).not.toHaveBeenCalled();
      expect(prisma.tenantUser.findMany).not.toHaveBeenCalled();
    });
  });

  describe('listForCustomer', () => {
    it('lists the conversations of a customer of this tenant', async () => {
      prisma.endCustomer.findFirst.mockResolvedValue({ id: 'ec-1' });
      engine.listConversations.mockResolvedValue({
        data: [],
        total: 0,
        skip: 0,
        take: 20,
      });
      await service.listForCustomer(agent, 'ec-1', { skip: 2 });
      expect(prisma.endCustomer.findFirst).toHaveBeenCalledWith({
        where: { id: 'ec-1', tenantId: 'tenant-a' },
        select: { id: true },
      });
      expect(engine.listConversations).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ endCustomerId: 'ec-1', skip: 2 }),
      );
    });

    it('a customer of another tenant is a 404 and the engine is not asked', async () => {
      prisma.endCustomer.findFirst.mockResolvedValue(null);
      await expect(
        service.listForCustomer(agent, 'ec-of-b', {}),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'CUSTOMER_NOT_FOUND' },
      });
      expect(engine.listConversations).not.toHaveBeenCalled();
    });
  });

  describe('counts', () => {
    it('gives the counts per status and how many I am handling', async () => {
      engine.countConversations
        .mockResolvedValueOnce({
          active: 5,
          escalated: 3,
          human_active: 2,
          resolved: 9,
        })
        .mockResolvedValueOnce({
          active: 0,
          escalated: 0,
          human_active: 1,
          resolved: 0,
        });
      await expect(service.counts(agent)).resolves.toEqual({
        counts: { active: 5, escalated: 3, human_active: 2, resolved: 9 },
        assignedToMe: 1,
      });
      expect(engine.countConversations).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        {
          assignedUserId: 'u1',
        },
      );
    });
  });

  describe('get', () => {
    it('returns the conversation with its messages, names, system lines as keys, and without tool messages', async () => {
      engine.getConversation.mockResolvedValue({
        conversation: held('u1'),
        messages: {
          data: [
            message({ id: 'm1', authorType: 'customer' }),
            message({
              id: 'm2',
              authorType: 'system',
              content: '',
              contentKey: 'agent.joined',
            }),
            message({
              id: 'm3',
              authorType: 'human',
              authorUserId: 'u1',
              content: 'hi',
            }),
            message({ id: 'm4', authorType: 'tool', content: 'SQL' }),
            message({ id: 'm5', authorType: 'ai', content: 'bot' }),
            message({
              id: 'm6',
              authorType: 'human',
              authorUserId: 'deleted-user',
              content: 'bye',
            }),
          ],
          total: 6,
          skip: 0,
          take: 50,
        },
      });
      const detail = await service.get(agent, 'c1', {});
      expect(engine.getConversation).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        { skip: 0, take: 50 },
      );
      expect(detail.messages).toMatchObject({ total: 6, skip: 0, take: 50 });
      expect(
        detail.messages.data.map((m) => [m.id, m.authorName, m.contentKey]),
      ).toEqual([
        ['m1', 'Sana', null],
        ['m2', null, 'agent.joined'],
        ['m3', 'Hina Agent', null],
        ['m5', null, null],
        ['m6', null, null],
      ]);
      expect(JSON.stringify(detail)).not.toContain('SQL');
    });

    it('an unknown conversation or one of another tenant is a 404 CONVERSATION_NOT_FOUND', async () => {
      engine.getConversation.mockRejectedValue(
        new EngineError('not_found', 'x', 404),
      );
      await expect(service.get(agent, 'c-of-b', {})).rejects.toMatchObject({
        status: 404,
        response: { code: 'CONVERSATION_NOT_FOUND' },
      });
    });
  });

  describe('claim', () => {
    it('takes an escalated conversation and audits it without any message text', async () => {
      engineHolds(conversation());
      engine.claimConversation.mockResolvedValue(held('u1'));
      const view = await service.claim(agent, 'c1');
      expect(engine.claimConversation).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-a', actingUserId: 'u1' }),
        'c1',
        { userId: 'u1' },
      );
      expect(view).toMatchObject({
        status: 'human_active',
        assignedUserId: 'u1',
        assignedUserName: 'Hina Agent',
      });
      expect(audit.record).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        actor: { userId: 'u1', role: 'agent' },
        action: 'conversation.claimed',
        targetType: 'conversation',
        targetId: 'c1',
        before: { status: 'escalated', assignedUserId: null },
        after: { status: 'human_active', assignedUserId: 'u1' },
      });
    });

    it.each([
      ['an owner', owner],
      ['an admin', admin],
      ['an agent', agent],
    ])('%s may claim', async (_name, actor) => {
      engineHolds(conversation({ status: 'active' }));
      engine.claimConversation.mockResolvedValue(held(actor.userId));
      await expect(service.claim(actor, 'c1')).resolves.toMatchObject({
        assignedUserId: actor.userId,
      });
    });

    it('claiming what is already claimed by somebody else is a 409 CONVERSATION_ALREADY_CLAIMED and the engine is not asked', async () => {
      engineHolds(held('u2'));
      await expect(service.claim(agent, 'c1')).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONVERSATION_ALREADY_CLAIMED' },
      });
      expect(engine.claimConversation).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('claiming what you already hold is a no-op (a double click), not an error and not audited twice', async () => {
      engineHolds(held('u1'));
      await expect(service.claim(agent, 'c1')).resolves.toMatchObject({
        assignedUserId: 'u1',
      });
      expect(engine.claimConversation).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('a resolved conversation is a 409 CONVERSATION_RESOLVED', async () => {
      engineHolds(conversation({ status: 'resolved' }));
      await expect(service.claim(agent, 'c1')).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONVERSATION_RESOLVED' },
      });
    });

    it('losing the race at the engine (it answers 409 although we saw it free) is ALREADY_CLAIMED', async () => {
      engineHolds(conversation());
      engine.claimConversation.mockRejectedValue(
        conflict('CONVERSATION_ALREADY_CLAIMED'),
      );
      await expect(service.claim(agent, 'c1')).rejects.toMatchObject({
        response: { code: 'CONVERSATION_ALREADY_CLAIMED' },
      });
      engine.claimConversation.mockRejectedValue(conflict());
      await expect(service.claim(agent, 'c1')).rejects.toMatchObject({
        response: { code: 'CONVERSATION_ALREADY_CLAIMED' },
      });
      engine.claimConversation.mockRejectedValue(
        conflict('CONVERSATION_RESOLVED'),
      );
      await expect(service.claim(agent, 'c1')).rejects.toMatchObject({
        response: { code: 'CONVERSATION_RESOLVED' },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('an unknown conversation is a 404', async () => {
      engine.getConversation.mockRejectedValue(
        new EngineError('not_found', 'x', 404),
      );
      await expect(service.claim(agent, 'nope')).rejects.toMatchObject({
        status: 404,
      });
    });

    it('an unreachable engine is a 503 ENGINE_UNAVAILABLE that reveals nothing', async () => {
      engine.getConversation.mockRejectedValue(
        new EngineError('unavailable', 'connect ECONNREFUSED 10.0.0.5:4000'),
      );
      const error = await service.claim(agent, 'c1').catch((e) => e);
      expect(error).toMatchObject({
        status: 503,
        response: { code: 'ENGINE_UNAVAILABLE' },
      });
      expect(JSON.stringify(error.response)).not.toContain('10.0.0.5');
    });

    it('a failing audit write never turns a successful claim into an error', async () => {
      engineHolds(conversation());
      engine.claimConversation.mockResolvedValue(held('u1'));
      audit.record.mockRejectedValue(new Error('audit down'));
      jest
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => undefined);
      await expect(service.claim(agent, 'c1')).resolves.toMatchObject({
        assignedUserId: 'u1',
      });
    });
  });

  describe.each([
    [
      'release',
      (s: ConversationsService, a: Actor) => s.release(a, 'c1'),
      'releaseConversation',
      'conversation.released',
    ],
    [
      'resolve',
      (s: ConversationsService, a: Actor) => s.resolve(a, 'c1'),
      'resolveConversation',
      'conversation.resolved',
    ],
    [
      'reply',
      (s: ConversationsService, a: Actor) => s.reply(a, 'c1', 'Hello'),
      'sendHumanMessage',
      null,
    ],
  ] as const)('%s', (_name, run, engineMethod, auditAction) => {
    beforeEach(() => {
      engine.releaseConversation.mockResolvedValue(
        conversation({ status: 'active' }),
      );
      engine.resolveConversation.mockResolvedValue(
        conversation({
          status: 'resolved',
          resolvedBy: 'human',
          resolvedAt: '2026-10-10T10:00:00.000Z',
        }),
      );
      engine.sendHumanMessage.mockResolvedValue(
        message({
          id: 'h1',
          authorType: 'human',
          authorUserId: 'u1',
          content: 'Hello',
        }),
      );
    });

    it('works for the person who holds the conversation', async () => {
      engineHolds(held('u1'));
      await expect(run(service, agent)).resolves.toBeDefined();
      expect(engine[engineMethod]).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-a', actingUserId: 'u1' }),
        'c1',
        expect.objectContaining({ userId: 'u1' }),
      );
      if (auditAction) {
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId: 'tenant-a',
            action: auditAction,
            targetType: 'conversation',
            targetId: 'c1',
          }),
        );
      } else {
        expect(audit.record).not.toHaveBeenCalled();
      }
    });

    it.each([
      ['an owner', owner],
      ['an admin', admin],
      ['another agent', other],
    ])(
      'is refused for %s while somebody else holds it (409 CONVERSATION_NOT_ASSIGNED_TO_YOU)',
      async (_n, actor) => {
        engineHolds(held('u1'));
        await expect(run(service, actor)).rejects.toMatchObject({
          status: 409,
          response: { code: 'CONVERSATION_NOT_ASSIGNED_TO_YOU' },
        });
        expect(engine[engineMethod]).not.toHaveBeenCalled();
      },
    );

    it.each(['escalated', 'active'] as const)(
      'is refused for a conversation nobody holds (%s): take it first',
      async (status) => {
        engineHolds(conversation({ status }));
        await expect(run(service, agent)).rejects.toMatchObject({
          status: 409,
          response: { code: 'CONVERSATION_NOT_ASSIGNED_TO_YOU' },
        });
        expect(engine[engineMethod]).not.toHaveBeenCalled();
      },
    );

    it('is refused for a resolved conversation (409 CONVERSATION_RESOLVED)', async () => {
      engineHolds(conversation({ status: 'resolved' }));
      await expect(run(service, agent)).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONVERSATION_RESOLVED' },
      });
    });

    it('maps the engine refusing at the last moment to the right code', async () => {
      engineHolds(held('u1'));
      engine[engineMethod].mockRejectedValue(conflict('CONVERSATION_RESOLVED'));
      await expect(run(service, agent)).rejects.toMatchObject({
        response: { code: 'CONVERSATION_RESOLVED' },
      });
      engine[engineMethod].mockRejectedValue(conflict());
      await expect(run(service, agent)).rejects.toMatchObject({
        response: { code: 'CONVERSATION_NOT_ASSIGNED_TO_YOU' },
      });
    });
  });

  describe('release', () => {
    it('defaults to handing the conversation back to the AI, or back to the queue on request', async () => {
      engineHolds(held('u1'));
      engine.releaseConversation.mockResolvedValue(
        conversation({ status: 'active' }),
      );
      await service.release(agent, 'c1');
      expect(engine.releaseConversation).toHaveBeenLastCalledWith(
        expect.anything(),
        'c1',
        {
          userId: 'u1',
          to: 'active',
        },
      );
      engine.releaseConversation.mockResolvedValue(
        conversation({ status: 'escalated' }),
      );
      await service.release(agent, 'c1', 'escalated');
      expect(engine.releaseConversation).toHaveBeenLastCalledWith(
        expect.anything(),
        'c1',
        {
          userId: 'u1',
          to: 'escalated',
        },
      );
      expect(audit.record.mock.calls[1][0].after).toMatchObject({
        to: 'escalated',
        assignedUserId: null,
      });
    });
  });

  describe('reply', () => {
    beforeEach(() => {
      engineHolds(held('u1'));
      engine.sendHumanMessage.mockResolvedValue(
        message({
          id: 'h1',
          authorType: 'human',
          authorUserId: 'u1',
          content: 'x',
        }),
      );
    });

    it('sends the reply and returns it with the author name', async () => {
      const reply = await service.reply(agent, 'c1', 'Hello, I can help');
      expect(engine.sendHumanMessage).toHaveBeenCalledWith(
        expect.anything(),
        'c1',
        {
          userId: 'u1',
          content: 'Hello, I can help',
        },
      );
      expect(reply).toMatchObject({
        id: 'h1',
        authorType: 'human',
        authorUserId: 'u1',
        authorName: 'Hina Agent',
      });
    });

    it('accepts exactly 2,000 characters (counted as characters) and refuses 2,001 with MESSAGE_TOO_LONG', async () => {
      await expect(
        service.reply(agent, 'c1', 'a'.repeat(2000)),
      ).resolves.toBeDefined();
      await expect(
        service.reply(agent, 'c1', '😀'.repeat(2000)),
      ).resolves.toBeDefined();
      await expect(
        service.reply(agent, 'c1', 'a'.repeat(2001)),
      ).rejects.toMatchObject({
        status: 400,
        response: { code: 'MESSAGE_TOO_LONG' },
      });
    });

    it('refuses an empty or blank reply before asking the engine anything', async () => {
      engine.getConversation.mockClear();
      for (const content of ['', '   ', '\n\t']) {
        await expect(service.reply(agent, 'c1', content)).rejects.toMatchObject(
          {
            status: 400,
            response: { code: 'VALIDATION_ERROR' },
          },
        );
      }
      expect(engine.getConversation).not.toHaveBeenCalled();
    });

    it('a too-long message is refused before the engine is asked, even for the wrong person', async () => {
      engine.getConversation.mockClear();
      await expect(
        service.reply(other, 'c1', 'a'.repeat(2001)),
      ).rejects.toMatchObject({
        response: { code: 'MESSAGE_TOO_LONG' },
      });
      expect(engine.getConversation).not.toHaveBeenCalled();
    });
  });

  describe('releaseHeldBy (a user was disabled or deleted)', () => {
    it('puts every conversation they held back in the queue, forced, and audits each', async () => {
      engine.listConversations.mockResolvedValueOnce({
        data: [held('u1'), { ...held('u1'), id: 'c2' }],
        total: 2,
        skip: 0,
        take: 100,
      });
      engine.releaseConversation.mockResolvedValue(conversation());
      await expect(
        service.releaseHeldBy(admin, 'u1', 'assignee_disabled'),
      ).resolves.toEqual({
        released: 2,
        failed: 0,
      });
      expect(engine.listConversations).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-a', actingUserId: 'a1' }),
        { status: ['human_active'], assignedUserId: 'u1', skip: 0, take: 100 },
      );
      expect(engine.releaseConversation).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-a' }),
        'c1',
        {
          userId: 'a1',
          to: 'escalated',
          force: true,
          reason: 'assignee_disabled',
        },
      );
      expect(audit.record).toHaveBeenCalledTimes(2);
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        actor: { userId: 'a1', role: 'admin' },
        action: 'conversation.released',
        targetId: 'c1',
        before: { status: 'human_active', assignedUserId: 'u1' },
        after: { to: 'escalated', reason: 'assignee_disabled' },
      });
    });

    it('does nothing for a user who held nothing', async () => {
      engine.listConversations.mockResolvedValue({
        data: [],
        total: 0,
        skip: 0,
        take: 100,
      });
      await expect(
        service.releaseHeldBy(admin, 'u1', 'assignee_deleted'),
      ).resolves.toEqual({
        released: 0,
        failed: 0,
      });
      expect(engine.releaseConversation).not.toHaveBeenCalled();
    });

    it('is best effort: one failing release is counted and the rest still happen; nothing is thrown', async () => {
      jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      engine.listConversations.mockResolvedValueOnce({
        data: [held('u1'), { ...held('u1'), id: 'c2' }],
        total: 2,
        skip: 0,
        take: 100,
      });
      engine.releaseConversation
        .mockRejectedValueOnce(new EngineError('unavailable', 'down'))
        .mockResolvedValueOnce(conversation());
      await expect(
        service.releaseHeldBy(admin, 'u1', 'assignee_deleted'),
      ).resolves.toEqual({
        released: 1,
        failed: 1,
      });
    });

    it('an engine that cannot even list is logged, not raised, and does not loop', async () => {
      jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      engine.listConversations.mockRejectedValue(
        new EngineError('unavailable', 'down'),
      );
      await expect(
        service.releaseHeldBy(admin, 'u1', 'assignee_disabled'),
      ).resolves.toEqual({
        released: 0,
        failed: 0,
      });
      expect(engine.listConversations).toHaveBeenCalledTimes(1);
    });

    it('stops when nothing could be released instead of re-reading the same page forever', async () => {
      jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
      const full = Array.from({ length: 100 }, (_, i) => ({
        ...held('u1'),
        id: `c${i}`,
      }));
      engine.listConversations.mockResolvedValue({
        data: full,
        total: 100,
        skip: 0,
        take: 100,
      });
      engine.releaseConversation.mockRejectedValue(
        new EngineError('rejected', 'no', 400),
      );
      const result = await service.releaseHeldBy(
        admin,
        'u1',
        'assignee_disabled',
      );
      expect(result).toEqual({ released: 0, failed: 100 });
      expect(engine.listConversations).toHaveBeenCalledTimes(1);
    });
  });
});

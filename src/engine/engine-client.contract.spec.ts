import { FakeEngineServer } from '../../test/utils/fake-engine-server';
import { EngineClient } from './engine-client';
import { HttpEngineClient } from './http-engine.client';
import { MockEngineClient } from './mock-engine.client';
import {
  EngineCallContext,
  EngineError,
  EngineStreamEvent,
} from './engine.types';

const TOKEN = 't'.repeat(40);

async function collect(events: AsyncIterable<EngineStreamEvent>) {
  const out: EngineStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function failure(promise: Promise<unknown>): Promise<EngineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EngineError) return error;
    throw error;
  }
  throw new Error('expected an EngineError');
}

const ctxFor = (
  tenantId: string,
  idempotencyKey?: string,
): EngineCallContext => ({ tenantId, requestId: 'req-1', idempotencyKey });

/**
 * One behaviour suite for every EngineClient: the in-process mock and the HTTP client talking to
 * a server that implements docs/contracts/engine-internal.openapi.yaml. If both pass, the mock
 * is a faithful stand-in for the contract.
 */
describe.each([
  ['MockEngineClient', 'mock'],
  ['HttpEngineClient (over a real socket)', 'http'],
] as const)('EngineClient contract: %s', (_name, kind) => {
  let client: EngineClient;
  let fake: FakeEngineServer | undefined;
  let mock: MockEngineClient | undefined;

  beforeAll(async () => {
    if (kind === 'http') {
      fake = new FakeEngineServer(TOKEN);
      await fake.start();
      client = new HttpEngineClient({
        baseUrl: fake.url,
        token: TOKEN,
        requestTimeoutMs: 5000,
        firstTokenTimeoutMs: 5000,
        totalTimeoutMs: 10_000,
      });
    } else {
      mock = new MockEngineClient({
        tokenDelayMs: 0,
        firstTokenTimeoutMs: 5000,
        totalTimeoutMs: 10_000,
      });
      client = mock;
    }
  });

  afterAll(async () => {
    await fake?.stop();
  });

  beforeEach(() => {
    fake?.reset();
    mock?.reset();
  });

  const engine = () => fake?.engine ?? mock!;

  const open = async (tenantId = 'tenant-a', key = 'k-open') =>
    client.createConversation(ctxFor(tenantId, key), {
      channel: 'widget',
      endCustomerId: 'ec-1',
      locale: 'en',
    });

  it('health answers ok', async () => {
    await expect(client.health()).resolves.toEqual({ ok: true });
  });

  describe('createConversation', () => {
    it('creates an active conversation for the end customer', async () => {
      const conversation = await open();
      expect(conversation).toMatchObject({
        channel: 'widget',
        endCustomerId: 'ec-1',
        status: 'active',
        escalationReason: null,
      });
      expect(conversation.id).toBeTruthy();
    });

    it('is idempotent by key and creates a new one without or with another key', async () => {
      const a = await open('tenant-a', 'same');
      const b = await open('tenant-a', 'same');
      const c = await open('tenant-a', 'other');
      expect(b.id).toBe(a.id);
      expect(c.id).not.toBe(a.id);
    });

    it('scopes the idempotency key to the tenant', async () => {
      const a = await open('tenant-a', 'same');
      const b = await open('tenant-b', 'same');
      expect(b.id).not.toBe(a.id);
    });
  });

  describe('tenant isolation: the engine trusts only the tenant it is told', () => {
    it("tenant B cannot read, write to or escalate tenant A's conversation", async () => {
      const a = await open('tenant-a');
      const read = await failure(
        client.getConversation(ctxFor('tenant-b'), a.id),
      );
      expect(read.kind).toBe('not_found');
      const write = await failure(
        collect(
          client.sendMessage(ctxFor('tenant-b'), a.id, { content: 'hi' }),
        ),
      );
      expect(write.kind).toBe('not_found');
      const escalate = await failure(
        client.escalate(ctxFor('tenant-b'), a.id, { reason: 'other' }),
      );
      expect(escalate.kind).toBe('not_found');
      // Nothing of tenant B leaked into tenant A's conversation.
      const history = await client.getConversation(ctxFor('tenant-a'), a.id);
      expect(history.messages.total).toBe(0);
    });
  });

  describe('sendMessage', () => {
    it('streams accepted, tokens, usage and done, and stores both messages', async () => {
      const { id } = await open();
      const events = await collect(
        client.sendMessage(ctxFor('tenant-a', 'm1'), id, {
          content: 'What are your opening hours?',
        }),
      );
      expect(events[0].type).toBe('accepted');
      expect(events[events.length - 1].type).toBe('done');
      expect(events.filter((e) => e.type === 'token').length).toBeGreaterThan(
        1,
      );
      const text = events
        .filter((e) => e.type === 'token')
        .map((e) => (e as { text: string }).text)
        .join('');
      expect(text).toContain('9:00');
      const usage = events.find((e) => e.type === 'usage');
      expect(usage).toMatchObject({ tokensIn: expect.any(Number) });
      expect(events[events.length - 1]).toMatchObject({
        aiReply: true,
        conversationStatus: 'active',
      });

      const history = await client.getConversation(ctxFor('tenant-a'), id);
      expect(history.messages.data.map((m) => m.authorType)).toEqual([
        'customer',
        'ai',
      ]);
      expect(history.messages.data[1].content).toBe(text);
      // The ids the stream reported are the stored ones.
      const accepted = events[0] as { messageId: string };
      expect(history.messages.data[0].id).toBe(accepted.messageId);
    });

    it('with aiReply false stores the message and generates no reply', async () => {
      const { id } = await open();
      const events = await collect(
        client.sendMessage(ctxFor('tenant-a'), id, {
          content: 'Hello',
          aiReply: false,
        }),
      );
      expect(events.map((e) => e.type)).toEqual(['accepted', 'done']);
      expect(events[1]).toMatchObject({ aiReply: false, messageId: null });
      const history = await client.getConversation(ctxFor('tenant-a'), id);
      expect(history.messages.data.map((m) => m.authorType)).toEqual([
        'customer',
      ]);
    });

    it('hands over when the customer asks for a human, and then stays silent (C4)', async () => {
      const { id } = await open();
      const first = await collect(
        client.sendMessage(ctxFor('tenant-a'), id, {
          content: 'I want to talk to a human please',
        }),
      );
      expect(first.find((e) => e.type === 'escalated')).toMatchObject({
        reason: 'customer_requested',
      });
      expect(first[first.length - 1]).toMatchObject({
        conversationStatus: 'escalated',
      });

      const second = await collect(
        client.sendMessage(ctxFor('tenant-a'), id, { content: 'Hello?' }),
      );
      expect(second.map((e) => e.type)).toEqual(['accepted', 'done']);
      expect(second[1]).toMatchObject({
        aiReply: false,
        conversationStatus: 'escalated',
      });
      const detail = await client.getConversation(ctxFor('tenant-a'), id);
      expect(detail.conversation).toMatchObject({
        status: 'escalated',
        escalationReason: 'customer_requested',
      });
    });

    it('does not answer while a human is active', async () => {
      const { id } = await open();
      engine().postHumanMessage('tenant-a', id, 'user-9', 'I will help you');
      const events = await collect(
        client.sendMessage(ctxFor('tenant-a'), id, { content: 'Thanks' }),
      );
      expect(events[events.length - 1]).toMatchObject({
        aiReply: false,
        conversationStatus: 'human_active',
      });
      const detail = await client.getConversation(ctxFor('tenant-a'), id);
      expect(detail.messages.data.map((m) => m.authorType)).toEqual([
        'human',
        'customer',
      ]);
    });

    it('replays the same result for the same Idempotency-Key without storing or answering twice', async () => {
      const { id } = await open();
      const first = await collect(
        client.sendMessage(ctxFor('tenant-a', 'msg-key-1'), id, {
          content: 'What are your opening hours?',
        }),
      );
      const second = await collect(
        client.sendMessage(ctxFor('tenant-a', 'msg-key-1'), id, {
          content: 'What are your opening hours?',
        }),
      );
      const acceptedIds = [first[0], second[0]].map(
        (e) => (e as { messageId: string }).messageId,
      );
      expect(acceptedIds[0]).toBe(acceptedIds[1]);
      const done = (events: EngineStreamEvent[]) =>
        events[events.length - 1] as { messageId: string };
      expect(done(first).messageId).toBe(done(second).messageId);
      const history = await client.getConversation(ctxFor('tenant-a'), id);
      expect(history.messages.total).toBe(2);
    });

    it('refuses a resolved conversation with a conflict', async () => {
      const { id } = await open();
      engine().resolve('tenant-a', id);
      const error = await failure(
        collect(client.sendMessage(ctxFor('tenant-a'), id, { content: 'hi' })),
      );
      expect(error.kind).toBe('conflict');
      const escalate = await failure(
        client.escalate(ctxFor('tenant-a'), id, { reason: 'other' }),
      );
      expect(escalate.kind).toBe('conflict');
    });

    it('reports an unknown conversation as not_found', async () => {
      const error = await failure(
        collect(
          client.sendMessage(ctxFor('tenant-a'), 'no-such-id', {
            content: 'hi',
          }),
        ),
      );
      expect(error.kind).toBe('not_found');
    });
  });

  describe('escalate', () => {
    it('marks the conversation escalated with the reason, without the model, and is idempotent', async () => {
      const { id } = await open();
      const once = await client.escalate(ctxFor('tenant-a', 'e1'), id, {
        reason: 'limit_reached',
      });
      expect(once).toMatchObject({
        status: 'escalated',
        escalationReason: 'limit_reached',
      });
      const twice = await client.escalate(ctxFor('tenant-a', 'e1'), id, {
        reason: 'ai_unavailable',
      });
      // Already escalated: the first reason stands.
      expect(twice.escalationReason).toBe('limit_reached');
      const detail = await client.getConversation(ctxFor('tenant-a'), id);
      expect(detail.messages.total).toBe(0);
    });
  });

  describe('getConversation', () => {
    it('pages the messages oldest first', async () => {
      const { id } = await open();
      for (const content of ['one', 'two', 'three']) {
        await collect(
          client.sendMessage(ctxFor('tenant-a'), id, {
            content,
            aiReply: false,
          }),
        );
      }
      const page = await client.getConversation(ctxFor('tenant-a'), id, {
        skip: 1,
        take: 1,
      });
      expect(page.messages).toMatchObject({ total: 3, skip: 1, take: 1 });
      expect(page.messages.data.map((m) => m.content)).toEqual(['two']);
    });
  });

  describe('the staff side (Phase 4)', () => {
    const staff = (tenantId: string, userId: string, key?: string) => ({
      ...ctxFor(tenantId, key),
      actingUserId: userId,
      actingRole: 'agent',
    });
    const escalate = async (tenantId = 'tenant-a', key = 'k-open') => {
      const { id } = await open(tenantId, key);
      await client.escalate(ctxFor(tenantId, `esc-${key}`), id, {
        reason: 'customer_requested',
        summary: 'wants a human',
      });
      return id;
    };
    const eventTypes = (tenantId = 'tenant-a') =>
      engine()
        .emitted.filter((e) => e.tenantId === tenantId)
        .map((e) => e.type);

    describe('listConversations and countConversations', () => {
      it('filters by status, assignee and customer, and never shows another tenant', async () => {
        const a1 = await escalate('tenant-a', 'one');
        const a2 = (await open('tenant-a', 'two')).id;
        const other = await client.createConversation(
          ctxFor('tenant-a', 'three'),
          {
            channel: 'widget',
            endCustomerId: 'ec-2',
          },
        );
        await client.claimConversation(staff('tenant-a', 'u1'), a1, {
          userId: 'u1',
        });
        await open('tenant-b', 'b1');

        const all = await client.listConversations(ctxFor('tenant-a'), {});
        expect(all.total).toBe(3);
        expect(all.data.map((c) => c.id).sort()).toEqual(
          [a1, a2, other.id].sort(),
        );
        const mine = await client.listConversations(ctxFor('tenant-a'), {
          assignedUserId: 'u1',
        });
        expect(mine.data.map((c) => c.id)).toEqual([a1]);
        expect(mine.data[0]).toMatchObject({
          status: 'human_active',
          assignedUserId: 'u1',
          escalationReason: 'customer_requested',
          summary: 'wants a human',
        });
        const queue = await client.listConversations(ctxFor('tenant-a'), {
          status: ['escalated', 'active'],
        });
        expect(queue.data.map((c) => c.id).sort()).toEqual(
          [a2, other.id].sort(),
        );
        const ofCustomer = await client.listConversations(ctxFor('tenant-a'), {
          endCustomerId: 'ec-2',
        });
        expect(ofCustomer.data.map((c) => c.id)).toEqual([other.id]);
        const theirs = await client.listConversations(ctxFor('tenant-b'), {});
        expect(theirs.total).toBe(1);
      });

      it('sorts the queue by escalation time, oldest first, and pages', async () => {
        const first = await escalate('tenant-a', 'q1');
        await new Promise((r) => setTimeout(r, 5));
        const second = await escalate('tenant-a', 'q2');
        await new Promise((r) => setTimeout(r, 5));
        const third = await escalate('tenant-a', 'q3');
        const queue = await client.listConversations(ctxFor('tenant-a'), {
          status: ['escalated'],
          sort: 'escalatedAt',
        });
        expect(queue.data.map((c) => c.id)).toEqual([first, second, third]);
        const page = await client.listConversations(ctxFor('tenant-a'), {
          status: ['escalated'],
          sort: 'escalatedAt',
          skip: 1,
          take: 1,
        });
        expect(page).toMatchObject({ total: 3, skip: 1, take: 1 });
        expect(page.data.map((c) => c.id)).toEqual([second]);
      });

      it('counts conversations per status (all four keys) and per holder', async () => {
        const a = await escalate('tenant-a', 'c1');
        await escalate('tenant-a', 'c2');
        await open('tenant-a', 'c3');
        await client.claimConversation(staff('tenant-a', 'u1'), a, {
          userId: 'u1',
        });
        await expect(
          client.countConversations(ctxFor('tenant-a')),
        ).resolves.toEqual({
          active: 1,
          escalated: 1,
          human_active: 1,
          resolved: 0,
        });
        await expect(
          client.countConversations(ctxFor('tenant-a'), {
            assignedUserId: 'u1',
          }),
        ).resolves.toEqual({
          active: 0,
          escalated: 0,
          human_active: 1,
          resolved: 0,
        });
        await expect(
          client.countConversations(ctxFor('tenant-b')),
        ).resolves.toEqual({
          active: 0,
          escalated: 0,
          human_active: 0,
          resolved: 0,
        });
      });
    });

    describe('claimConversation', () => {
      it('moves an escalated or active conversation to human_active for the claimant', async () => {
        const escalated = await escalate('tenant-a', 'cl1');
        const active = (await open('tenant-a', 'cl2')).id;
        for (const id of [escalated, active]) {
          const claimed = await client.claimConversation(
            staff('tenant-a', 'u1', `claim-${id}`),
            id,
            { userId: 'u1' },
          );
          expect(claimed).toMatchObject({
            status: 'human_active',
            assignedUserId: 'u1',
          });
        }
      });

      it('answers a second claim with a conflict and the engine code', async () => {
        const id = await escalate();
        await client.claimConversation(staff('tenant-a', 'u1'), id, {
          userId: 'u1',
        });
        const error = await failure(
          client.claimConversation(staff('tenant-a', 'u2'), id, {
            userId: 'u2',
          }),
        );
        expect(error).toMatchObject({
          kind: 'conflict',
          status: 409,
          engineCode: 'CONVERSATION_ALREADY_CLAIMED',
        });
        const detail = await client.getConversation(ctxFor('tenant-a'), id);
        expect(detail.conversation.assignedUserId).toBe('u1');
      });

      it('lets exactly one of several simultaneous claimants win', async () => {
        const id = await escalate();
        const results = await Promise.allSettled(
          ['u1', 'u2', 'u3', 'u4', 'u5'].map((userId) =>
            client.claimConversation(staff('tenant-a', userId), id, { userId }),
          ),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        expect(rejected).toHaveLength(4);
        for (const r of rejected) {
          expect(r.reason).toMatchObject({ kind: 'conflict' });
        }
        const winner = results.find(
          (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
        )!.value;
        const detail = await client.getConversation(ctxFor('tenant-a'), id);
        expect(detail.conversation.assignedUserId).toBe(winner.assignedUserId);
        expect(
          eventTypes().filter((t) => t === 'conversation.assigned'),
        ).toHaveLength(1);
      });

      it('is idempotent by key: a retry of the successful claim is not a conflict', async () => {
        const id = await escalate();
        const first = await client.claimConversation(
          staff('tenant-a', 'u1', 'same-claim'),
          id,
          { userId: 'u1' },
        );
        const again = await client.claimConversation(
          staff('tenant-a', 'u1', 'same-claim'),
          id,
          { userId: 'u1' },
        );
        expect(again).toEqual(first);
      });

      it('refuses a resolved conversation and another tenant’s conversation', async () => {
        const id = await escalate();
        const foreign = await failure(
          client.claimConversation(staff('tenant-b', 'u1'), id, {
            userId: 'u1',
          }),
        );
        expect(foreign.kind).toBe('not_found');
        engine().resolve('tenant-a', id);
        const resolved = await failure(
          client.claimConversation(staff('tenant-a', 'u1'), id, {
            userId: 'u1',
          }),
        );
        expect(resolved).toMatchObject({
          kind: 'conflict',
          engineCode: 'CONVERSATION_RESOLVED',
        });
      });

      it('writes the agent-joined line and keeps the AI silent (C4)', async () => {
        const id = await escalate();
        await client.claimConversation(staff('tenant-a', 'u1'), id, {
          userId: 'u1',
        });
        const events = await collect(
          client.sendMessage(ctxFor('tenant-a'), id, { content: 'hello?' }),
        );
        expect(events[events.length - 1]).toMatchObject({
          aiReply: false,
          conversationStatus: 'human_active',
        });
        const detail = await client.getConversation(ctxFor('tenant-a'), id);
        expect(
          detail.messages.data.map((m) => [m.authorType, m.contentKey]),
        ).toEqual([
          ['system', 'agent.joined'],
          ['customer', null],
        ]);
      });
    });

    describe('sendHumanMessage', () => {
      it('stores the reply as a human message of the assignee, and only the assignee may', async () => {
        const id = await escalate();
        const early = await failure(
          client.sendHumanMessage(staff('tenant-a', 'u1'), id, {
            userId: 'u1',
            content: 'too early',
          }),
        );
        expect(early).toMatchObject({
          kind: 'conflict',
          engineCode: 'CONVERSATION_NOT_ASSIGNED_TO_YOU',
        });
        await client.claimConversation(staff('tenant-a', 'u1'), id, {
          userId: 'u1',
        });
        const intruder = await failure(
          client.sendHumanMessage(staff('tenant-a', 'u2'), id, {
            userId: 'u2',
            content: 'not mine',
          }),
        );
        expect(intruder).toMatchObject({
          kind: 'conflict',
          engineCode: 'CONVERSATION_NOT_ASSIGNED_TO_YOU',
        });
        const message = await client.sendHumanMessage(
          staff('tenant-a', 'u1', 'h1'),
          id,
          { userId: 'u1', content: 'Hello, I can help' },
        );
        expect(message).toMatchObject({
          authorType: 'human',
          authorUserId: 'u1',
          content: 'Hello, I can help',
        });
        const detail = await client.getConversation(ctxFor('tenant-a'), id);
        expect(detail.messages.data.map((m) => m.authorType)).toEqual([
          'system',
          'human',
        ]);
      });

      it('is idempotent by key (a retry does not store the reply twice)', async () => {
        const id = await escalate();
        await client.claimConversation(staff('tenant-a', 'u1'), id, {
          userId: 'u1',
        });
        const a = await client.sendHumanMessage(
          staff('tenant-a', 'u1', 'dup'),
          id,
          {
            userId: 'u1',
            content: 'once',
          },
        );
        const b = await client.sendHumanMessage(
          staff('tenant-a', 'u1', 'dup'),
          id,
          {
            userId: 'u1',
            content: 'once',
          },
        );
        expect(b.id).toBe(a.id);
        const detail = await client.getConversation(ctxFor('tenant-a'), id);
        expect(
          detail.messages.data.filter((m) => m.authorType === 'human'),
        ).toHaveLength(1);
      });

      it('refuses a resolved conversation and another tenant', async () => {
        const id = await escalate();
        await client.claimConversation(staff('tenant-a', 'u1'), id, {
          userId: 'u1',
        });
        const foreign = await failure(
          client.sendHumanMessage(staff('tenant-b', 'u1'), id, {
            userId: 'u1',
            content: 'x',
          }),
        );
        expect(foreign.kind).toBe('not_found');
        engine().resolve('tenant-a', id);
        const resolved = await failure(
          client.sendHumanMessage(staff('tenant-a', 'u1'), id, {
            userId: 'u1',
            content: 'x',
          }),
        );
        expect(resolved).toMatchObject({
          kind: 'conflict',
          engineCode: 'CONVERSATION_RESOLVED',
        });
      });
    });

    describe('releaseConversation and resolveConversation', () => {
      const claimed = async (userId = 'u1') => {
        const id = await escalate();
        await client.claimConversation(staff('tenant-a', userId), id, {
          userId,
        });
        return id;
      };

      it('release to active hands the conversation back to the AI', async () => {
        const id = await claimed();
        const released = await client.releaseConversation(
          staff('tenant-a', 'u1'),
          id,
          {
            userId: 'u1',
            to: 'active',
          },
        );
        expect(released).toMatchObject({
          status: 'active',
          assignedUserId: null,
        });
        const events = await collect(
          client.sendMessage(ctxFor('tenant-a'), id, {
            content: 'What are your opening hours?',
          }),
        );
        expect(events[events.length - 1]).toMatchObject({
          aiReply: true,
          conversationStatus: 'active',
        });
        const detail = await client.getConversation(ctxFor('tenant-a'), id);
        expect(detail.messages.data[0]).toMatchObject({
          contentKey: 'agent.joined',
        });
        expect(detail.messages.data[1]).toMatchObject({
          contentKey: 'agent.left',
        });
      });

      it('release to escalated puts it back in the queue and keeps its place', async () => {
        const id = await claimed();
        const before = (await client.getConversation(ctxFor('tenant-a'), id))
          .conversation;
        const released = await client.releaseConversation(
          staff('tenant-a', 'u1'),
          id,
          {
            userId: 'u1',
            to: 'escalated',
          },
        );
        expect(released).toMatchObject({
          status: 'escalated',
          assignedUserId: null,
        });
        expect(released.escalatedAt).toBe(before.escalatedAt);
      });

      it('release to resolved is the same as resolving', async () => {
        const id = await claimed();
        const released = await client.releaseConversation(
          staff('tenant-a', 'u1'),
          id,
          {
            userId: 'u1',
            to: 'resolved',
          },
        );
        expect(released).toMatchObject({
          status: 'resolved',
          resolvedBy: 'human',
        });
        expect(released.resolvedAt).toEqual(expect.any(String));
      });

      it('only the assignee may release or resolve, unless the backend forces a release (holder gone)', async () => {
        const id = await claimed('u1');
        for (const attempt of [
          () =>
            client.releaseConversation(staff('tenant-a', 'u2'), id, {
              userId: 'u2',
              to: 'active',
            }),
          () =>
            client.resolveConversation(staff('tenant-a', 'u2'), id, {
              userId: 'u2',
            }),
        ]) {
          await expect(failure(attempt())).resolves.toMatchObject({
            kind: 'conflict',
            engineCode: 'CONVERSATION_NOT_ASSIGNED_TO_YOU',
          });
        }
        const forced = await client.releaseConversation(
          staff('tenant-a', 'admin-1'),
          id,
          {
            userId: 'admin-1',
            to: 'escalated',
            force: true,
            reason: 'assignee_disabled',
          },
        );
        expect(forced).toMatchObject({
          status: 'escalated',
          assignedUserId: null,
        });
      });

      it('resolve closes the conversation: later customer messages are refused', async () => {
        const id = await claimed();
        const resolved = await client.resolveConversation(
          staff('tenant-a', 'u1'),
          id,
          {
            userId: 'u1',
          },
        );
        expect(resolved).toMatchObject({
          status: 'resolved',
          resolvedBy: 'human',
        });
        const error = await failure(
          collect(
            client.sendMessage(ctxFor('tenant-a'), id, { content: 'hi' }),
          ),
        );
        expect(error.kind).toBe('conflict');
        const again = await failure(
          client.resolveConversation(staff('tenant-a', 'u1'), id, {
            userId: 'u1',
          }),
        );
        expect(again).toMatchObject({
          kind: 'conflict',
          engineCode: 'CONVERSATION_RESOLVED',
        });
      });

      it('a conversation nobody holds cannot be released or resolved', async () => {
        const id = await escalate();
        await expect(
          failure(
            client.releaseConversation(staff('tenant-a', 'u1'), id, {
              userId: 'u1',
              to: 'active',
            }),
          ),
        ).resolves.toMatchObject({
          engineCode: 'CONVERSATION_NOT_ASSIGNED_TO_YOU',
        });
      });
    });

    describe('events (D5)', () => {
      it('emits the events of the whole hand-off, in order, with the envelope tenant', async () => {
        const id = await escalate();
        await client.claimConversation(staff('tenant-a', 'u1'), id, {
          userId: 'u1',
        });
        await client.sendHumanMessage(staff('tenant-a', 'u1'), id, {
          userId: 'u1',
          content: 'hello',
        });
        await client.releaseConversation(staff('tenant-a', 'u1'), id, {
          userId: 'u1',
          to: 'active',
        });
        expect(eventTypes()).toEqual([
          'conversation.created',
          'conversation.escalated',
          'conversation.assigned',
          'message.created', // agent joined
          'message.created', // the reply
          'conversation.released',
          'message.created', // agent left
        ]);
        const reply = engine()
          .emitted.filter((e) => e.type === 'message.created')
          .at(1)!;
        expect(reply).toMatchObject({
          tenantId: 'tenant-a',
          data: { authorType: 'human', content: 'hello', authorUserId: 'u1' },
        });
        expect(reply.id).toEqual(expect.any(String));
        expect(Date.parse(reply.occurredAt)).not.toBeNaN();
      });

      it('sends no message text of customer or AI messages, and a usage event for the AI reply', async () => {
        const { id } = await open();
        await collect(
          client.sendMessage(ctxFor('tenant-a'), id, {
            content: 'What are your opening hours?',
          }),
        );
        const created = engine().emitted.filter(
          (e) => e.type === 'message.created',
        );
        expect(created.map((e) => e.data.authorType)).toEqual([
          'customer',
          'ai',
        ]);
        for (const event of created) {
          expect(event.data).not.toHaveProperty('content');
        }
        const usage = engine().emitted.find(
          (e) => e.type === 'usage.recorded',
        )!;
        expect(usage.data).toMatchObject({
          conversationId: id,
          tokensIn: expect.any(Number),
          tokensOut: expect.any(Number),
          model: 'mock-llm-1',
        });
        expect(created[1].data.messageId).toBe(usage.data.messageId);
      });
    });

    if (kind === 'http') {
      it('sends who is acting (X-Acting-User-Id and X-Acting-Role) with a staff call, and the tenant header', async () => {
        const id = await escalate();
        fake!.requests.length = 0;
        await client.claimConversation(staff('tenant-a', 'u7', 'a-key'), id, {
          userId: 'u7',
        });
        const request = fake!.requests.at(-1)!;
        expect(request).toMatchObject({
          method: 'POST',
          path: `/internal/conversations/${id}/claim`,
          body: { userId: 'u7' },
        });
        expect(request.headers).toMatchObject({
          authorization: `Bearer ${TOKEN}`,
          'x-tenant-id': 'tenant-a',
          'x-acting-user-id': 'u7',
          'x-acting-role': 'agent',
          'idempotency-key': 'a-key',
          'x-request-id': 'req-1',
        });
      });
    }
  });
});

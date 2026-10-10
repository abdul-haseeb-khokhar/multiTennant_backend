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
});

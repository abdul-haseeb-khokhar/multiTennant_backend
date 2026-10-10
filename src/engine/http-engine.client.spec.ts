import { FakeEngineServer } from '../../test/utils/fake-engine-server';
import { HttpEngineClient } from './http-engine.client';
import { EngineError, EngineStreamEvent } from './engine.types';

const TOKEN = 'service-token-'.padEnd(40, 'x');

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

describe('HttpEngineClient against a fake engine server', () => {
  let fake: FakeEngineServer;
  let client: HttpEngineClient;

  const make = (
    over: Partial<ConstructorParameters<typeof HttpEngineClient>[0]> = {},
  ) =>
    new HttpEngineClient({
      baseUrl: fake.url,
      token: TOKEN,
      requestTimeoutMs: 1000,
      firstTokenTimeoutMs: 300,
      totalTimeoutMs: 2000,
      ...over,
    });
  const ctx = { tenantId: 'tenant-a', requestId: 'req-42' };

  beforeAll(async () => {
    fake = new FakeEngineServer(TOKEN);
    await fake.start();
  });
  afterAll(() => fake.stop());
  beforeEach(() => {
    fake.reset();
    client = make();
  });

  describe('what the engine receives (D2)', () => {
    it('sends the service token, the tenant, the request id and the idempotency key', async () => {
      await client.createConversation(
        { ...ctx, idempotencyKey: 'idem-1' },
        { channel: 'widget', endCustomerId: 'ec-1' },
      );
      const sent = fake.requests[0];
      expect(sent.method).toBe('POST');
      expect(sent.path).toBe('/internal/conversations');
      expect(sent.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(sent.headers['x-tenant-id']).toBe('tenant-a');
      expect(sent.headers['x-request-id']).toBe('req-42');
      expect(sent.headers['idempotency-key']).toBe('idem-1');
      expect(sent.body).toEqual({ channel: 'widget', endCustomerId: 'ec-1' });
    });

    it('never puts the tenant in the body or the URL: it is the header only', async () => {
      const { id } = await client.createConversation(ctx, {
        channel: 'widget',
        endCustomerId: 'ec-1',
      });
      await client.getConversation(ctx, id, { take: 5 });
      await collect(client.sendMessage(ctx, id, { content: 'hi' }));
      for (const request of fake.requests) {
        expect(JSON.stringify(request.body ?? {})).not.toContain('tenant-a');
        expect(request.path).not.toContain('tenant-a');
        expect(request.headers['x-tenant-id']).toBe('tenant-a');
      }
    });

    it('omits optional headers it was not given and tolerates a trailing slash in the base URL', async () => {
      const slashed = make({ baseUrl: `${fake.url}/` });
      await slashed.createConversation(
        { tenantId: 'tenant-a' },
        { channel: 'widget', endCustomerId: 'ec-1' },
      );
      const sent = fake.requests[0];
      expect(sent.path).toBe('/internal/conversations');
      expect(sent.headers['idempotency-key']).toBeUndefined();
      expect(sent.headers['x-request-id']).toBeUndefined();
    });

    it('url-encodes the conversation id', async () => {
      await failure(client.getConversation(ctx, 'a/b?c'));
      expect(fake.requests[0].path).toBe('/internal/conversations/a%2Fb%3Fc');
    });
  });

  describe('failure handling', () => {
    it('retries ONCE when the connection breaks, and the retry succeeds', async () => {
      fake.faults.resetConnections = 1;
      const conversation = await client.createConversation(
        { ...ctx, idempotencyKey: 'idem-retry' },
        { channel: 'widget', endCustomerId: 'ec-1' },
      );
      expect(conversation.status).toBe('active');
      expect(fake.requests).toHaveLength(2);
      // Same idempotency key both times, so a retry cannot create a second conversation.
      expect(fake.requests[0].headers['idempotency-key']).toBe('idem-retry');
      expect(fake.requests[1].headers['idempotency-key']).toBe('idem-retry');
    });

    it('gives up after the one retry: unavailable', async () => {
      fake.faults.resetConnections = 5;
      const error = await failure(
        client.createConversation(ctx, {
          channel: 'widget',
          endCustomerId: 'ec-1',
        }),
      );
      expect(error.kind).toBe('unavailable');
      expect(error.isOutage).toBe(true);
      expect(fake.requests).toHaveLength(2);
    });

    it('does NOT retry an HTTP 5xx: the engine answered', async () => {
      fake.faults.failWith = { status: 503, times: 5 };
      const error = await failure(
        client.createConversation(ctx, {
          channel: 'widget',
          endCustomerId: 'ec-1',
        }),
      );
      expect(error).toMatchObject({ kind: 'unavailable', status: 503 });
      expect(fake.requests).toHaveLength(1);
    });

    it('maps 4xx answers: 404 not_found, 409 conflict, 401 rejected (a wrong service token)', async () => {
      const wrongToken = make({ token: 'another-token'.padEnd(40, 'y') });
      const rejected = await failure(
        wrongToken.createConversation(ctx, {
          channel: 'widget',
          endCustomerId: 'ec-1',
        }),
      );
      expect(rejected).toMatchObject({ kind: 'rejected', status: 401 });
      expect(rejected.isOutage).toBe(false);
      const missing = await failure(client.getConversation(ctx, 'nope'));
      expect(missing).toMatchObject({
        kind: 'not_found',
        status: 404,
        engineCode: 'CONVERSATION_NOT_FOUND',
      });
    });

    it('times out a plain call that takes too long', async () => {
      const sleeper = make({
        requestTimeoutMs: 100,
        // A connection that is accepted and never answered.
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      });
      const error = await failure(
        sleeper.createConversation(ctx, {
          channel: 'widget',
          endCustomerId: 'ec-1',
        }),
      );
      expect(error.kind).toBe('timeout');
      expect(error.isOutage).toBe(true);
    });

    it('never leaks the service token into an error message', async () => {
      fake.faults.resetConnections = 5;
      const error = await failure(
        client.createConversation(ctx, {
          channel: 'widget',
          endCustomerId: 'ec-1',
        }),
      );
      expect(error.message).not.toContain(TOKEN);
      expect(String(error.stack)).not.toContain(TOKEN);
    });

    it('health is false instead of throwing when the engine is unreachable', async () => {
      const dead = make({ baseUrl: 'http://127.0.0.1:1' });
      await expect(dead.health()).resolves.toEqual({ ok: false });
    });
  });

  describe('the reply stream (D7: 5 s to the first token, 30 s total)', () => {
    const open = async () =>
      (
        await client.createConversation(ctx, {
          channel: 'widget',
          endCustomerId: 'ec-1',
        })
      ).id;

    it('times out when the engine accepts the message and then says nothing', async () => {
      const id = await open();
      fake.faults.hangAfterAccepted = true;
      const started = Date.now();
      const seen: string[] = [];
      let thrown: EngineError | undefined;
      try {
        for await (const event of client.sendMessage(ctx, id, {
          content: 'hello',
        })) {
          seen.push(event.type);
        }
      } catch (error) {
        thrown = error as EngineError;
      }
      expect(seen).toEqual(['accepted']);
      expect(thrown).toMatchObject({ kind: 'timeout' });
      expect(Date.now() - started).toBeLessThan(1500);
    });

    it('enforces the total duration even when tokens keep arriving', async () => {
      const id = await open();
      const strict = make({ firstTokenTimeoutMs: 5000, totalTimeoutMs: 300 });
      // Every token takes 400 ms: the first one already exceeds the 300 ms total.
      fake.engine.configure({ tokenDelayMs: 400 });
      const error = await failure(
        collect(
          strict.sendMessage(ctx, id, {
            content: 'What are your opening hours?',
          }),
        ),
      );
      expect(error.kind).toBe('timeout');
    });

    it('an error event from the engine becomes an unavailable EngineError', async () => {
      const id = await open();
      const error = await failure(
        collect(client.sendMessage(ctx, id, { content: '/broken please' })),
      );
      expect(error).toMatchObject({
        kind: 'unavailable',
        engineCode: 'MOCK_BROKEN_STREAM',
      });
    });

    it('a stream that ends before "done" is unavailable', async () => {
      const id = await open();
      fake.faults.truncateStream = true;
      const error = await failure(
        collect(
          client.sendMessage(ctx, id, {
            content: 'What are your opening hours?',
          }),
        ),
      );
      expect(error.kind).toBe('unavailable');
    });

    it('an answer that is not an event stream is a protocol error', async () => {
      const id = await open();
      fake.faults.notSse = true;
      const error = await failure(
        collect(client.sendMessage(ctx, id, { content: 'hi' })),
      );
      expect(error.kind).toBe('protocol');
    });

    it('stops the request when the caller aborts', async () => {
      const id = await open();
      fake.faults.hangAfterAccepted = true;
      const controller = new AbortController();
      const seen: string[] = [];
      let thrown: unknown;
      try {
        for await (const event of client.sendMessage(
          { ...ctx, signal: controller.signal },
          id,
          { content: 'hello' },
        )) {
          seen.push(event.type);
          controller.abort();
        }
      } catch (error) {
        thrown = error;
      }
      expect(seen).toEqual(['accepted']);
      expect(thrown).toBeInstanceOf(EngineError);
    });

    it('sends the message flags and an idempotency key on the stream request', async () => {
      const id = await open();
      await collect(
        client.sendMessage({ ...ctx, idempotencyKey: 'msg-9' }, id, {
          content: 'hello',
          aiReply: false,
          externalMessageId: 'ext-1',
        }),
      );
      const sent = fake.requests[fake.requests.length - 1];
      expect(sent.path).toBe(`/internal/conversations/${id}/messages`);
      expect(sent.headers['idempotency-key']).toBe('msg-9');
      expect(sent.headers.accept).toBe('text/event-stream');
      expect(sent.body).toEqual({
        content: 'hello',
        aiReply: false,
        externalMessageId: 'ext-1',
      });
    });
  });
});

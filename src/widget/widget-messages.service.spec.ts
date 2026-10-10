import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { RateLimiter } from '../common/throttle/rate-limiter';
import {
  DEFAULT_MOCK_OPTIONS,
  MockEngineClient,
} from '../engine/mock-engine.client';
import { I18nService } from '../i18n/i18n.service';
import { WidgetAuth } from './widget-auth';
import { WidgetMessagesService, WidgetEvent } from './widget-messages.service';
import { WidgetRateLimitService } from './widget-rate-limit.service';
import {
  DefaultWidgetSettingsProvider,
  WidgetTextService,
} from './widget-text.service';
import { DEFAULT_WIDGET_LIMITS } from './widget.constants';

const auth = (over: Partial<WidgetAuth> = {}): WidgetAuth => ({
  tenantId: 'tenant-a',
  endCustomerId: 'ec-1',
  conversationId: 'conv-1',
  keyId: 'key-1',
  locale: 'en',
  origin: 'https://shop.example.com',
  ...over,
});

async function collect(events: AsyncGenerator<WidgetEvent>) {
  const out: WidgetEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('WidgetMessagesService (focused cases; the full flows are in test/widget.e2e-spec.ts)', () => {
  let prisma: PrismaMock;
  let engine: MockEngineClient;
  let usage: { recordMessage: jest.Mock };
  let sessions: { chatGate: jest.Mock };
  let service: WidgetMessagesService;
  let conversationId: string;

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'gc-1',
    tenantId: 'tenant-a',
    endCustomerId: 'ec-1',
    conversationId,
    aiBlocked: false,
    escalationReason: null,
    escalationPending: false,
    closedAt: null,
    ...over,
  });

  beforeEach(async () => {
    prisma = createPrismaMock();
    engine = new MockEngineClient({
      ...DEFAULT_MOCK_OPTIONS,
      tokenDelayMs: 0,
      firstTokenTimeoutMs: 200,
    });
    ({ id: conversationId } = await engine.createConversation(
      { tenantId: 'tenant-a' },
      { channel: 'widget', endCustomerId: 'ec-1' },
    ));
    usage = { recordMessage: jest.fn().mockResolvedValue(true) };
    sessions = { chatGate: jest.fn().mockResolvedValue({ open: true }) };
    prisma.gatewayConversation.findFirst.mockImplementation(() =>
      Promise.resolve(row()),
    );
    prisma.gatewayConversation.updateMany.mockResolvedValue({ count: 1 });
    service = new WidgetMessagesService(
      prisma as never,
      engine,
      usage as never,
      sessions as never,
      new WidgetTextService(
        new I18nService(),
        new DefaultWidgetSettingsProvider(),
      ),
      new WidgetRateLimitService(new RateLimiter(), DEFAULT_WIDGET_LIMITS),
    );
  });

  const run = async (
    content: string,
    over: Partial<WidgetAuth> = {},
    key?: string,
  ) => {
    const prepared = await service.prepare(
      auth({ conversationId, ...over }),
      { content },
      { ip: '1.1.1.1', idempotencyKey: key },
      new AbortController().signal,
    );
    return collect(prepared.events);
  };

  it('looks the conversation up by tenant, end customer AND conversation, never by id alone', async () => {
    await run('hello');
    expect(prisma.gatewayConversation.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-a',
        endCustomerId: 'ec-1',
        conversationId,
        closedAt: null,
      },
    });
  });

  it('a failing usage counter never breaks the chat', async () => {
    usage.recordMessage.mockRejectedValue(new Error('db hiccup'));
    const events = await run('What are your opening hours?');
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(['accepted', 'token', 'done']),
    );
    expect(events.map((e) => e.event)).not.toContain('error');
  });

  it('counts the customer message and the reply under their own ids, with the tokens on the reply', async () => {
    await run('What are your opening hours?');
    const calls = usage.recordMessage.mock.calls.map((c) => c[1]);
    const withTokens = calls.filter((c) => c.tokensIn !== undefined);
    expect(withTokens).toHaveLength(1);
    expect(withTokens[0].tokensIn).toBeGreaterThan(0);
    // accepted + usage + done: the same reply id is reported twice and dedupes downstream.
    const ids = calls.map((c) => c.messageId);
    expect(new Set(ids).size).toBe(2);
  });

  it('escalates once for the plan limit even when the same message is repeated', async () => {
    prisma.gatewayConversation.findFirst.mockImplementation(() =>
      Promise.resolve(row({ aiBlocked: true })),
    );
    const spy = jest.spyOn(engine, 'escalate');
    await run('first');
    prisma.gatewayConversation.findFirst.mockImplementation(() =>
      Promise.resolve(
        row({ aiBlocked: true, escalationReason: 'limit_reached' }),
      ),
    );
    const second = await run('second');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.at(-1)).toMatchObject({
      event: 'fallback',
      data: { reason: 'limit_reached', escalated: true },
    });
  });

  it('retries a remembered escalation that never reached the engine', async () => {
    prisma.gatewayConversation.findFirst.mockImplementation(() =>
      Promise.resolve(
        row({
          aiBlocked: true,
          escalationReason: 'limit_reached',
          escalationPending: true,
        }),
      ),
    );
    const spy = jest.spyOn(engine, 'escalate');
    await run('hello again');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(prisma.gatewayConversation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { escalationReason: 'limit_reached', escalationPending: false },
      }),
    );
  });

  it('a closed or missing gateway row is a 404, before anything reaches the engine', async () => {
    prisma.gatewayConversation.findFirst.mockResolvedValue(null);
    const spy = jest.spyOn(engine, 'sendMessage');
    await expect(
      service.prepare(
        auth({ conversationId }),
        { content: 'hi' },
        { ip: '1.1.1.1' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not answer a customer who left: an aborted call produces no fallback and no escalation', async () => {
    const controller = new AbortController();
    const prepared = await service.prepare(
      auth({ conversationId }),
      { content: '/slow' },
      { ip: '1.1.1.1' },
      controller.signal,
    );
    const spy = jest.spyOn(engine, 'escalate');
    const events: WidgetEvent[] = [];
    for await (const event of prepared.events) {
      events.push(event);
      controller.abort();
    }
    expect(events.map((e) => e.event)).toEqual(['accepted']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('namespaces the idempotency key by conversation, so a key cannot collide across conversations', async () => {
    const spy = jest.spyOn(engine, 'sendMessage');
    await run('hello', {}, 'client-key-0001');
    expect(spy.mock.calls[0][0].idempotencyKey).toBe(
      `${conversationId}:client-key-0001`,
    );
  });
});

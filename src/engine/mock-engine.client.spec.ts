import {
  DEFAULT_MOCK_OPTIONS,
  MOCK_COMMANDS,
  MockEngineClient,
} from './mock-engine.client';
import { EngineError, EngineStreamEvent } from './engine.types';

async function collect(events: AsyncIterable<EngineStreamEvent>) {
  const out: EngineStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const ctx = { tenantId: 'tenant-a' };

describe('MockEngineClient: commands for testers and the frontend prototype', () => {
  let engine: MockEngineClient;
  let id: string;

  beforeEach(async () => {
    engine = new MockEngineClient({
      ...DEFAULT_MOCK_OPTIONS,
      tokenDelayMs: 0,
      firstTokenTimeoutMs: 150,
      totalTimeoutMs: 1000,
    });
    ({ id } = await engine.createConversation(ctx, {
      channel: 'widget',
      endCustomerId: 'ec-1',
    }));
  });

  it(`${MOCK_COMMANDS.ESCALATE} forces an escalation with a handoff reply`, async () => {
    const events = await collect(
      engine.sendMessage(ctx, id, { content: '/escalate' }),
    );
    expect(events.find((e) => e.type === 'escalated')).toMatchObject({
      reason: 'customer_requested',
    });
    expect(engine.inspect('tenant-a', id)?.conversation.status).toBe(
      'escalated',
    );
  });

  it(`${MOCK_COMMANDS.FAIL} behaves like an unreachable engine and stores nothing`, async () => {
    await expect(
      collect(engine.sendMessage(ctx, id, { content: '/fail' })),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(engine.inspect('tenant-a', id)?.messages).toHaveLength(0);
  });

  it(`${MOCK_COMMANDS.SLOW} never answers: the first-token timeout fires`, async () => {
    const seen: string[] = [];
    let error: unknown;
    try {
      for await (const event of engine.sendMessage(ctx, id, {
        content: '/slow',
      })) {
        seen.push(event.type);
      }
    } catch (caught) {
      error = caught;
    }
    expect(seen).toEqual(['accepted']);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).kind).toBe('timeout');
  });

  it(`${MOCK_COMMANDS.BROKEN_STREAM} fails after the first words`, async () => {
    const seen: string[] = [];
    let error: unknown;
    try {
      for await (const event of engine.sendMessage(ctx, id, {
        content: '/broken',
      })) {
        seen.push(event.type);
      }
    } catch (caught) {
      error = caught;
    }
    expect(seen).toEqual(['accepted', 'token']);
    expect((error as EngineError).kind).toBe('unavailable');
  });

  it('setDown makes every call fail until it is switched off', async () => {
    engine.setDown(true);
    await expect(engine.health()).resolves.toEqual({ ok: false });
    await expect(
      engine.createConversation(ctx, { channel: 'widget', endCustomerId: 'x' }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    engine.setDown(false);
    await expect(engine.health()).resolves.toEqual({ ok: true });
  });

  it('a request for a human in Urdu escalates too', async () => {
    const events = await collect(
      engine.sendMessage(ctx, id, { content: 'مجھے انسان سے بات کرنی ہے' }),
    );
    expect(events.some((e) => e.type === 'escalated')).toBe(true);
  });

  it('streams a reply whose tokens add up to the stored reply', async () => {
    const events = await collect(
      engine.sendMessage(ctx, id, { content: 'delivery time?' }),
    );
    const text = events
      .filter(
        (e): e is Extract<EngineStreamEvent, { type: 'token' }> =>
          e.type === 'token',
      )
      .map((e) => e.text)
      .join('');
    const stored = engine.inspect('tenant-a', id)!.messages;
    expect(stored[1].content).toBe(text);
    expect(text).toContain('2 to 4 working days');
  });

  it('reset forgets everything', () => {
    engine.reset();
    expect(engine.inspect('tenant-a', id)).toBeNull();
    expect(engine.conversationCount('tenant-a')).toBe(0);
  });
});

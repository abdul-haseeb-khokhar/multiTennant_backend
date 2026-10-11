import {
  DEFAULT_MOCK_OPTIONS,
  MOCK_COMMANDS,
  MockEngineClient,
} from './mock-engine.client';
import {
  EngineError,
  EngineEventEnvelope,
  EngineStreamEvent,
} from './engine.types';

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

describe('MockEngineClient: the events it pushes to the backend (D5, Phase 4)', () => {
  const ctx = { tenantId: 'tenant-a' };
  let engine: MockEngineClient;
  let delivered: EngineEventEnvelope[];

  beforeEach(() => {
    engine = new MockEngineClient({ ...DEFAULT_MOCK_OPTIONS, tokenDelayMs: 0 });
    delivered = [];
    engine.setEventSink(async (event) => {
      delivered.push(event);
    });
  });

  it('delivers events to the sink in the order they happened, after the command returned', async () => {
    const { id } = await engine.createConversation(ctx, {
      channel: 'widget',
      endCustomerId: 'ec-1',
    });
    await engine.escalate(ctx, id, { reason: 'other' });
    await engine.claimConversation({ ...ctx, actingUserId: 'u1' }, id, {
      userId: 'u1',
    });
    await engine.flushEvents();
    expect(delivered.map((e) => e.type)).toEqual([
      'conversation.created',
      'conversation.escalated',
      'conversation.assigned',
      'message.created',
    ]);
    expect(delivered.every((e) => e.tenantId === 'tenant-a')).toBe(true);
    expect(new Set(delivered.map((e) => e.id)).size).toBe(delivered.length);
  });

  it('delivers one event at a time even when the sink is slow', async () => {
    let running = 0;
    let maxRunning = 0;
    engine.setEventSink(async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
    });
    const { id } = await engine.createConversation(ctx, {
      channel: 'widget',
      endCustomerId: 'ec-1',
    });
    await engine.escalate(ctx, id, { reason: 'other' });
    await engine.flushEvents();
    expect(maxRunning).toBe(1);
  });

  it('a sink that fails never breaks the engine call, and later events still arrive', async () => {
    let calls = 0;
    engine.setEventSink(async () => {
      calls += 1;
      if (calls === 1) throw new Error('backend down');
    });
    const { id } = await engine.createConversation(ctx, {
      channel: 'widget',
      endCustomerId: 'ec-1',
    });
    await engine.escalate(ctx, id, { reason: 'other' });
    await engine.flushEvents();
    expect(calls).toBe(2);
  });

  it('works without a sink and keeps a history for assertions', async () => {
    engine.setEventSink(undefined);
    const { id } = await engine.createConversation(ctx, {
      channel: 'widget',
      endCustomerId: 'ec-1',
    });
    await engine.flushEvents();
    expect(
      engine.eventsOf('tenant-a', 'conversation.created')[0].data,
    ).toMatchObject({
      conversationId: id,
    });
    expect(engine.eventsOf('tenant-b', 'conversation.created')).toEqual([]);
  });

  it('reset forgets the conversations and the history but keeps the sink', async () => {
    await engine.createConversation(ctx, {
      channel: 'widget',
      endCustomerId: 'ec-1',
    });
    engine.reset();
    expect(engine.emitted).toEqual([]);
    await engine.createConversation(ctx, {
      channel: 'widget',
      endCustomerId: 'ec-1',
    });
    await engine.flushEvents();
    expect(delivered).toHaveLength(2);
  });

  it(`${MOCK_COMMANDS.PROPOSE_ACTION} makes the AI propose an action that needs approval`, async () => {
    const { id } = await engine.createConversation(ctx, {
      channel: 'widget',
      endCustomerId: 'ec-1',
    });
    const events = [];
    for await (const event of engine.sendMessage(ctx, id, {
      content: '/action please refund me',
    })) {
      events.push(event.type);
    }
    expect(events).toContain('done');
    await engine.flushEvents();
    const proposed = delivered.find((e) => e.type === 'action.proposed');
    expect(proposed?.data).toMatchObject({
      conversationId: id,
      action: 'refund',
      actionId: expect.any(String),
    });
    // the AI still answered, and the conversation was not escalated by it
    expect(engine.inspect('tenant-a', id)?.conversation.status).toBe('active');
  });

  it('a word that asks for a human triggers the whole escalation: AI reply, usage, escalated event', async () => {
    const { id } = await engine.createConversation(ctx, {
      channel: 'widget',
      endCustomerId: 'ec-1',
    });
    for await (const _ of engine.sendMessage(ctx, id, {
      content: 'I want to speak to an agent',
    })) {
      // drain
    }
    await engine.flushEvents();
    const types = delivered.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(['usage.recorded', 'conversation.escalated']),
    );
    expect(
      delivered.find((e) => e.type === 'conversation.escalated')?.data,
    ).toMatchObject({
      conversationId: id,
      reason: 'customer_requested',
      summary: 'The customer asked for a human.',
    });
    expect(engine.inspect('tenant-a', id)?.conversation).toMatchObject({
      status: 'escalated',
      summary: 'The customer asked for a human.',
      escalatedAt: expect.any(String),
    });
  });

  it('does not emit again for a replayed command (same Idempotency-Key)', async () => {
    const { id } = await engine.createConversation(ctx, {
      channel: 'widget',
      endCustomerId: 'ec-1',
    });
    await engine.escalate({ ...ctx, idempotencyKey: 'e1' }, id, {
      reason: 'other',
    });
    await engine.escalate({ ...ctx, idempotencyKey: 'e1' }, id, {
      reason: 'other',
    });
    await engine.flushEvents();
    expect(
      delivered.filter((e) => e.type === 'conversation.escalated'),
    ).toHaveLength(1);
  });
});

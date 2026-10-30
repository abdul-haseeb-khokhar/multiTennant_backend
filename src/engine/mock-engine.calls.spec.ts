import {
  DEFAULT_MOCK_OPTIONS,
  MOCK_COMMANDS,
  MockAgentUnavailableError,
  MockEngineClient,
} from './mock-engine.client';
import {
  AgentConfigSource,
  EngineEventEnvelope,
  EngineStreamEvent,
} from './engine.types';

async function collect(events: AsyncIterable<EngineStreamEvent>) {
  const out: EngineStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const ctx = { tenantId: 'tenant-a' };
const REFERENCE = /^(AP|CB)-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;

/** The call-shaped simulation of Phase 5A: a saved request, its update and the call minutes (L1, L4). */
describe('MockEngineClient: a simulated phone call', () => {
  let engine: MockEngineClient;
  let delivered: EngineEventEnvelope[];

  beforeEach(() => {
    engine = new MockEngineClient({
      ...DEFAULT_MOCK_OPTIONS,
      tokenDelayMs: 0,
      firstTokenTimeoutMs: 150,
      totalTimeoutMs: 1000,
    });
    // A local array: a late delivery of an earlier test must not land in this test.
    const mine: EngineEventEnvelope[] = [];
    delivered = mine;
    engine.setEventSink(async (event) => {
      mine.push(event);
    });
  });

  describe('simulateCall', () => {
    it('saves a request with a readable reference and reports it with the call length, in the order a call happens', async () => {
      const call = await engine.simulateCall('tenant-a', { seconds: 185 });
      await engine.flushEvents();
      expect(call.reference).toMatch(REFERENCE);
      expect(call.type).toBe('appointment');
      expect(call.seconds).toBe(185);
      expect(delivered.map((e) => e.type)).toEqual([
        'conversation.created',
        'record.submitted',
        'usage.call_minutes',
      ]);
      expect(delivered[0].data).toMatchObject({
        conversationId: call.conversationId,
        channel: 'voice',
      });
      expect(delivered[1].data).toEqual({
        recordId: call.recordId,
        reference: call.reference,
        type: 'appointment',
        conversationId: call.conversationId,
        endCustomerId: call.endCustomerId,
        channel: 'voice',
        agentId: null,
      });
      expect(delivered[2].data).toEqual({
        conversationId: call.conversationId,
        seconds: 185,
        channel: 'voice',
        agentId: null,
      });
      // every event is for the tenant of the call and has its own id
      expect(new Set(delivered.map((e) => e.tenantId))).toEqual(
        new Set(['tenant-a']),
      );
      expect(new Set(delivered.map((e) => e.id)).size).toBe(3);
    });

    it('keeps the request as the engine would: status requested, summary, wall-clock time as a string', async () => {
      const call = await engine.simulateCall('tenant-a');
      expect(engine.inspectRecord('tenant-a', call.reference)).toMatchObject({
        id: call.recordId,
        type: 'appointment',
        status: 'requested',
        scheduledLocal: '2026-11-03 15:30',
        revision: 0,
      });
      expect(engine.recordsOf('tenant-a')).toHaveLength(1);
    });

    it('can simulate a call-back request without a time', async () => {
      const call = await engine.simulateCall('tenant-a', { type: 'callback' });
      expect(call.reference).toMatch(/^CB-/);
      expect(engine.inspectRecord('tenant-a', call.reference)).toMatchObject({
        type: 'callback',
        scheduledLocal: null,
      });
    });

    it('the call conversation is a finished voice conversation and counts as one for the tenant', async () => {
      const call = await engine.simulateCall('tenant-a');
      expect(engine.inspect('tenant-a', call.conversationId)).toMatchObject({
        conversation: {
          channel: 'voice',
          status: 'resolved',
          resolvedBy: 'ai',
        },
      });
      await expect(
        engine.listConversations(ctx, { status: ['resolved'] }),
      ).resolves.toMatchObject({ total: 1 });
    });

    it('rounds nonsense lengths to a whole, non-negative number of seconds', async () => {
      expect(
        (await engine.simulateCall('tenant-a', { seconds: -5 })).seconds,
      ).toBe(0);
      expect(
        (await engine.simulateCall('tenant-a', { seconds: 61.9 })).seconds,
      ).toBe(61);
    });

    it('references are unique per tenant even for many calls', async () => {
      const calls = await Promise.all(
        Array.from({ length: 300 }, () => engine.simulateCall('tenant-a')),
      );
      const references = new Set(calls.map((call) => call.reference));
      expect(references.size).toBe(300);
    });
  });

  describe('two tenants', () => {
    it('another tenant cannot see or change a request, and a reference is looked up per tenant', async () => {
      const a = await engine.simulateCall('tenant-a');
      expect(engine.inspectRecord('tenant-b', a.reference)).toBeNull();
      expect(engine.recordsOf('tenant-b')).toEqual([]);
      expect(
        engine.simulateRequestUpdate('tenant-b', a.reference, {
          summary: 'x',
        }),
      ).toBe(false);
      expect(engine.inspectRecord('tenant-a', a.reference)?.revision).toBe(0);
    });

    it('events carry the tenant they belong to', async () => {
      await engine.simulateCall('tenant-a');
      await engine.simulateCall('tenant-b');
      await engine.flushEvents();
      expect(engine.eventsOf('tenant-a', 'record.submitted')).toHaveLength(1);
      expect(engine.eventsOf('tenant-b', 'record.submitted')).toHaveLength(1);
      expect(delivered.filter((e) => e.tenantId === 'tenant-b')).toHaveLength(
        3,
      );
    });
  });

  describe('simulateRequestUpdate', () => {
    it('changes the details, counts the revision and emits record.updated with ids and the reference only', async () => {
      const call = await engine.simulateCall('tenant-a');
      expect(
        engine.simulateRequestUpdate('tenant-a', call.reference, {
          summary: 'Moved to Friday',
          scheduledLocal: '2026-11-06 10:00',
        }),
      ).toBe(true);
      await engine.flushEvents();
      expect(engine.inspectRecord('tenant-a', call.reference)).toMatchObject({
        summary: 'Moved to Friday',
        scheduledLocal: '2026-11-06 10:00',
        revision: 1,
      });
      const updated = delivered.filter((e) => e.type === 'record.updated');
      expect(updated).toHaveLength(1);
      expect(updated[0].data).toEqual({
        recordId: call.recordId,
        reference: call.reference,
        type: 'appointment',
        conversationId: call.conversationId,
        agentId: null,
        revision: 1,
      });
      // no caller words in the event
      expect(JSON.stringify(updated[0].data)).not.toContain('Friday');
    });

    it('is refused once a person has confirmed the request ("locked"): nothing changes, nothing is emitted', async () => {
      const call = await engine.simulateCall('tenant-a');
      engine.lockRecord('tenant-a', call.reference, 'confirmed');
      await engine.flushEvents();
      const before = delivered.length;
      expect(
        engine.simulateRequestUpdate('tenant-a', call.reference, {
          summary: 'too late',
        }),
      ).toBe(false);
      await engine.flushEvents();
      expect(delivered).toHaveLength(before);
      expect(engine.inspectRecord('tenant-a', call.reference)).toMatchObject({
        status: 'confirmed',
        revision: 0,
      });
    });

    it('an unknown reference is simply false', () => {
      expect(engine.simulateRequestUpdate('tenant-a', 'AP-NOPE0')).toBe(false);
    });
  });

  describe('test commands in a mock chat', () => {
    let id: string;
    beforeEach(async () => {
      ({ id } = await engine.createConversation(ctx, {
        channel: 'widget',
        endCustomerId: 'ec-1',
      }));
    });

    it(`${MOCK_COMMANDS.CALL} simulates a call and the reply names the saved reference`, async () => {
      const events = await collect(
        engine.sendMessage(ctx, id, { content: '/call' }),
      );
      const [record] = engine.recordsOf('tenant-a');
      const text = events
        .filter((e) => e.type === 'token')
        .map((e) => (e as { text: string }).text)
        .join('');
      expect(record.reference).toMatch(REFERENCE);
      expect(text).toContain(record.reference);
      expect(events[events.length - 1]).toMatchObject({
        type: 'done',
        aiReply: true,
      });
      await engine.flushEvents();
      expect(delivered.map((e) => e.type)).toEqual(
        expect.arrayContaining(['record.submitted', 'usage.call_minutes']),
      );
    });

    it(`${MOCK_COMMANDS.CALL_UPDATE} changes the latest request and says so`, async () => {
      await collect(engine.sendMessage(ctx, id, { content: '/call' }));
      const events = await collect(
        engine.sendMessage(ctx, id, { content: '/call-update' }),
      );
      const text = events
        .filter((e) => e.type === 'token')
        .map((e) => (e as { text: string }).text)
        .join('');
      const [record] = engine.recordsOf('tenant-a');
      expect(text).toContain(record.reference);
      expect(record.revision).toBe(1);
      await engine.flushEvents();
      expect(engine.eventsOf('tenant-a', 'record.updated')).toHaveLength(1);
    });

    it(`${MOCK_COMMANDS.CALL_UPDATE} without a request, or after it was confirmed, explains and changes nothing`, async () => {
      const first = await collect(
        engine.sendMessage(ctx, id, { content: '/call-update' }),
      );
      expect(
        first
          .filter((e) => e.type === 'token')
          .map((e) => (e as { text: string }).text)
          .join(''),
      ).toContain('/call');
      expect(engine.eventsOf('tenant-a', 'record.updated')).toHaveLength(0);

      await collect(engine.sendMessage(ctx, id, { content: '/call' }));
      const [record] = engine.recordsOf('tenant-a');
      engine.lockRecord('tenant-a', record.reference, 'confirmed');
      await collect(engine.sendMessage(ctx, id, { content: '/call-update' }));
      expect(engine.eventsOf('tenant-a', 'record.updated')).toHaveLength(0);
    });

    it('a replayed message (same Idempotency-Key) does not simulate a second call', async () => {
      const keyed = { ...ctx, idempotencyKey: 'key-call-00001' };
      await collect(engine.sendMessage(keyed, id, { content: '/call' }));
      await collect(engine.sendMessage(keyed, id, { content: '/call' }));
      expect(engine.recordsOf('tenant-a')).toHaveLength(1);
    });

    it('the chat commands only act for the tenant of the call', async () => {
      await collect(engine.sendMessage(ctx, id, { content: '/call' }));
      expect(engine.recordsOf('tenant-b')).toEqual([]);
    });
  });

  it('reset forgets the requests', async () => {
    await engine.simulateCall('tenant-a');
    engine.reset();
    expect(engine.recordsOf('tenant-a')).toEqual([]);
  });

  /** L7: the call pulls the settings of the agent that takes it, at its start. */
  describe('agents (L7)', () => {
    const pulled = {
      agentId: 'agent-default',
      version: 4,
      status: 'active' as const,
      config: { businessName: 'Acme Dental', tone: 'friendly' },
    };
    let source: jest.MockedFunction<AgentConfigSource>;

    beforeEach(() => {
      source = jest.fn<
        ReturnType<AgentConfigSource>,
        Parameters<AgentConfigSource>
      >(async () => pulled);
      engine.setAgentConfigSource(source);
    });

    it('pulls the settings at the start of the call, asking for the default agent when none is named', async () => {
      const call = await engine.simulateCall('tenant-a');
      expect(source).toHaveBeenCalledTimes(1);
      expect(source).toHaveBeenCalledWith('tenant-a', undefined);
      expect(call).toMatchObject({
        agentId: 'agent-default',
        settingsVersion: 4,
        config: { businessName: 'Acme Dental', tone: 'friendly' },
      });
      expect(engine.recordsOf('tenant-a')[0].agentId).toBe('agent-default');
    });

    it('asks for the named agent and carries its id in every call event', async () => {
      source.mockResolvedValueOnce({ ...pulled, agentId: 'agent-night' });
      const call = await engine.simulateCall('tenant-a', {
        agentId: 'agent-night',
      });
      expect(source).toHaveBeenCalledWith('tenant-a', 'agent-night');
      await engine.flushEvents();
      expect(call.agentId).toBe('agent-night');
      expect(delivered.map((e) => e.data.agentId)).toEqual([
        'agent-night',
        'agent-night',
        'agent-night',
      ]);
    });

    it('hands out a copy of the config, so a caller cannot change what the next call pulls', async () => {
      const call = await engine.simulateCall('tenant-a');
      (call.config as Record<string, unknown>).businessName = 'Changed';
      expect(pulled.config.businessName).toBe('Acme Dental');
    });

    it('a disabled agent takes no call: nothing is stored and no event is emitted', async () => {
      source.mockResolvedValueOnce({ ...pulled, status: 'disabled' });
      await expect(engine.simulateCall('tenant-a')).rejects.toBeInstanceOf(
        MockAgentUnavailableError,
      );
      await engine.flushEvents();
      expect(delivered).toEqual([]);
      expect(engine.recordsOf('tenant-a')).toEqual([]);
    });

    it('an agent that cannot be pulled (another tenant, unknown) fails the call before anything is stored', async () => {
      source.mockRejectedValueOnce(new Error('AGENT_NOT_FOUND'));
      await expect(
        engine.simulateCall('tenant-a', { agentId: 'other-tenants-agent' }),
      ).rejects.toThrow('AGENT_NOT_FOUND');
      expect(engine.recordsOf('tenant-a')).toEqual([]);
    });

    it('a tenant without an agent still gets a call, with agentId null', async () => {
      source.mockResolvedValueOnce(null);
      await expect(engine.simulateCall('tenant-a')).resolves.toMatchObject({
        agentId: null,
        settingsVersion: null,
        config: null,
      });
    });

    it('/call in a chat uses the default agent, and says so when the agent is disabled', async () => {
      const { id } = await engine.createConversation(ctx, {
        channel: 'widget',
        endCustomerId: 'ec-1',
      });
      await collect(engine.sendMessage(ctx, id, { content: '/call' }));
      expect(engine.recordsOf('tenant-a')[0].agentId).toBe('agent-default');
      source.mockResolvedValueOnce({ ...pulled, status: 'disabled' });
      const events = await collect(
        engine.sendMessage(ctx, id, { content: '/call' }),
      );
      const reply = events
        .filter((e) => e.type === 'token')
        .map((e) => (e as { text: string }).text)
        .join('');
      expect(reply).toContain('not available');
      expect(engine.recordsOf('tenant-a')).toHaveLength(1);
    });
  });
});

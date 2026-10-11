import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { RealtimeHub, widgetChannel } from '../realtime/realtime.hub';
import { StreamRegistry } from '../realtime/stream-registry';
import { WidgetAuth } from './widget-auth';
import { WidgetStreamService } from './widget-stream.service';

class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  writableEnded = false;
  headers: Record<string, string> = {};
  status() {
    return this;
  }
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  flushHeaders() {}
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit('close');
  }
  get text() {
    return this.chunks.join('');
  }
}

const auth: WidgetAuth = {
  tenantId: 'tenant-a',
  endCustomerId: 'ec-1',
  conversationId: 'conv-1',
  keyId: 'key-1',
  locale: 'en',
  origin: 'https://shop.example.com',
  expiresAtMs: Date.now() + 15 * 60_000,
};

function open(
  headers: Record<string, string> = {},
  query: Record<string, string> = {},
) {
  const request = Object.assign(new EventEmitter(), {
    socket: { setTimeout: jest.fn(), setNoDelay: jest.fn() },
    headers,
    query,
  });
  const response = new FakeResponse();
  return { request, response };
}

describe('WidgetStreamService', () => {
  let hub: RealtimeHub;
  let registry: StreamRegistry;
  let rateLimits: { config: Record<string, number>; enforce: jest.Mock };
  let messages: { assertOwnConversation: jest.Mock };
  let sessions: { chatGate: jest.Mock };
  let apiKeys: { findActiveWidgetKey: jest.Mock };
  let service: WidgetStreamService;

  beforeEach(() => {
    hub = new RealtimeHub();
    registry = new StreamRegistry();
    rateLimits = {
      config: { readPerIp: 120, readPerVisitor: 60 },
      enforce: jest.fn(),
    };
    messages = {
      assertOwnConversation: jest.fn().mockResolvedValue(undefined),
    };
    sessions = {
      chatGate: jest.fn().mockResolvedValue({ open: true, poweredBy: true }),
    };
    apiKeys = {
      findActiveWidgetKey: jest.fn().mockResolvedValue({ id: 'key-1' }),
    };
    service = new WidgetStreamService(
      hub,
      registry,
      rateLimits as never,
      messages as never,
      sessions as never,
      apiKeys as never,
    );
  });

  const run = (req = open()) =>
    service.open(
      auth,
      req.request as unknown as Request,
      req.response as unknown as Response,
      '1.2.3.4',
    );

  it('checks the limits and that the conversation is this visitor’s BEFORE sending a byte', async () => {
    messages.assertOwnConversation.mockRejectedValue(new Error('404'));
    const req = open();
    await expect(run(req)).rejects.toThrow('404');
    expect(req.response.chunks).toEqual([]);
    expect(rateLimits.enforce).toHaveBeenCalledWith([
      { scope: 'read-ip', id: '1.2.3.4', limit: 120 },
      { scope: 'read-visitor', id: 'tenant-a:ec-1', limit: 60 },
    ]);
    expect(messages.assertOwnConversation).toHaveBeenCalledWith(auth);
  });

  it('refuses a tenant that may not chat (403 TENANT_SUSPENDED) with an ordinary error', async () => {
    sessions.chatGate.mockResolvedValue({ open: false, poweredBy: true });
    const req = open();
    await expect(run(req)).rejects.toMatchObject({
      status: 403,
      response: { code: 'TENANT_SUSPENDED' },
    });
    expect(req.response.chunks).toEqual([]);
  });

  it('opens the stream with ready, then forwards what is published to THIS conversation only', async () => {
    const req = open();
    await run(req);
    expect(req.response.headers['content-type']).toContain('text/event-stream');
    expect(req.response.text).toContain('event: ready');
    hub.publish(widgetChannel('tenant-a', 'conv-1'), 'message', {
      id: 'm1',
      content: 'Hi',
    });
    hub.publish(widgetChannel('tenant-a', 'conv-2'), 'message', {
      id: 'other-conversation',
    });
    hub.publish(widgetChannel('tenant-b', 'conv-1'), 'message', {
      id: 'other-tenant',
    });
    expect(req.response.text).toContain('"id":"m1"');
    expect(req.response.text).not.toContain('other-conversation');
    expect(req.response.text).not.toContain('other-tenant');
  });

  it('replays what the visitor missed after Last-Event-ID, header or query', async () => {
    const first = hub.publish(widgetChannel('tenant-a', 'conv-1'), 'message', {
      id: 'old',
    })!;
    hub.publish(widgetChannel('tenant-a', 'conv-1'), 'message', {
      id: 'missed',
    });
    const viaHeader = open({ 'last-event-id': first.id });
    await run(viaHeader);
    expect(viaHeader.response.text).toContain('"id":"missed"');
    expect(viaHeader.response.text).not.toContain('"id":"old"');
    const viaQuery = open({}, { lastEventId: first.id });
    await run(viaQuery);
    expect(viaQuery.response.text).toContain('"id":"missed"');
  });

  it('tells a visitor whose Last-Event-ID is stale to re-read the history (resync)', async () => {
    const req = open({ 'last-event-id': 'ffffffff-3' });
    await run(req);
    expect(req.response.text).toContain('event: resync');
  });

  it('stops listening when the visitor leaves', async () => {
    const req = open();
    await run(req);
    expect(hub.listenerCount(widgetChannel('tenant-a', 'conv-1'))).toBe(1);
    req.request.emit('close');
    expect(hub.listenerCount(widgetChannel('tenant-a', 'conv-1'))).toBe(0);
    expect(registry.count('widget:tenant-a:conv-1')).toBe(0);
  });

  it('a fourth stream of one conversation closes the oldest', async () => {
    const streams = [open(), open(), open(), open()];
    for (const s of streams) await run(s);
    expect(streams[0].response.text).toContain('"reason":"limit"');
    expect(streams[3].response.text).not.toContain('"reason":"limit"');
    expect(registry.count('widget:tenant-a:conv-1')).toBe(3);
  });

  describe('while open', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('ends at the expiry of the widget token', async () => {
      const req = open();
      const soon = { ...auth, expiresAtMs: Date.now() + 5000 };
      await service.open(
        soon,
        req.request as never,
        req.response as never,
        'ip',
      );
      await jest.advanceTimersByTimeAsync(5001);
      expect(req.response.text).toContain('"reason":"expired"');
    });

    it('ends when the widget key is revoked', async () => {
      const req = open();
      await run(req);
      apiKeys.findActiveWidgetKey.mockResolvedValue(null);
      await jest.advanceTimersByTimeAsync(60_001);
      expect(req.response.text).toContain('"reason":"revoked"');
    });

    it('ends when the tenant stops being allowed to chat', async () => {
      const req = open();
      await run(req);
      sessions.chatGate.mockResolvedValue({ open: false, poweredBy: true });
      await jest.advanceTimersByTimeAsync(60_001);
      expect(req.response.text).toContain('"reason":"revoked"');
    });
  });
});

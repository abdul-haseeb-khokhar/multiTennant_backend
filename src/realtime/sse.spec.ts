import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { lastEventIdOf, openSse } from './sse';

class FakeResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  writableEnded = false;
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  flushHeaders() {
    // headers go out here
  }
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

function open(options: Parameters<typeof openSse>[2] = {}) {
  const request = Object.assign(new EventEmitter(), {
    socket: { setTimeout: jest.fn(), setNoDelay: jest.fn() },
    headers: {},
    query: {},
  });
  const response = new FakeResponse();
  const connection = openSse(
    request as unknown as Request,
    response as unknown as Response,
    options,
  );
  return { request, response, connection };
}

describe('openSse', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sends the event-stream headers at once, without proxy buffering, and a retry hint', () => {
    const { response, request } = open({ retryMs: 1500 });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toContain('no-cache');
    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(response.text).toContain('retry: 1500\n\n');
    expect(request.socket.setTimeout).toHaveBeenCalledWith(0);
  });

  it('frames events with an optional id', () => {
    const { response, connection } = open();
    connection.send('message', { a: 1 }, 'run-5');
    connection.send('ready', {});
    expect(response.text).toContain(
      'id: run-5\nevent: message\ndata: {"a":1}\n\n',
    );
    expect(response.text).toContain('event: ready\ndata: {}\n\n');
  });

  it('writes a heartbeat comment on the interval', () => {
    const { response } = open({ heartbeatMs: 1000 });
    jest.advanceTimersByTime(3500);
    expect(response.chunks.filter((c) => c === ': ping\n\n')).toHaveLength(3);
  });

  it('closes with a reason at the expiry instant and stops the timers', () => {
    const closed = jest.fn();
    const { response, connection } = open({
      expiresAt: Date.now() + 5000,
      heartbeatMs: 1000,
    });
    connection.onClose(closed);
    jest.advanceTimersByTime(5000);
    expect(response.text).toContain(
      'event: closed\ndata: {"reason":"expired"}',
    );
    expect(response.writableEnded).toBe(true);
    expect(connection.closed).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    const written = response.chunks.length;
    jest.advanceTimersByTime(10_000);
    expect(response.chunks.length).toBe(written);
  });

  it('closes as revoked when the allowed check says no', async () => {
    const check = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { response, connection } = open({
      stillAllowed: check,
      checkEveryMs: 1000,
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(connection.closed).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    expect(response.text).toContain('"reason":"revoked"');
    expect(connection.closed).toBe(true);
  });

  it('a failing allowed check does not end the stream', async () => {
    const { connection } = open({
      stillAllowed: () => Promise.reject(new Error('db down')),
      checkEveryMs: 1000,
    });
    await jest.advanceTimersByTimeAsync(3000);
    expect(connection.closed).toBe(false);
  });

  it('cleans up when the client goes away', () => {
    const closed = jest.fn();
    const { request, connection, response } = open();
    connection.onClose(closed);
    request.emit('close');
    request.emit('close');
    expect(closed).toHaveBeenCalledTimes(1);
    connection.send('late', {});
    expect(response.text).not.toContain('event: late');
  });

  it('runs a callback registered after the stream ended straight away', () => {
    const { connection } = open();
    connection.close('limit');
    const late = jest.fn();
    connection.onClose(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe('lastEventIdOf', () => {
  const request = (headers: object, query: object) =>
    ({ headers, query }) as unknown as Request;

  it('reads the header, or the lastEventId query for clients that cannot set it', () => {
    expect(lastEventIdOf(request({ 'last-event-id': 'abc-3' }, {}))).toBe(
      'abc-3',
    );
    expect(lastEventIdOf(request({}, { lastEventId: 'abc-4' }))).toBe('abc-4');
    expect(
      lastEventIdOf(
        request({ 'last-event-id': 'h-1' }, { lastEventId: 'q-2' }),
      ),
    ).toBe('h-1');
  });

  it('ignores nothing-values and absurdly long ones', () => {
    expect(lastEventIdOf(request({}, {}))).toBeUndefined();
    expect(lastEventIdOf(request({ 'last-event-id': '' }, {}))).toBeUndefined();
    expect(
      lastEventIdOf(request({ 'last-event-id': 'x'.repeat(101) }, {})),
    ).toBeUndefined();
    expect(
      lastEventIdOf(request({}, { lastEventId: ['a', 'b'] })),
    ).toBeUndefined();
  });
});

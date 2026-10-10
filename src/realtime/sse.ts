import type { Request, Response } from 'express';

export interface SseOptions {
  /** Comment line every so often so proxies and browsers keep the connection open. */
  heartbeatMs?: number;
  /** The stream ends at this instant (token expiry, maximum age). */
  expiresAt?: number;
  /** Called every `checkEveryMs`; returning false ends the stream (user disabled, key revoked). */
  stillAllowed?: () => Promise<boolean>;
  checkEveryMs?: number;
  /** Reconnect delay suggested to the browser. */
  retryMs?: number;
}

export interface SseConnection {
  /** Writes one event. `id` (when given) is what the client sends back as Last-Event-ID. */
  send(event: string, data: unknown, id?: string): void;
  /** Ends the stream, telling the client why (`event: closed`). */
  close(reason: string): void;
  /** True once the client left or the stream was closed. */
  readonly closed: boolean;
  /** Runs `fn` once, when the stream ends for any reason. */
  onClose(fn: () => void): void;
}

export const DEFAULT_HEARTBEAT_MS = 25_000;
export const DEFAULT_CHECK_MS = 60_000;

/**
 * Turns the response into a server-sent event stream. Sends the headers at once, a `retry:` hint,
 * heartbeats, and ends the stream at `expiresAt` or when `stillAllowed` says so. Nothing here knows
 * about tenants or users: the caller authenticated before calling it.
 */
export function openSse(
  request: Request,
  response: Response,
  options: SseOptions = {},
): SseConnection {
  response.status(200);
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  // Tell nginx and similar proxies not to buffer the stream.
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();
  // A long-lived stream must not be cut by an idle socket timeout.
  request.socket.setTimeout(0);
  request.socket.setNoDelay(true);

  let closed = false;
  const closers: (() => void)[] = [];
  const timers: NodeJS.Timeout[] = [];

  const finish = () => {
    if (closed) return;
    closed = true;
    for (const timer of timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    for (const fn of closers) {
      try {
        fn();
      } catch {
        // cleanup must not throw into the socket handler
      }
    }
  };
  const write = (chunk: string) => {
    if (closed || response.writableEnded) return;
    response.write(chunk);
  };

  const connection: SseConnection = {
    send(event, data, id) {
      write(
        `${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    },
    close(reason) {
      if (closed) return;
      write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
      finish();
      response.end();
    },
    get closed() {
      return closed;
    },
    onClose(fn) {
      if (closed) fn();
      else closers.push(fn);
    },
  };

  write(`retry: ${options.retryMs ?? 3000}\n\n`);
  request.on('close', finish);
  response.on('close', finish);

  const heartbeat = setInterval(
    () => write(': ping\n\n'),
    options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
  );
  timers.push(heartbeat);

  if (options.expiresAt !== undefined) {
    const timer = setTimeout(
      () => connection.close('expired'),
      Math.max(options.expiresAt - Date.now(), 0),
    );
    timers.push(timer);
  }
  if (options.stillAllowed) {
    const check = options.stillAllowed;
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      check()
        .then((allowed) => {
          if (!allowed) connection.close('revoked');
        })
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    }, options.checkEveryMs ?? DEFAULT_CHECK_MS);
    timers.push(timer);
  }
  for (const timer of timers) timer.unref?.();
  return connection;
}

/** `Last-Event-ID` from the header, or the `lastEventId` query parameter for clients that cannot set it. */
export function lastEventIdOf(request: Request): string | undefined {
  const header = request.headers['last-event-id'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const query = request.query.lastEventId;
  const value = fromHeader || (typeof query === 'string' ? query : undefined);
  return value && value.length <= 100 ? value : undefined;
}

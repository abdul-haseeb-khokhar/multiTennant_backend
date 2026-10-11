import http from 'node:http';

export interface SseMessage {
  event: string;
  id?: string;
  data: any;
}

export interface SseStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Everything received so far that was a data event (control comments are in `raw`). */
  events: SseMessage[];
  raw: string;
  /** Resolves with the first event matching, after any already received; rejects after `timeoutMs`. */
  waitFor(
    predicate: (event: SseMessage) => boolean,
    timeoutMs?: number,
  ): Promise<SseMessage>;
  /** The JSON body when the answer was an ordinary error (status other than 200). */
  body?: any;
  closed: Promise<void>;
  close(): void;
}

function parse(block: string): SseMessage | null {
  let event = 'message';
  let id: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':') || line.startsWith('retry:')) continue;
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (data.length === 0 && event === 'message') return null;
  return { event, id, data: data.length ? JSON.parse(data.join('\n')) : {} };
}

/** Opens a GET and reads it as a server-sent event stream (or an ordinary JSON error). */
export function openStream(
  url: string,
  headers: Record<string, string> = {},
): Promise<SseStream> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      const waiters: {
        predicate: (e: SseMessage) => boolean;
        resolve: (e: SseMessage) => void;
      }[] = [];
      let buffer = '';
      let markClosed: () => void = () => undefined;
      const closed = new Promise<void>((r) => (markClosed = r));
      const stream: SseStream = {
        status: response.statusCode ?? 0,
        headers: response.headers,
        events: [],
        raw: '',
        closed,
        waitFor(predicate, timeoutMs = 3000) {
          const existing = stream.events.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((res, rej) => {
            const timer = setTimeout(
              () =>
                rej(
                  new Error(
                    `No matching event within ${timeoutMs} ms; received: ${stream.events
                      .map((e) => e.event)
                      .join(', ')}`,
                  ),
                ),
              timeoutMs,
            );
            waiters.push({
              predicate,
              resolve: (event) => {
                clearTimeout(timer);
                res(event);
              },
            });
          });
        },
        close() {
          request.destroy();
          response.destroy();
        },
      };
      response.setEncoding('utf8');
      const isEventStream = String(response.headers['content-type']).includes(
        'text/event-stream',
      );
      response.on('data', (chunk: string) => {
        stream.raw += chunk;
        if (!isEventStream) return;
        buffer += chunk;
        for (let end; (end = buffer.indexOf('\n\n')) !== -1;) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const message = parse(block);
          if (!message) continue;
          stream.events.push(message);
          for (const waiter of waiters.slice()) {
            if (waiter.predicate(message)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve(message);
            }
          }
        }
      });
      response.on('end', () => {
        if (!isEventStream) {
          try {
            stream.body = JSON.parse(stream.raw);
          } catch {
            stream.body = stream.raw;
          }
        }
        markClosed();
      });
      response.on('close', markClosed);
      response.on('error', () => markClosed());
      // Resolve as soon as the headers are there: a stream never "ends" by itself.
      if (isEventStream) resolve(stream);
      else response.on('end', () => resolve(stream));
    });
    request.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') return;
      reject(error);
    });
  });
}

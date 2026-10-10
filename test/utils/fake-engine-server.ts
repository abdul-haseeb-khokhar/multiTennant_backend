import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { MockEngineClient } from '../../src/engine/mock-engine.client';
import { EngineError } from '../../src/engine/engine.types';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface Faults {
  /** Destroy the socket for this many requests (a network error for the client). */
  resetConnections: number;
  /** Answer this many requests with `status` instead of doing the work. */
  failWith: { status: number; times: number } | null;
  /** After `accepted`, never send anything else (a model that hangs). */
  hangAfterAccepted: boolean;
  /** After `accepted` and the tokens, close the stream without `done`. */
  truncateStream: boolean;
  /** Answer message streams with plain JSON instead of server-sent events. */
  notSse: boolean;
}

const noFaults = (): Faults => ({
  resetConnections: 0,
  failWith: null,
  hangAfterAccepted: false,
  truncateStream: false,
  notSse: false,
});

/**
 * A small HTTP server that speaks the engine contract (`docs/contracts/engine-internal.openapi.yaml`)
 * on top of the in-process mock, so `HttpEngineClient` can be tested against real sockets: auth,
 * tenant header, idempotency key, SSE framing, and faults (reset, 5xx, hang, truncated stream).
 */
export class FakeEngineServer {
  readonly engine = new MockEngineClient({
    tokenDelayMs: 0,
    firstTokenTimeoutMs: 60_000,
    totalTimeoutMs: 60_000,
  });
  readonly requests: RecordedRequest[] = [];
  faults: Faults = noFaults();
  private server!: Server;
  private readonly sockets = new Set<import('node:net').Socket>();

  constructor(readonly token: string) {}

  get url() {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async start() {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
  }

  async stop() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  reset() {
    this.engine.reset();
    this.engine.configure({ tokenDelayMs: 0 });
    this.requests.length = 0;
    this.faults = noFaults();
  }

  // -------------------------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const body = await readBody(req);
    this.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      headers: req.headers,
      body,
    });

    if (this.faults.resetConnections > 0) {
      this.faults.resetConnections -= 1;
      req.socket.destroy();
      return;
    }
    if (path === '/health') {
      return json(res, 200, { status: 'ok' });
    }
    if (this.faults.failWith && this.faults.failWith.times > 0) {
      this.faults.failWith.times -= 1;
      return json(res, this.faults.failWith.status, {
        statusCode: this.faults.failWith.status,
        code: 'INTERNAL_ERROR',
        message: 'boom',
      });
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      return json(res, 401, {
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'bad service token',
      });
    }
    const tenantId = req.headers['x-tenant-id'];
    if (typeof tenantId !== 'string' || !tenantId) {
      return json(res, 400, {
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: 'X-Tenant-Id is required',
      });
    }
    const ctx = {
      tenantId,
      requestId: header(req, 'x-request-id'),
      idempotencyKey: header(req, 'idempotency-key'),
    };
    const input = (body ?? {}) as Record<string, any>;

    try {
      const route =
        /^\/internal\/conversations(?:\/([^/]+)(?:\/(messages|escalate))?)?$/.exec(
          path,
        );
      if (!route) return json(res, 404, errorBody(404, 'NOT_FOUND'));
      const [, id, action] = route;

      if (!id && req.method === 'POST') {
        return json(
          res,
          201,
          await this.engine.createConversation(ctx, input as any),
        );
      }
      if (id && !action && req.method === 'GET') {
        return json(
          res,
          200,
          await this.engine.getConversation(ctx, id, {
            skip: url.searchParams.has('skip')
              ? Number(url.searchParams.get('skip'))
              : undefined,
            take: url.searchParams.has('take')
              ? Number(url.searchParams.get('take'))
              : undefined,
          }),
        );
      }
      if (id && action === 'escalate' && req.method === 'POST') {
        return json(
          res,
          200,
          await this.engine.escalate(ctx, id, input as any),
        );
      }
      if (id && action === 'messages' && req.method === 'POST') {
        return await this.stream(res, ctx, id, input);
      }
      return json(res, 404, errorBody(404, 'NOT_FOUND'));
    } catch (error) {
      if (error instanceof EngineError) {
        const status =
          error.kind === 'not_found'
            ? 404
            : error.kind === 'conflict'
              ? 409
              : 503;
        return json(
          res,
          status,
          errorBody(
            status,
            error.engineCode ??
              (status === 404
                ? 'CONVERSATION_NOT_FOUND'
                : status === 409
                  ? 'CONVERSATION_RESOLVED'
                  : 'SERVICE_UNAVAILABLE'),
          ),
        );
      }
      throw error;
    }
  }

  private async stream(
    res: ServerResponse,
    ctx: { tenantId: string; requestId?: string; idempotencyKey?: string },
    id: string,
    input: Record<string, any>,
  ) {
    if (this.faults.notSse) {
      return json(res, 200, { ok: true });
    }
    const events = this.engine.sendMessage(ctx, id, input as any);
    const iterator = events[Symbol.asyncIterator]();
    // Pull the first event before sending headers so a refusal becomes a normal HTTP error.
    const first = await iterator.next();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    const write = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const send = (value: Record<string, unknown> & { type: string }) => {
      const { type, ...data } = value;
      write(type, data);
    };

    let step = first;
    try {
      while (!step.done) {
        send(step.value as any);
        if (this.faults.hangAfterAccepted && step.value.type === 'accepted') {
          return; // keep the response open and silent
        }
        if (this.faults.truncateStream && step.value.type === 'token') {
          res.end();
          return;
        }
        step = await iterator.next();
      }
    } catch (error) {
      if (error instanceof EngineError) {
        write('error', {
          code: error.engineCode ?? 'ENGINE_ERROR',
          message: error.message,
        });
      } else {
        throw error;
      }
    }
    res.end();
  }
}

function header(req: IncomingMessage, name: string) {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function errorBody(statusCode: number, code: string) {
  return { statusCode, code, message: code };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

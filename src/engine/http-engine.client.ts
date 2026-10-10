import { EngineClient } from './engine-client';
import {
  CONVERSATION_STATUSES,
  ClaimInput,
  ConversationCounts,
  CreateConversationInput,
  EngineCallContext,
  EngineConversation,
  EngineConversationPage,
  EngineError,
  EngineMessage,
  EngineMessagePage,
  EngineStreamEvent,
  EscalateInput,
  HumanMessageInput,
  ListConversationsQuery,
  ReleaseInput,
  ResolveInput,
  SendMessageInput,
} from './engine.types';
import { readSse, toWireEvent } from './sse-parser';
import { withDeadlines } from './stream-deadlines';

export interface HttpEngineOptions {
  baseUrl: string;
  /** INTERNAL_API_TOKEN (D2). Never logged, never part of an error message. */
  token: string;
  /** Plain request/response calls (default 10 s). */
  requestTimeoutMs: number;
  /** Until the first answer event of a message stream (D7: 5 s). */
  firstTokenTimeoutMs: number;
  /** Whole message stream (D7: 30 s). */
  totalTimeoutMs: number;
  /** For tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Calls the real engine's internal API (`docs/contracts/engine-internal.openapi.yaml`) with the
 * service token (D2). Every call sends `X-Tenant-Id`, `X-Request-Id` and, for commands, the
 * `Idempotency-Key` (D7). Timeouts: `requestTimeoutMs` for plain calls, 5 s to the first answer
 * event and 30 s in total for a message stream. Retry policy: ONE retry, only when the connection
 * itself failed (nothing reached the engine, or the socket broke before a response); a timeout or
 * an HTTP error is never retried. Commands are idempotent by key, so a retry cannot duplicate.
 */
export class HttpEngineClient extends EngineClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: HttpEngineOptions) {
    super();
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  async health(): Promise<{ ok: boolean }> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return { ok: response.ok };
    } catch {
      return { ok: false };
    }
  }

  async createConversation(
    ctx: EngineCallContext,
    input: CreateConversationInput,
  ): Promise<EngineConversation> {
    const body = await this.json(ctx, 'POST', '/internal/conversations', input);
    return asConversation(body);
  }

  async getConversation(
    ctx: EngineCallContext,
    conversationId: string,
    page: { skip?: number; take?: number } = {},
  ) {
    const query = new URLSearchParams();
    if (page.skip !== undefined) query.set('skip', String(page.skip));
    if (page.take !== undefined) query.set('take', String(page.take));
    const qs = query.size ? `?${query.toString()}` : '';
    const body = await this.json(
      ctx,
      'GET',
      `/internal/conversations/${encodeURIComponent(conversationId)}${qs}`,
    );
    const record = asRecord(body);
    return {
      conversation: asConversation(record.conversation),
      messages: asMessagePage(record.messages),
    };
  }

  async escalate(
    ctx: EngineCallContext,
    conversationId: string,
    input: EscalateInput,
  ): Promise<EngineConversation> {
    const body = await this.json(
      ctx,
      'POST',
      `/internal/conversations/${encodeURIComponent(conversationId)}/escalate`,
      input,
    );
    return asConversation(body);
  }

  async listConversations(
    ctx: EngineCallContext,
    query: ListConversationsQuery,
  ): Promise<EngineConversationPage> {
    const params = new URLSearchParams();
    if (query.status?.length) params.set('status', query.status.join(','));
    if (query.assignedUserId) {
      params.set('assignedUserId', query.assignedUserId);
    }
    if (query.endCustomerId) params.set('endCustomerId', query.endCustomerId);
    if (query.sort) params.set('sort', query.sort);
    if (query.skip !== undefined) params.set('skip', String(query.skip));
    if (query.take !== undefined) params.set('take', String(query.take));
    const qs = params.size ? `?${params.toString()}` : '';
    const record = asRecord(
      await this.json(ctx, 'GET', `/internal/conversations${qs}`),
    );
    if (!Array.isArray(record.data)) {
      throw new EngineError('protocol', 'The engine response lacks "data"');
    }
    const num = (key: string) =>
      typeof record[key] === 'number' ? (record[key] as number) : 0;
    return {
      data: record.data.map(asConversation),
      total: num('total'),
      skip: num('skip'),
      take: num('take'),
    };
  }

  async countConversations(
    ctx: EngineCallContext,
    filter: { assignedUserId?: string } = {},
  ): Promise<ConversationCounts> {
    const qs = filter.assignedUserId
      ? `?assignedUserId=${encodeURIComponent(filter.assignedUserId)}`
      : '';
    const record = asRecord(
      await this.json(ctx, 'GET', `/internal/conversation-counts${qs}`),
    );
    const counts = {} as ConversationCounts;
    for (const status of CONVERSATION_STATUSES) {
      const value = record[status];
      counts[status] = typeof value === 'number' ? value : 0;
    }
    return counts;
  }

  async claimConversation(
    ctx: EngineCallContext,
    conversationId: string,
    input: ClaimInput,
  ): Promise<EngineConversation> {
    return asConversation(
      await this.json(
        ctx,
        'POST',
        this.conversationPath(conversationId, 'claim'),
        input,
      ),
    );
  }

  async releaseConversation(
    ctx: EngineCallContext,
    conversationId: string,
    input: ReleaseInput,
  ): Promise<EngineConversation> {
    return asConversation(
      await this.json(
        ctx,
        'POST',
        this.conversationPath(conversationId, 'release'),
        input,
      ),
    );
  }

  async resolveConversation(
    ctx: EngineCallContext,
    conversationId: string,
    input: ResolveInput,
  ): Promise<EngineConversation> {
    return asConversation(
      await this.json(
        ctx,
        'POST',
        this.conversationPath(conversationId, 'resolve'),
        input,
      ),
    );
  }

  async sendHumanMessage(
    ctx: EngineCallContext,
    conversationId: string,
    input: HumanMessageInput,
  ): Promise<EngineMessage> {
    return asMessage(
      await this.json(
        ctx,
        'POST',
        this.conversationPath(conversationId, 'human-messages'),
        input,
      ),
    );
  }

  async *sendMessage(
    ctx: EngineCallContext,
    conversationId: string,
    input: SendMessageInput,
  ): AsyncGenerator<EngineStreamEvent> {
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    ctx.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (ctx.signal?.aborted) controller.abort();
    try {
      yield* withDeadlines(
        this.stream(ctx, conversationId, input, controller.signal),
        {
          firstTokenMs: this.options.firstTokenTimeoutMs,
          totalMs: this.options.totalTimeoutMs,
        },
        () => controller.abort(),
      );
    } finally {
      ctx.signal?.removeEventListener('abort', onCallerAbort);
      controller.abort();
    }
  }

  // -------------------------------------------------------------------------------------------

  private conversationPath(conversationId: string, action: string) {
    return `/internal/conversations/${encodeURIComponent(conversationId)}/${action}`;
  }

  private async *stream(
    ctx: EngineCallContext,
    conversationId: string,
    input: SendMessageInput,
    signal: AbortSignal,
  ): AsyncGenerator<EngineStreamEvent> {
    const response = await this.send(
      ctx,
      'POST',
      `/internal/conversations/${encodeURIComponent(conversationId)}/messages`,
      input,
      signal,
      'text/event-stream',
    );
    if (!response.ok) {
      throw await toEngineError(response);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      throw new EngineError(
        'protocol',
        'Expected a text/event-stream response from the engine',
        response.status,
      );
    }
    let done = false;
    try {
      for await (const raw of readSse(response.body)) {
        const event = toWireEvent(raw);
        if (!event) continue;
        if (event.type === 'error') {
          throw new EngineError(
            'unavailable',
            `The engine reported an error (${event.code})`,
            undefined,
            event.code,
          );
        }
        yield event;
        if (event.type === 'done') {
          done = true;
          return;
        }
      }
    } catch (error) {
      if (error instanceof EngineError) throw error;
      if (signal.aborted) throw abortError();
      throw new EngineError(
        'unavailable',
        `The engine stream broke (${describe(error)})`,
      );
    }
    if (!done) {
      throw new EngineError(
        'unavailable',
        'The engine stream ended before the "done" event',
      );
    }
  }

  private async json(
    ctx: EngineCallContext,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const signal = anySignal([
      AbortSignal.timeout(this.options.requestTimeoutMs),
      ctx.signal,
    ]);
    let response: Response;
    try {
      response = await this.send(
        ctx,
        method,
        path,
        body,
        signal,
        'application/json',
      );
      if (!response.ok) {
        throw await toEngineError(response);
      }
      const parsed: unknown = await response.json();
      return parsed;
    } catch (error) {
      if (error instanceof EngineError) throw error;
      if (signal.aborted) throw abortError(ctx.signal?.aborted);
      throw new EngineError(
        'protocol',
        `The engine sent an unreadable response (${describe(error)})`,
      );
    }
  }

  /** One request, retried once when the connection itself failed. */
  private async send(
    ctx: EngineCallContext,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal,
    accept: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
      'X-Tenant-Id': ctx.tenantId,
      Accept: accept,
    };
    if (ctx.requestId) headers['X-Request-Id'] = ctx.requestId;
    if (ctx.actingUserId) headers['X-Acting-User-Id'] = ctx.actingUserId;
    if (ctx.actingRole) headers['X-Acting-Role'] = ctx.actingRole;
    if (ctx.idempotencyKey) headers['Idempotency-Key'] = ctx.idempotencyKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const attempt = () =>
      this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    try {
      return await attempt();
    } catch (first) {
      if (signal.aborted) throw abortError(ctx.signal?.aborted);
      try {
        // A broken connection: safe to repeat because commands carry an Idempotency-Key.
        return await attempt();
      } catch (second) {
        if (signal.aborted) throw abortError(ctx.signal?.aborted);
        throw new EngineError(
          'unavailable',
          `The engine is unreachable (${describe(second ?? first)})`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------

function abortError(byCaller = false) {
  return new EngineError(
    byCaller ? 'unavailable' : 'timeout',
    byCaller ? 'The call was cancelled' : 'The engine did not answer in time',
  );
}

/** The error name/code only: messages from fetch can contain the URL, never anything secret. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? error.name;
  }
  return 'unknown error';
}

function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => !!s));
}

async function toEngineError(response: Response): Promise<EngineError> {
  let code: string | undefined;
  try {
    const body = (await response.json()) as { code?: unknown };
    if (typeof body.code === 'string') code = body.code;
  } catch {
    // the body is optional detail
  }
  const detail = `The engine answered ${response.status}${code ? ` ${code}` : ''}`;
  const status = response.status;
  if (status === 404) return new EngineError('not_found', detail, status, code);
  if (status === 409) return new EngineError('conflict', detail, status, code);
  if (status === 408 || status === 429 || status >= 500) {
    return new EngineError('unavailable', detail, status, code);
  }
  return new EngineError('rejected', detail, status, code);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EngineError('protocol', 'Expected an object from the engine');
  }
  return value as Record<string, unknown>;
}

function str(record: Record<string, unknown>, key: string): string {
  if (typeof record[key] !== 'string') {
    throw new EngineError('protocol', `The engine response lacks "${key}"`);
  }
  return record[key];
}

function asConversation(value: unknown): EngineConversation {
  const record = asRecord(value);
  return {
    id: str(record, 'id'),
    channel: str(record, 'channel') as EngineConversation['channel'],
    endCustomerId:
      typeof record.endCustomerId === 'string' ? record.endCustomerId : null,
    status: str(record, 'status') as EngineConversation['status'],
    escalationReason:
      typeof record.escalationReason === 'string'
        ? (record.escalationReason as EngineConversation['escalationReason'])
        : null,
    createdAt: str(record, 'createdAt'),
    lastMessageAt:
      typeof record.lastMessageAt === 'string' ? record.lastMessageAt : null,
    assignedUserId:
      typeof record.assignedUserId === 'string' ? record.assignedUserId : null,
    escalatedAt:
      typeof record.escalatedAt === 'string' ? record.escalatedAt : null,
    summary: typeof record.summary === 'string' ? record.summary : null,
    resolvedAt:
      typeof record.resolvedAt === 'string' ? record.resolvedAt : null,
    resolvedBy:
      typeof record.resolvedBy === 'string'
        ? (record.resolvedBy as EngineConversation['resolvedBy'])
        : null,
  };
}

function asMessage(value: unknown): EngineMessage {
  const record = asRecord(value);
  return {
    id: str(record, 'id'),
    conversationId: str(record, 'conversationId'),
    authorType: str(record, 'authorType') as EngineMessage['authorType'],
    authorUserId:
      typeof record.authorUserId === 'string' ? record.authorUserId : null,
    content: typeof record.content === 'string' ? record.content : '',
    contentKey:
      typeof record.contentKey === 'string' ? record.contentKey : null,
    createdAt: str(record, 'createdAt'),
  };
}

function asMessagePage(value: unknown): EngineMessagePage {
  const record = asRecord(value);
  if (!Array.isArray(record.data)) {
    throw new EngineError('protocol', 'The engine response lacks "data"');
  }
  const num = (key: string) =>
    typeof record[key] === 'number' ? (record[key] as number) : 0;
  return {
    data: record.data.map(asMessage),
    total: num('total'),
    skip: num('skip'),
    take: num('take'),
  };
}

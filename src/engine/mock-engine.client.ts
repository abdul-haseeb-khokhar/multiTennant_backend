import { randomUUID } from 'node:crypto';
import { EngineClient } from './engine-client';
import {
  CONVERSATION_STATUSES,
  ClaimInput,
  ConversationCounts,
  ConversationStatus,
  CreateConversationInput,
  EngineCallContext,
  EngineConversation,
  EngineConversationPage,
  EngineError,
  EngineEventEnvelope,
  EngineEventSink,
  EngineMessage,
  EngineStreamEvent,
  EscalateInput,
  EscalationReason,
  HumanMessageInput,
  ListConversationsQuery,
  ReleaseInput,
  ResolveInput,
  ResolvedBy,
  SendMessageInput,
} from './engine.types';
import { withDeadlines } from './stream-deadlines';

export interface MockEngineOptions {
  /** Pause between streamed tokens (ms). 0 in tests. */
  tokenDelayMs: number;
  /** Same meaning and defaults as the HTTP client, so `/slow` behaves like a real slow model. */
  firstTokenTimeoutMs: number;
  totalTimeoutMs: number;
}

export const DEFAULT_MOCK_OPTIONS: MockEngineOptions = {
  tokenDelayMs: 25,
  firstTokenTimeoutMs: 5000,
  totalTimeoutMs: 30_000,
};

/**
 * Commands a tester can type as the customer message to force engine behaviour (mock only; they
 * are ordinary text for the real engine). Documented in docs/contracts/README.md.
 */
export const MOCK_COMMANDS = {
  /** The conversation is escalated (reason `customer_requested`) after a handoff reply. */
  ESCALATE: '/escalate',
  /** The engine is unreachable: the call fails before anything is stored. */
  FAIL: '/fail',
  /** The model never answers: the first-token timeout (D7) fires. */
  SLOW: '/slow',
  /** The engine starts answering, then reports an error mid-stream. */
  BROKEN_STREAM: '/broken',
  /** The AI proposes an action that needs approval: the engine emits `action.proposed` (E4). */
  PROPOSE_ACTION: '/action',
} as const;

/** The system lines (`contentKey`, keys of the `widget` namespace) the mock engine writes. */
export const MOCK_SYSTEM_KEYS = {
  AGENT_JOINED: 'agent.joined',
  AGENT_LEFT: 'agent.left',
  RESOLVED: 'resolved.notice',
} as const;

/** How many delivered events the mock remembers for assertions. */
const MAX_EMITTED = 500;

interface StoredConversation {
  tenantId: string;
  conversation: EngineConversation;
  messages: EngineMessage[];
}

interface MessageResult {
  acceptedId: string;
  replyText: string | null;
  replyId: string | null;
  escalation: { reason: EscalationReason; summary?: string } | null;
  status: ConversationStatus;
  usage: { tokensIn: number; tokensOut: number } | null;
}

const HUMAN_REQUEST =
  /\b(human|real person|agent|representative|operator)\b|انسان|ایجنٹ/i;

const CANNED: [RegExp, string][] = [
  [
    /hour|open|وقت|کھلے/i,
    'We are open from 9:00 to 18:00, Monday to Saturday.',
  ],
  [
    /deliver|shipping|ship/i,
    'Standard delivery takes 2 to 4 working days within Pakistan.',
  ],
  [
    /price|cost|plan/i,
    'You can find all our plans and prices on the pricing page.',
  ],
];
const GENERIC_REPLY =
  'Thanks for your message. I am checking our knowledge base. Could you share a few more details, such as your order number?';
const HANDOFF_REPLY =
  'I will bring in a colleague who can help you with this. Please stay in the chat.';
const ACTION_REPLY =
  'I have asked a colleague to approve a refund for you. You will hear from us soon.';

/**
 * An in-process stand-in for the AI engine that behaves like the contract in
 * `docs/contracts/engine-internal.openapi.yaml`: conversations and messages live in memory per
 * tenant (another tenant's conversation answers `not_found`), commands are idempotent by
 * `Idempotency-Key`, an `escalated`/`human_active`/`resolved` conversation gets no AI reply (C4),
 * and the reply is streamed token by token. Selected with `ENGINE_MODE=mock`; refused in
 * production. State is lost on restart.
 *
 * Since Phase 4 it also plays the staff side (list, counts, claim, release, resolve, human
 * messages) and pushes the events of D5 to the backend's event receiver (`setEventSink`), exactly
 * the events the real engine will POST to `/internal/events`: the dashboard, the notifications and
 * the widget stream can be driven end to end without the engine.
 *
 * Force behaviour with the customer message (see `MOCK_COMMANDS`), or from a test with
 * `setDown`, `setTokenDelay`, `postHumanMessage`, `resolve` and `flushEvents`.
 */
export class MockEngineClient extends EngineClient {
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly idempotent = new Map<string, unknown>();
  private down = false;
  private sink?: EngineEventSink;
  private delivery: Promise<void> = Promise.resolve();
  /** Every event the mock produced (newest last, bounded): for assertions in tests. */
  readonly emitted: EngineEventEnvelope[] = [];

  constructor(private options: MockEngineOptions = DEFAULT_MOCK_OPTIONS) {
    super();
  }

  // ---- test and prototype controls --------------------------------------------------------

  /** While down, every call fails like an unreachable engine. */
  setDown(down: boolean) {
    this.down = down;
  }

  configure(options: Partial<MockEngineOptions>) {
    this.options = { ...this.options, ...options };
  }

  /** Where events are delivered, in order, one at a time (the backend's receiver). */
  setEventSink(sink: EngineEventSink | undefined) {
    this.sink = sink;
  }

  /** Resolves when every event produced so far has been handed to the sink. */
  async flushEvents() {
    let pending: Promise<void>;
    do {
      pending = this.delivery;
      await pending;
    } while (pending !== this.delivery);
  }

  reset() {
    this.conversations.clear();
    this.idempotent.clear();
    this.emitted.length = 0;
    this.down = false;
  }

  /** What the engine holds for a tenant (assertions in tests). */
  inspect(tenantId: string, conversationId: string) {
    const stored = this.conversations.get(key(tenantId, conversationId));
    return stored
      ? {
          conversation: { ...stored.conversation },
          messages: stored.messages.map((m) => ({ ...m })),
        }
      : null;
  }

  conversationCount(tenantId: string) {
    return [...this.conversations.values()].filter(
      (c) => c.tenantId === tenantId,
    ).length;
  }

  /** The events of one type produced for a tenant (assertions in tests). */
  eventsOf(tenantId: string, type: string) {
    return this.emitted.filter(
      (e) => e.tenantId === tenantId && e.type === type,
    );
  }

  /** Simulates a staff member replying: assigns them and stores an `author_type=human` message. */
  postHumanMessage(
    tenantId: string,
    conversationId: string,
    userId: string,
    content: string,
  ) {
    const stored = this.require(tenantId, conversationId);
    stored.conversation.status = 'human_active';
    stored.conversation.assignedUserId = userId;
    this.addMessage(stored, {
      authorType: 'human',
      authorUserId: userId,
      content,
    });
  }

  /** Simulates the conversation being resolved: it accepts no more messages. */
  resolve(
    tenantId: string,
    conversationId: string,
    resolvedBy: ResolvedBy = 'human',
  ) {
    this.finish(this.require(tenantId, conversationId), resolvedBy);
  }

  // ---- EngineClient -------------------------------------------------------------------------

  async health() {
    return { ok: !this.down };
  }

  async createConversation(
    ctx: EngineCallContext,
    input: CreateConversationInput,
  ): Promise<EngineConversation> {
    this.assertUp();
    return this.once(ctx, 'create', () => {
      const now = new Date().toISOString();
      const conversation: EngineConversation = {
        id: randomUUID(),
        channel: input.channel,
        endCustomerId: input.endCustomerId,
        status: 'active',
        escalationReason: null,
        createdAt: now,
        lastMessageAt: null,
        assignedUserId: null,
        escalatedAt: null,
        summary: null,
        resolvedAt: null,
        resolvedBy: null,
      };
      this.conversations.set(key(ctx.tenantId, conversation.id), {
        tenantId: ctx.tenantId,
        conversation,
        messages: [],
      });
      this.emit(ctx.tenantId, 'conversation.created', {
        conversationId: conversation.id,
        endCustomerId: input.endCustomerId,
        channel: input.channel,
      });
      return conversation;
    });
  }

  async getConversation(
    ctx: EngineCallContext,
    conversationId: string,
    page: { skip?: number; take?: number } = {},
  ) {
    this.assertUp();
    const stored = this.require(ctx.tenantId, conversationId);
    const skip = Math.max(page.skip ?? 0, 0);
    const take = Math.min(Math.max(page.take ?? 20, 1), 100);
    return {
      conversation: clone(stored.conversation),
      messages: {
        data: stored.messages.slice(skip, skip + take).map(clone),
        total: stored.messages.length,
        skip,
        take,
      },
    };
  }

  async escalate(
    ctx: EngineCallContext,
    conversationId: string,
    input: EscalateInput,
  ): Promise<EngineConversation> {
    this.assertUp();
    return this.once(ctx, `escalate:${conversationId}`, () => {
      const stored = this.require(ctx.tenantId, conversationId);
      if (stored.conversation.status === 'resolved') {
        throw new EngineError('conflict', 'The conversation is resolved', 409);
      }
      if (stored.conversation.status === 'active') {
        this.markEscalated(stored, input.reason, input.summary);
      }
      return stored.conversation;
    });
  }

  async listConversations(
    ctx: EngineCallContext,
    query: ListConversationsQuery,
  ): Promise<EngineConversationPage> {
    this.assertUp();
    const skip = Math.max(query.skip ?? 0, 0);
    const take = Math.min(Math.max(query.take ?? 20, 1), 100);
    const wanted = query.status?.length ? new Set(query.status) : undefined;
    const rows = [...this.conversations.values()]
      // The tenant is part of the lookup: another tenant's conversations do not exist for you.
      .filter((s) => s.tenantId === ctx.tenantId)
      .map((s) => s.conversation)
      .filter((c) => !wanted || wanted.has(c.status))
      .filter(
        (c) =>
          !query.assignedUserId || c.assignedUserId === query.assignedUserId,
      )
      .filter(
        (c) => !query.endCustomerId || c.endCustomerId === query.endCustomerId,
      );
    const instant = (value: string | null, fallback: string) =>
      Date.parse(value ?? fallback);
    rows.sort((a, b) => {
      if (query.sort === 'escalatedAt') {
        // Oldest waiting first; a conversation that never escalated sorts last.
        const diff =
          instant(a.escalatedAt, '9999-12-31T00:00:00.000Z') -
          instant(b.escalatedAt, '9999-12-31T00:00:00.000Z');
        return diff || a.id.localeCompare(b.id);
      }
      const diff =
        instant(b.lastMessageAt, b.createdAt) -
        instant(a.lastMessageAt, a.createdAt);
      return diff || a.id.localeCompare(b.id);
    });
    return {
      data: rows.slice(skip, skip + take).map(clone),
      total: rows.length,
      skip,
      take,
    };
  }

  async countConversations(
    ctx: EngineCallContext,
    filter: { assignedUserId?: string } = {},
  ): Promise<ConversationCounts> {
    this.assertUp();
    const counts = Object.fromEntries(
      CONVERSATION_STATUSES.map((status) => [status, 0]),
    ) as ConversationCounts;
    for (const stored of this.conversations.values()) {
      if (stored.tenantId !== ctx.tenantId) continue;
      const c = stored.conversation;
      if (filter.assignedUserId && c.assignedUserId !== filter.assignedUserId) {
        continue;
      }
      counts[c.status] += 1;
    }
    return counts;
  }

  async claimConversation(
    ctx: EngineCallContext,
    conversationId: string,
    input: ClaimInput,
  ): Promise<EngineConversation> {
    this.assertUp();
    return this.once(ctx, `claim:${conversationId}`, () => {
      const stored = this.require(ctx.tenantId, conversationId);
      const c = stored.conversation;
      if (c.status === 'resolved') throw resolvedConflict();
      // Atomic by construction (one synchronous step): only an unassigned active/escalated
      // conversation can be claimed.
      if (c.status === 'human_active' || c.assignedUserId) {
        throw new EngineError(
          'conflict',
          'The conversation is already claimed',
          409,
          'CONVERSATION_ALREADY_CLAIMED',
        );
      }
      c.status = 'human_active';
      c.assignedUserId = input.userId;
      this.emit(ctx.tenantId, 'conversation.assigned', {
        conversationId,
        assignedUserId: input.userId,
        assignedByUserId: input.userId,
      });
      this.addSystemLine(stored, MOCK_SYSTEM_KEYS.AGENT_JOINED);
      return c;
    });
  }

  async releaseConversation(
    ctx: EngineCallContext,
    conversationId: string,
    input: ReleaseInput,
  ): Promise<EngineConversation> {
    this.assertUp();
    return this.once(ctx, `release:${conversationId}`, () => {
      const stored = this.require(ctx.tenantId, conversationId);
      const c = stored.conversation;
      this.assertHolder(c, input.userId, input.force === true);
      const previousUserId = c.assignedUserId;
      if (input.to === 'resolved') {
        this.finish(stored, 'human');
        return c;
      }
      c.status = input.to;
      c.assignedUserId = null;
      if (input.to === 'escalated') c.escalatedAt ??= new Date().toISOString();
      this.emit(ctx.tenantId, 'conversation.released', {
        conversationId,
        to: input.to,
        previousUserId,
        ...(input.reason && { reason: input.reason }),
      });
      this.addSystemLine(stored, MOCK_SYSTEM_KEYS.AGENT_LEFT);
      return c;
    });
  }

  async resolveConversation(
    ctx: EngineCallContext,
    conversationId: string,
    input: ResolveInput,
  ): Promise<EngineConversation> {
    this.assertUp();
    return this.once(ctx, `resolve:${conversationId}`, () => {
      const stored = this.require(ctx.tenantId, conversationId);
      this.assertHolder(stored.conversation, input.userId, false);
      this.finish(stored, 'human');
      return stored.conversation;
    });
  }

  async sendHumanMessage(
    ctx: EngineCallContext,
    conversationId: string,
    input: HumanMessageInput,
  ): Promise<EngineMessage> {
    this.assertUp();
    return this.once(ctx, `human:${conversationId}`, () => {
      const stored = this.require(ctx.tenantId, conversationId);
      this.assertHolder(stored.conversation, input.userId, false);
      if (!input.content.trim()) {
        throw new EngineError('rejected', 'The message is empty', 400);
      }
      return this.addMessage(stored, {
        authorType: 'human',
        authorUserId: input.userId,
        content: input.content,
      });
    });
  }

  async *sendMessage(
    ctx: EngineCallContext,
    conversationId: string,
    input: SendMessageInput,
  ): AsyncGenerator<EngineStreamEvent> {
    this.assertUp();
    const text = input.content.trim();
    if (text.toLowerCase().startsWith(MOCK_COMMANDS.FAIL)) {
      throw new EngineError('unavailable', 'The mock engine is set to fail');
    }
    const stored = this.require(ctx.tenantId, conversationId);
    if (stored.conversation.status === 'resolved') {
      throw new EngineError('conflict', 'The conversation is resolved', 409);
    }

    const abort = new AbortController();
    const onCallerAbort = () => abort.abort();
    ctx.signal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      yield* withDeadlines(
        this.run(ctx, stored, input, abort.signal),
        {
          firstTokenMs: this.options.firstTokenTimeoutMs,
          totalMs: this.options.totalTimeoutMs,
        },
        () => abort.abort(),
      );
    } finally {
      ctx.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  // ---- internals ----------------------------------------------------------------------------

  private async *run(
    ctx: EngineCallContext,
    stored: StoredConversation,
    input: SendMessageInput,
    signal: AbortSignal,
  ): AsyncGenerator<EngineStreamEvent> {
    const replay = ctx.idempotencyKey
      ? (this.idempotent.get(
          idemKey(ctx.tenantId, `msg:${stored.conversation.id}`, ctx),
        ) as MessageResult | undefined)
      : undefined;
    if (replay) {
      yield* this.emitStream(replay, signal, true);
      return;
    }

    const customerMessage = this.addMessage(stored, {
      authorType: 'customer',
      content: input.content,
    });
    const text = input.content.trim().toLowerCase();
    const wantsReply =
      input.aiReply !== false && stored.conversation.status === 'active';

    const result: MessageResult = {
      acceptedId: customerMessage.id,
      replyText: null,
      replyId: null,
      escalation: null,
      status: stored.conversation.status,
      usage: null,
    };
    const remember = () => {
      if (ctx.idempotencyKey) {
        this.idempotent.set(
          idemKey(ctx.tenantId, `msg:${stored.conversation.id}`, ctx),
          result,
        );
      }
    };

    if (!wantsReply) {
      remember();
      yield* this.emitStream(result, signal, false);
      return;
    }

    yield {
      type: 'accepted',
      messageId: customerMessage.id,
      conversationStatus: stored.conversation.status,
    };
    if (text.startsWith(MOCK_COMMANDS.SLOW)) {
      await sleepUntilAborted(signal);
      return;
    }
    if (text.startsWith(MOCK_COMMANDS.BROKEN_STREAM)) {
      yield { type: 'token', text: 'Let me check ' };
      throw new EngineError(
        'unavailable',
        'The mock engine reported an error',
        undefined,
        'MOCK_BROKEN_STREAM',
      );
    }

    const proposeAction = text.startsWith(MOCK_COMMANDS.PROPOSE_ACTION);
    const handoff =
      text.startsWith(MOCK_COMMANDS.ESCALATE) || HUMAN_REQUEST.test(text);
    result.replyText = handoff
      ? HANDOFF_REPLY
      : proposeAction
        ? ACTION_REPLY
        : (CANNED.find(([pattern]) => pattern.test(text))?.[1] ??
          GENERIC_REPLY);
    const reply = this.addMessage(stored, {
      authorType: 'ai',
      content: result.replyText,
    });
    result.replyId = reply.id;
    result.usage = {
      tokensIn: Math.ceil(input.content.length / 4) + 50,
      tokensOut: Math.ceil(result.replyText.length / 4),
    };
    this.emit(ctx.tenantId, 'usage.recorded', {
      conversationId: stored.conversation.id,
      messageId: reply.id,
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      model: 'mock-llm-1',
    });
    if (proposeAction) {
      this.emit(ctx.tenantId, 'action.proposed', {
        actionId: randomUUID(),
        conversationId: stored.conversation.id,
        action: 'refund',
      });
    }
    if (handoff) {
      result.escalation = {
        reason: 'customer_requested',
        summary: 'The customer asked for a human.',
      };
      this.markEscalated(
        stored,
        result.escalation.reason,
        result.escalation.summary,
      );
    }
    result.status = stored.conversation.status;
    remember();
    yield* this.emitStream(result, signal, true, true);
  }

  /** Streams a stored result (first run and replay look the same, as the contract says). */
  private async *emitStream(
    result: MessageResult,
    signal: AbortSignal,
    withReply: boolean,
    live = false,
  ): AsyncGenerator<EngineStreamEvent> {
    if (!live) {
      yield {
        type: 'accepted',
        messageId: result.acceptedId,
        conversationStatus: result.status,
      };
    }
    if (withReply && result.replyText) {
      if (live) {
        for (const word of tokens(result.replyText)) {
          await sleep(this.options.tokenDelayMs, signal);
          yield { type: 'token', text: word };
        }
      } else {
        yield { type: 'token', text: result.replyText };
      }
      if (live && result.usage && result.replyId) {
        yield {
          type: 'usage',
          messageId: result.replyId,
          tokensIn: result.usage.tokensIn,
          tokensOut: result.usage.tokensOut,
          model: 'mock-llm-1',
          latencyMs: 1,
        };
      }
      if (result.escalation) {
        yield { type: 'escalated', ...result.escalation };
      }
    }
    yield {
      type: 'done',
      messageId: result.replyId,
      conversationStatus: result.status,
      aiReply: result.replyId !== null,
    };
  }

  private assertUp() {
    if (this.down) {
      throw new EngineError('unavailable', 'The mock engine is down');
    }
  }

  private require(tenantId: string, conversationId: string) {
    // The tenant is part of the lookup: another tenant's conversation does not exist for you.
    const stored = this.conversations.get(key(tenantId, conversationId));
    if (!stored) {
      throw new EngineError(
        'not_found',
        'Conversation not found',
        404,
        'CONVERSATION_NOT_FOUND',
      );
    }
    return stored;
  }

  /** Release, resolve and reply need a `human_active` conversation held by `userId` (unless forced). */
  private assertHolder(c: EngineConversation, userId: string, force: boolean) {
    if (c.status === 'resolved') throw resolvedConflict();
    if (
      c.status !== 'human_active' ||
      (!force && c.assignedUserId !== userId)
    ) {
      throw new EngineError(
        'conflict',
        'The conversation is not assigned to this user',
        409,
        'CONVERSATION_NOT_ASSIGNED_TO_YOU',
      );
    }
  }

  private markEscalated(
    stored: StoredConversation,
    reason: EscalationReason,
    summary?: string,
  ) {
    const c = stored.conversation;
    c.status = 'escalated';
    c.escalationReason = reason;
    c.escalatedAt = new Date().toISOString();
    c.summary = summary ?? c.summary;
    this.emit(stored.tenantId, 'conversation.escalated', {
      conversationId: c.id,
      endCustomerId: c.endCustomerId,
      reason,
      ...(summary && { summary }),
    });
  }

  private finish(stored: StoredConversation, resolvedBy: ResolvedBy) {
    const c = stored.conversation;
    c.status = 'resolved';
    c.assignedUserId = null;
    c.resolvedAt = new Date().toISOString();
    c.resolvedBy = resolvedBy;
    this.emit(stored.tenantId, 'conversation.resolved', {
      conversationId: c.id,
      resolvedBy,
    });
    this.addSystemLine(stored, MOCK_SYSTEM_KEYS.RESOLVED);
  }

  private addSystemLine(stored: StoredConversation, contentKey: string) {
    return this.addMessage(stored, {
      authorType: 'system',
      content: '',
      contentKey,
    });
  }

  private addMessage(
    stored: StoredConversation,
    message: Pick<EngineMessage, 'authorType' | 'content'> &
      Partial<EngineMessage>,
  ) {
    const now = new Date().toISOString();
    const full: EngineMessage = {
      id: randomUUID(),
      conversationId: stored.conversation.id,
      createdAt: now,
      authorUserId: null,
      contentKey: null,
      ...message,
    };
    stored.messages.push(full);
    stored.conversation.lastMessageAt = now;
    this.emit(stored.tenantId, 'message.created', {
      conversationId: full.conversationId,
      messageId: full.id,
      authorType: full.authorType,
      createdAt: full.createdAt,
      // The text travels only for what a customer may see (staff replies and system lines).
      ...((full.authorType === 'human' || full.authorType === 'system') && {
        content: full.content,
        contentKey: full.contentKey,
        authorUserId: full.authorUserId,
      }),
    });
    return full;
  }

  /** Queues an event for the sink; delivery is in order and never breaks the engine call. */
  private emit(tenantId: string, type: string, data: Record<string, unknown>) {
    const envelope: EngineEventEnvelope = {
      id: randomUUID(),
      type,
      tenantId,
      occurredAt: new Date().toISOString(),
      data,
    };
    this.emitted.push(envelope);
    if (this.emitted.length > MAX_EMITTED) this.emitted.shift();
    const sink = this.sink;
    if (!sink) return;
    this.delivery = this.delivery
      .then(() => sink(envelope))
      .catch(() => undefined);
  }

  /** Runs `create` once per Idempotency-Key (per tenant and operation); a replay returns a copy of the first result. */
  private async once<T>(
    ctx: EngineCallContext,
    operation: string,
    create: () => T,
  ): Promise<T> {
    if (!ctx.idempotencyKey) return clone(create());
    const k = idemKey(ctx.tenantId, operation, ctx);
    if (this.idempotent.has(k)) return clone(this.idempotent.get(k) as T);
    const created = clone(create());
    this.idempotent.set(k, created);
    return clone(created);
  }
}

function key(tenantId: string, id: string) {
  return `${tenantId}|${id}`;
}

function idemKey(tenantId: string, operation: string, ctx: EngineCallContext) {
  return `${tenantId}|${operation}|${ctx.idempotencyKey}`;
}

function resolvedConflict() {
  return new EngineError(
    'conflict',
    'The conversation is resolved',
    409,
    'CONVERSATION_RESOLVED',
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Words with their trailing space, so concatenating the tokens gives the original text. */
function tokens(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new EngineError('timeout', 'The call was aborted'));
      },
      { once: true },
    );
  });
}

function sleepUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new EngineError('timeout', 'The call was aborted'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => reject(new EngineError('timeout', 'The call was aborted')),
      { once: true },
    );
  });
}

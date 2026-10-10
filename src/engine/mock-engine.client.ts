import { randomUUID } from 'node:crypto';
import { EngineClient } from './engine-client';
import {
  ConversationStatus,
  CreateConversationInput,
  EngineCallContext,
  EngineConversation,
  EngineError,
  EngineMessage,
  EngineStreamEvent,
  EscalateInput,
  EscalationReason,
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
} as const;

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
    /hour|open|وقت|کھلے/i,
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

/**
 * An in-process stand-in for the AI engine that behaves like the contract in
 * `docs/contracts/engine-internal.openapi.yaml`: conversations and messages live in memory per
 * tenant (another tenant's conversation answers `not_found`), commands are idempotent by
 * `Idempotency-Key`, an `escalated`/`human_active`/`resolved` conversation gets no AI reply (C4),
 * and the reply is streamed token by token. Selected with `ENGINE_MODE=mock`; refused in
 * production. State is lost on restart.
 *
 * Force behaviour with the customer message (see `MOCK_COMMANDS`), or from a test with
 * `setDown`, `setTokenDelay` and `postHumanMessage`.
 */
export class MockEngineClient extends EngineClient {
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly idempotent = new Map<string, unknown>();
  private down = false;

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

  reset() {
    this.conversations.clear();
    this.idempotent.clear();
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

  /** Simulates a staff member replying (Phase 4 makes this real): `author_type=human`. */
  postHumanMessage(
    tenantId: string,
    conversationId: string,
    userId: string,
    content: string,
  ) {
    const stored = this.require(tenantId, conversationId);
    stored.conversation.status = 'human_active';
    this.addMessage(stored, {
      authorType: 'human',
      authorUserId: userId,
      content,
    });
  }

  /** Simulates a staff member resolving the conversation: it accepts no more messages. */
  resolve(tenantId: string, conversationId: string) {
    this.require(tenantId, conversationId).conversation.status = 'resolved';
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
      };
      this.conversations.set(key(ctx.tenantId, conversation.id), {
        tenantId: ctx.tenantId,
        conversation,
        messages: [],
      });
      return conversation;
    }).then(clone);
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
    const stored = this.require(ctx.tenantId, conversationId);
    if (stored.conversation.status === 'resolved') {
      throw new EngineError('conflict', 'The conversation is resolved', 409);
    }
    if (stored.conversation.status === 'active') {
      stored.conversation.status = 'escalated';
      stored.conversation.escalationReason = input.reason;
    }
    return clone(stored.conversation);
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
      yield* this.emit(replay, signal, true);
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
      yield* this.emit(result, signal, false);
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

    const handoff =
      text.startsWith(MOCK_COMMANDS.ESCALATE) || HUMAN_REQUEST.test(text);
    result.replyText = handoff
      ? HANDOFF_REPLY
      : (CANNED.find(([pattern]) => pattern.test(text))?.[1] ?? GENERIC_REPLY);
    const reply = this.addMessage(stored, {
      authorType: 'ai',
      content: result.replyText,
    });
    result.replyId = reply.id;
    result.usage = {
      tokensIn: Math.ceil(input.content.length / 4) + 50,
      tokensOut: Math.ceil(result.replyText.length / 4),
    };
    if (handoff) {
      stored.conversation.status = 'escalated';
      stored.conversation.escalationReason = 'customer_requested';
      result.escalation = {
        reason: 'customer_requested',
        summary: 'The customer asked for a human.',
      };
    }
    result.status = stored.conversation.status;
    remember();
    yield* this.emit(result, signal, true, true);
  }

  /** Streams a stored result (first run and replay look the same, as the contract says). */
  private async *emit(
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
    return full;
  }

  /** Runs `create` once per Idempotency-Key (per tenant and operation). */
  private async once<T>(
    ctx: EngineCallContext,
    operation: string,
    create: () => T,
  ): Promise<T> {
    if (!ctx.idempotencyKey) return create();
    const k = idemKey(ctx.tenantId, operation, ctx);
    if (this.idempotent.has(k)) return this.idempotent.get(k) as T;
    const created = create();
    this.idempotent.set(k, created);
    return created;
  }
}

function key(tenantId: string, id: string) {
  return `${tenantId}|${id}`;
}

function idemKey(tenantId: string, operation: string, ctx: EngineCallContext) {
  return `${tenantId}|${operation}|${ctx.idempotencyKey}`;
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

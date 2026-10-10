/**
 * Types of the engine internal API (`docs/contracts/engine-internal.openapi.yaml`). Only what
 * the gateway uses; the engine's own models are not declared here (CLAUDE.md rule 5).
 */
export const ENGINE_CHANNELS = ['widget', 'whatsapp', 'voice'] as const;
export type EngineChannel = (typeof ENGINE_CHANNELS)[number];

export type ConversationStatus =
  'active' | 'escalated' | 'human_active' | 'resolved';

/**
 * Stable escalation reason codes. `ai_unavailable` and `limit_reached` are set by the backend,
 * the others by the engine (C6).
 */
export const ESCALATION_REASONS = [
  'customer_requested',
  'low_confidence',
  'failed_action',
  'sentiment',
  'topic',
  'outside_hours',
  'ai_unavailable',
  'limit_reached',
  'other',
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export interface EngineConversation {
  id: string;
  channel: EngineChannel;
  endCustomerId: string | null;
  status: ConversationStatus;
  escalationReason: EscalationReason | null;
  createdAt: string;
  lastMessageAt: string | null;
}

export type EngineAuthorType = 'customer' | 'ai' | 'human' | 'system' | 'tool';

export interface EngineMessage {
  id: string;
  conversationId: string;
  authorType: EngineAuthorType;
  authorUserId?: string | null;
  content: string;
  contentKey?: string | null;
  createdAt: string;
}

export interface EngineMessagePage {
  data: EngineMessage[];
  total: number;
  skip: number;
  take: number;
}

/** Who the call is for. The tenant is the ONLY source of `X-Tenant-Id`. */
export interface EngineCallContext {
  tenantId: string;
  requestId?: string;
  idempotencyKey?: string;
  /** Aborts the call (customer closed the widget). */
  signal?: AbortSignal;
}

export interface CreateConversationInput {
  channel: EngineChannel;
  endCustomerId: string;
  locale?: string;
}

export interface SendMessageInput {
  content: string;
  externalMessageId?: string;
  /** false = store the message but let no AI answer (plan limit, I5). Default true. */
  aiReply?: boolean;
}

export interface EscalateInput {
  reason: EscalationReason;
  summary?: string;
}

/** Events of the message stream, in the order the engine sends them. */
export type EngineStreamEvent =
  | {
      type: 'accepted';
      messageId: string;
      conversationStatus: ConversationStatus;
    }
  | { type: 'token'; text: string }
  | {
      type: 'usage';
      messageId: string;
      tokensIn: number;
      tokensOut: number;
      model?: string;
      latencyMs?: number;
    }
  | { type: 'escalated'; reason: EscalationReason; summary?: string }
  | {
      type: 'done';
      messageId: string | null;
      conversationStatus: ConversationStatus;
      aiReply: boolean;
    };

/**
 * What can appear on the wire. An `error` event is never handed to callers: the client turns it
 * into a thrown `EngineError`, so a stream consumer only ever sees `EngineStreamEvent`.
 */
export type EngineWireEvent =
  EngineStreamEvent | { type: 'error'; code: string; message: string };

export type EngineErrorKind =
  /** Network failure, 5xx, engine unreachable. */
  | 'unavailable'
  /** No first token / no end in time (D7). */
  | 'timeout'
  | 'not_found'
  /** 409 on a resolved conversation. */
  | 'conflict'
  /** Another 4xx: the engine refused the request (a bug or a contract mismatch). */
  | 'rejected'
  /** The engine answered something the contract does not allow. */
  | 'protocol';

/** Everything that can go wrong when talking to the engine. Never shown to customers. */
export class EngineError extends Error {
  constructor(
    public readonly kind: EngineErrorKind,
    message: string,
    public readonly status?: number,
    public readonly engineCode?: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }

  /** True when the engine could not do its job (as opposed to us sending something wrong). */
  get isOutage() {
    return this.kind === 'unavailable' || this.kind === 'timeout';
  }
}

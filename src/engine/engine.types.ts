/**
 * Types of the engine internal API (`docs/contracts/engine-internal.openapi.yaml`). Only what
 * the gateway uses; the engine's own models are not declared here (CLAUDE.md rule 5).
 */
export const ENGINE_CHANNELS = ['widget', 'whatsapp', 'voice'] as const;
export type EngineChannel = (typeof ENGINE_CHANNELS)[number];

export type ConversationStatus =
  'active' | 'escalated' | 'human_active' | 'resolved';

export const CONVERSATION_STATUSES: readonly ConversationStatus[] = [
  'active',
  'escalated',
  'human_active',
  'resolved',
];

/** Who closed a conversation (C1). */
export type ResolvedBy = 'ai' | 'human' | 'customer' | 'system';

/** Where a released conversation goes (Phase 4). `resolved` is the same as resolving it. */
export type ReleaseTarget = 'active' | 'escalated' | 'resolved';

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
  /** The staff user (a `tenant_user.id`) handling it while `human_active`; the engine stores the id, the backend resolves the name. */
  assignedUserId: string | null;
  /** When it was (last) escalated, for the queue order (oldest waiting first). */
  escalatedAt: string | null;
  /** Short handoff note the engine wrote on escalation. */
  summary: string | null;
  resolvedAt: string | null;
  resolvedBy: ResolvedBy | null;
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
  /** Staff calls (Phase 4): the acting user, sent as `X-Acting-User-Id` / `X-Acting-Role` for the engine's own audit. Never a source of the tenant. */
  actingUserId?: string;
  actingRole?: string;
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

export type ConversationSort = 'lastMessageAt' | 'escalatedAt';

/** Filters of the staff conversation list (`GET /internal/conversations`). */
export interface ListConversationsQuery {
  /** Any of these statuses (the queue is `escalated`). */
  status?: ConversationStatus[];
  assignedUserId?: string;
  endCustomerId?: string;
  /** Default `lastMessageAt` (newest first); `escalatedAt` is oldest first, the order of the queue. */
  sort?: ConversationSort;
  skip?: number;
  take?: number;
}

export interface EngineConversationPage {
  data: EngineConversation[];
  total: number;
  skip: number;
  take: number;
}

/** Number of conversations per status (always all four keys). */
export type ConversationCounts = Record<ConversationStatus, number>;

export interface ClaimInput {
  userId: string;
}

export interface ReleaseInput {
  userId: string;
  to: ReleaseTarget;
  /**
   * The backend sets it only when it releases a conversation on behalf of a holder who is gone
   * (disabled or deleted): the engine then skips the "you are the assignee" check.
   */
  force?: boolean;
  reason?: string;
}

export interface ResolveInput {
  userId: string;
}

export interface HumanMessageInput {
  userId: string;
  content: string;
}

/**
 * What the engine pushes to `POST /internal/events` (D5) and what the mock delivers in-process.
 * `tenantId` is the ENVELOPE's: the backend never takes a tenant from `data`.
 */
export interface EngineEventEnvelope {
  /** Unique per event; delivery is idempotent by (tenantId, id). */
  id: string;
  type: string;
  tenantId: string;
  /** ISO-8601 instant the event happened. */
  occurredAt: string;
  data: Record<string, unknown>;
}

/** Where the mock engine delivers its events. Set by the event receiver at start-up. */
export type EngineEventSink = (event: EngineEventEnvelope) => Promise<void>;

/**
 * What the engine gets when it pulls an agent's settings at the start of a call (L7,
 * `GET /internal/tenants/{tenantId}/agents/{agentId}/config`). `config` is the settings document.
 */
export interface PulledAgentSettings {
  agentId: string;
  version: number;
  status: 'active' | 'disabled';
  config: object;
}

/**
 * How the mock engine pulls an agent's settings: the backend hands it the same service the real
 * route uses. Without an `agentId` the tenant's default agent; `null` when the tenant has none.
 */
export type AgentConfigSource = (
  tenantId: string,
  agentId?: string,
) => Promise<PulledAgentSettings | null>;

/** The tenant status check the engine asks before it serves a call (his B1; the same service as `GET /internal/tenants/{tenantId}/status`). */
export interface BackendTenantStatus {
  serviceable: boolean;
  /** `suspended`, `unpaid`, `quota_exceeded`, `agent_disabled`, `unknown_agent`, `unknown_tenant` or null. */
  reason: string | null;
  agentId: string | null;
  plan: string | null;
  overage: boolean;
}

export interface BackendRequestInput {
  agentId?: string;
  reference: string;
  type: 'appointment' | 'callback';
  submissionKey: string;
  endCustomerId: string;
  conversationId?: string;
  channel?: 'voice' | 'chat';
  language?: string;
  summary: string;
  scheduledLocal?: string | null;
  timezone?: string;
  configVersion?: number;
  data?: Record<string, unknown>;
}

/**
 * The routes the real engine calls on the backend (status check, customer upsert, requests), as the
 * mock engine uses them: the backend hands the mock these functions, which run the very same services
 * as the internal routes, so a simulated call proves what the routes do (Phase 5B-2). Without it the
 * mock keeps its own in-memory requests only (unit tests of the mock itself).
 */
export interface EngineBackendPort {
  tenantStatus(
    tenantId: string,
    agentId?: string,
  ): Promise<BackendTenantStatus>;
  upsertCustomer(
    tenantId: string,
    input: { agentId?: string; phone: string; name?: string; locale?: string },
  ): Promise<{ endCustomerId: string; created: boolean }>;
  /** `reference_taken`: the engine draws another reference and tries again. */
  createRequest(
    tenantId: string,
    input: BackendRequestInput,
  ): Promise<
    | {
        ok: true;
        id: string;
        agentId: string;
        reference: string;
        created: boolean;
      }
    | { ok: false; reason: 'reference_taken' }
  >;
  /** `locked`: a person acted on it, the engine may not change it any more. */
  updateRequest(
    tenantId: string,
    reference: string,
    change: {
      summary?: string;
      scheduledLocal?: string | null;
      data?: Record<string, unknown>;
    },
  ): Promise<{ ok: true } | { ok: false; reason: 'locked' | 'not_found' }>;
  withdrawRequest(
    tenantId: string,
    reference: string,
    reason?: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'locked' | 'not_found' }>;
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

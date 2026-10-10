import type {
  ClaimInput,
  ConversationCounts,
  CreateConversationInput,
  EngineCallContext,
  EngineConversation,
  EngineConversationPage,
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

/**
 * The backend's only way to talk to the AI engine (D1, D2). Two implementations are selected by
 * `ENGINE_MODE`: `HttpEngineClient` (the real engine over the private network) and
 * `MockEngineClient` (in-process, follows the same contract). Everything that needs the engine
 * depends on this class, never on an implementation.
 *
 * `ctx.tenantId` must come from a verified credential (widget token, staff JWT, provider
 * signature), never from request content: it becomes the engine's `X-Tenant-Id`.
 */
export abstract class EngineClient {
  abstract health(): Promise<{ ok: boolean }>;

  abstract createConversation(
    ctx: EngineCallContext,
    input: CreateConversationInput,
  ): Promise<EngineConversation>;

  abstract getConversation(
    ctx: EngineCallContext,
    conversationId: string,
    page?: { skip?: number; take?: number },
  ): Promise<{ conversation: EngineConversation; messages: EngineMessagePage }>;

  /**
   * Stores a customer message and streams what the engine does with it. Throws `EngineError`
   * (also from inside the iteration) when the engine is down, too slow or refuses.
   */
  abstract sendMessage(
    ctx: EngineCallContext,
    conversationId: string,
    input: SendMessageInput,
  ): AsyncIterable<EngineStreamEvent>;

  abstract escalate(
    ctx: EngineCallContext,
    conversationId: string,
    input: EscalateInput,
  ): Promise<EngineConversation>;

  // ---- Phase 4: the staff side (human takeover, C1 to C4, D6) ------------------------------

  /** A page of the tenant's conversations (the queue, "mine", a customer's history). */
  abstract listConversations(
    ctx: EngineCallContext,
    query: ListConversationsQuery,
  ): Promise<EngineConversationPage>;

  /** How many conversations are in each status (sidebar badge); `assignedUserId` narrows it to one holder. */
  abstract countConversations(
    ctx: EngineCallContext,
    filter?: { assignedUserId?: string },
  ): Promise<ConversationCounts>;

  /**
   * Atomic: only an `active` or `escalated` conversation without an assignee can be claimed
   * (it becomes `human_active`); otherwise `EngineError` of kind `conflict` (engine code
   * `CONVERSATION_ALREADY_CLAIMED` or `CONVERSATION_RESOLVED`).
   */
  abstract claimConversation(
    ctx: EngineCallContext,
    conversationId: string,
    input: ClaimInput,
  ): Promise<EngineConversation>;

  /** Gives the conversation back (`active`: the AI resumes; `escalated`: back in the queue; `resolved`). */
  abstract releaseConversation(
    ctx: EngineCallContext,
    conversationId: string,
    input: ReleaseInput,
  ): Promise<EngineConversation>;

  /** The assignee closes the conversation. */
  abstract resolveConversation(
    ctx: EngineCallContext,
    conversationId: string,
    input: ResolveInput,
  ): Promise<EngineConversation>;

  /** Stores a staff reply (`author_type=human`); only the assignee of a `human_active` conversation may. */
  abstract sendHumanMessage(
    ctx: EngineCallContext,
    conversationId: string,
    input: HumanMessageInput,
  ): Promise<EngineMessage>;
}

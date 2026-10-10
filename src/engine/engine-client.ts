import type {
  CreateConversationInput,
  EngineCallContext,
  EngineConversation,
  EngineMessagePage,
  EngineStreamEvent,
  EscalateInput,
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
}

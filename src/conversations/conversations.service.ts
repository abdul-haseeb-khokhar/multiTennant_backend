import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditAction, AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { resolvePage } from '../common/pagination/pagination';
import { currentRequestMeta } from '../common/request-context/request-store';
import { displayExternalId } from '../end-customers/customer-label';
import { EngineClient } from '../engine/engine-client';
import {
  EngineCallContext,
  EngineConversation,
  EngineError,
  EngineMessage,
} from '../engine/engine.types';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_MESSAGE_LENGTH } from '../widget/widget.constants';
import {
  QueryConversationDto,
  QueryConversationMessagesDto,
} from './dto/conversation.dto';

/** Messages per page of a conversation detail (the engine's own default is 20). */
const DEFAULT_MESSAGES_TAKE = 50;
/** Conversations released at most per disabled/deleted user (a safety bound, five full pages). */
const RELEASE_BATCH = 100;
const RELEASE_PAGES = 5;

export type ConversationOperation =
  'read' | 'claim' | 'release' | 'resolve' | 'reply';

/** Who the call is for: staff calls always carry the tenant of the verified token. */
export interface Actor {
  userId: string;
  tenantId: string;
  role: string;
}

/**
 * The staff side of conversations (Phase 4, C1 to C4): the queue and lists, claim, reply, release
 * and resolve. The conversations themselves live in the AI engine; this service reaches them ONLY
 * through `EngineClient`, always with the tenant of the verified staff token (never from the URL
 * or the body), and adds what the engine does not own: the customer record, the staff member's
 * name, the role rules and the audit trail.
 *
 * The rules are enforced HERE and again by the engine (which owns the atomic part):
 *  - claim: only an unassigned `active`/`escalated` conversation (409 CONVERSATION_ALREADY_CLAIMED
 *    otherwise; claiming what you already hold is a no-op, not an error);
 *  - reply, release, resolve: only the assignee of a `human_active` conversation, whatever their
 *    role (an owner or admin cannot reply into a colleague's conversation until transfer exists,
 *    J4) -> 409 CONVERSATION_NOT_ASSIGNED_TO_YOU;
 *  - a resolved conversation accepts nothing -> 409 CONVERSATION_RESOLVED.
 * Audit entries (claimed, released, resolved) never contain message text.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineClient,
    private readonly audit: AuditService,
  ) {}

  // ---- reads --------------------------------------------------------------------------------

  async list(actor: Actor, query: QueryConversationDto, customerId?: string) {
    const page = resolvePage(query);
    const result = await this.call(() =>
      this.engine.listConversations(this.ctx(actor), {
        status: query.status,
        assignedUserId:
          query.assignedTo === 'me' ? actor.userId : query.assignedTo,
        endCustomerId: customerId ?? query.customerId,
        sort: query.sort,
        skip: page.skip,
        take: page.take,
      }),
    );
    return {
      data: await this.views(actor.tenantId, result.data),
      total: result.total,
      skip: result.skip,
      take: result.take,
    };
  }

  /** Conversations of one customer of this tenant (the customer view). The customer must exist. */
  async listForCustomer(
    actor: Actor,
    customerId: string,
    query: QueryConversationDto,
  ) {
    const customer = await this.prisma.endCustomer.findFirst({
      where: { id: customerId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!customer) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.CUSTOMER_NOT_FOUND,
        `Customer ${customerId} not found`,
      );
    }
    return this.list(actor, query, customerId);
  }

  async counts(actor: Actor) {
    const [all, mine] = await this.call(() =>
      Promise.all([
        this.engine.countConversations(this.ctx(actor)),
        this.engine.countConversations(this.ctx(actor), {
          assignedUserId: actor.userId,
        }),
      ]),
    );
    return { counts: all, assignedToMe: mine.human_active };
  }

  async get(actor: Actor, id: string, query: QueryConversationMessagesDto) {
    const page = resolvePage({
      skip: query.skip,
      take: query.take ?? DEFAULT_MESSAGES_TAKE,
    });
    const { conversation, messages } = await this.call(() =>
      this.engine.getConversation(this.ctx(actor), id, page),
    );
    const [view] = await this.views(actor.tenantId, [conversation]);
    return {
      conversation: view,
      messages: {
        ...messages,
        data: await this.messageViews(
          actor.tenantId,
          conversation,
          messages.data,
        ),
      },
    };
  }

  // ---- commands -----------------------------------------------------------------------------

  async claim(actor: Actor, id: string, key?: string) {
    const current = await this.load(actor, id);
    this.assertNotResolved(current);
    if (
      current.status === 'human_active' &&
      current.assignedUserId === actor.userId
    ) {
      // A double click or a retry: it is already yours.
      return this.view(actor.tenantId, current);
    }
    if (current.status === 'human_active' || current.assignedUserId) {
      throw this.alreadyClaimed();
    }
    const claimed = await this.call(
      () =>
        this.engine.claimConversation(this.cmd(actor, key), id, {
          userId: actor.userId,
        }),
      'claim',
    );
    await this.record(actor, AuditAction.CONVERSATION_CLAIMED, id, {
      before: { status: current.status, assignedUserId: null },
      after: { status: claimed.status, assignedUserId: claimed.assignedUserId },
    });
    return this.view(actor.tenantId, claimed);
  }

  async release(
    actor: Actor,
    id: string,
    to: 'active' | 'escalated' = 'active',
    key?: string,
  ) {
    const current = await this.load(actor, id);
    this.assertHolder(current, actor);
    const released = await this.call(
      () =>
        this.engine.releaseConversation(this.cmd(actor, key), id, {
          userId: actor.userId,
          to,
        }),
      'release',
    );
    await this.record(actor, AuditAction.CONVERSATION_RELEASED, id, {
      before: {
        status: current.status,
        assignedUserId: current.assignedUserId,
      },
      after: {
        status: released.status,
        assignedUserId: released.assignedUserId,
        to,
      },
    });
    return this.view(actor.tenantId, released);
  }

  async resolve(actor: Actor, id: string, key?: string) {
    const current = await this.load(actor, id);
    this.assertHolder(current, actor);
    const resolved = await this.call(
      () =>
        this.engine.resolveConversation(this.cmd(actor, key), id, {
          userId: actor.userId,
        }),
      'resolve',
    );
    await this.record(actor, AuditAction.CONVERSATION_RESOLVED, id, {
      before: {
        status: current.status,
        assignedUserId: current.assignedUserId,
      },
      after: { status: resolved.status, resolvedBy: resolved.resolvedBy },
    });
    return this.view(actor.tenantId, resolved);
  }

  async reply(actor: Actor, id: string, content: string, key?: string) {
    if (content.trim().length === 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'A reply cannot be empty',
      );
    }
    if (Array.from(content).length > MAX_MESSAGE_LENGTH) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.MESSAGE_TOO_LONG,
        `A message can have at most ${MAX_MESSAGE_LENGTH} characters`,
      );
    }
    const current = await this.load(actor, id);
    this.assertHolder(current, actor);
    const message = await this.call(
      () =>
        this.engine.sendHumanMessage(this.cmd(actor, key), id, {
          userId: actor.userId,
          content,
        }),
      'reply',
    );
    const [view] = await this.messageViews(actor.tenantId, current, [message]);
    return view;
  }

  /**
   * Gives back every conversation a staff member holds, because they were disabled or deleted (they
   * can no longer release them, and the customers would wait for nobody). They go back to the queue
   * (`escalated`), each audited with who triggered it. Best effort: the user change has already
   * happened, so an engine that cannot be reached is logged and the rest is skipped, never raised.
   */
  async releaseHeldBy(
    actor: Actor,
    holderId: string,
    reason: 'assignee_disabled' | 'assignee_deleted',
  ): Promise<{ released: number; failed: number }> {
    let released = 0;
    let failed = 0;
    try {
      for (let pageNumber = 0; pageNumber < RELEASE_PAGES; pageNumber++) {
        const page = await this.engine.listConversations(this.ctx(actor), {
          status: ['human_active'],
          assignedUserId: holderId,
          skip: 0,
          take: RELEASE_BATCH,
        });
        if (page.data.length === 0) break;
        let progress = 0;
        for (const conversation of page.data) {
          try {
            await this.engine.releaseConversation(
              this.cmd(actor, `release-${reason}-${conversation.id}`),
              conversation.id,
              {
                userId: actor.userId,
                to: 'escalated',
                force: true,
                reason,
              },
            );
            await this.record(
              actor,
              AuditAction.CONVERSATION_RELEASED,
              conversation.id,
              {
                before: { status: 'human_active', assignedUserId: holderId },
                after: {
                  status: 'escalated',
                  assignedUserId: null,
                  to: 'escalated',
                  reason,
                },
              },
            );
            released += 1;
            progress += 1;
          } catch (error) {
            failed += 1;
            this.logEngineProblem(actor.tenantId, error);
          }
        }
        if (progress === 0) break; // nothing moved: do not loop on the same page
        if (page.data.length < RELEASE_BATCH) break;
      }
    } catch (error) {
      this.logEngineProblem(actor.tenantId, error);
    }
    return { released, failed };
  }

  // ---- internals ----------------------------------------------------------------------------

  /** Context of a read. */
  private ctx(actor: Actor): EngineCallContext {
    return {
      // The tenant of the verified token: the engine's only source of the tenant.
      tenantId: actor.tenantId,
      actingUserId: actor.userId,
      actingRole: actor.role,
      requestId: currentRequestMeta().requestId,
    };
  }

  /**
   * Context of a command. Every command carries an idempotency key, because the HTTP client retries
   * once when the connection breaks; the caller's own `Idempotency-Key` makes a retry from the
   * browser safe too.
   */
  private cmd(actor: Actor, key?: string): EngineCallContext {
    return {
      ...this.ctx(actor),
      idempotencyKey: key ? `staff:${actor.userId}:${key}` : randomUUID(),
    };
  }

  /** The conversation as it is now, for the checks before a command. */
  private async load(actor: Actor, id: string): Promise<EngineConversation> {
    const { conversation } = await this.call(() =>
      this.engine.getConversation(this.ctx(actor), id, { take: 1 }),
    );
    return conversation;
  }

  private assertNotResolved(c: EngineConversation) {
    if (c.status === 'resolved') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.CONVERSATION_RESOLVED,
        'This conversation has already ended',
      );
    }
  }

  /** Reply, release and resolve are for the staff member who holds the conversation, nobody else. */
  private assertHolder(c: EngineConversation, actor: Actor) {
    this.assertNotResolved(c);
    if (c.status !== 'human_active' || c.assignedUserId !== actor.userId) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        ErrorCode.CONVERSATION_NOT_ASSIGNED_TO_YOU,
        c.status === 'human_active'
          ? 'This conversation is handled by someone else'
          : 'Take the conversation first',
      );
    }
  }

  private alreadyClaimed() {
    return new ApiException(
      HttpStatus.CONFLICT,
      ErrorCode.CONVERSATION_ALREADY_CLAIMED,
      'Another team member has already taken this conversation',
    );
  }

  /** Runs an engine call and turns its failures into the backend's stable errors. */
  private async call<T>(
    fn: () => Promise<T>,
    operation: ConversationOperation = 'read',
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.mapEngineError(error, operation);
    }
  }

  private mapEngineError(error: unknown, operation: ConversationOperation) {
    if (error instanceof ApiException) return error;
    if (error instanceof EngineError) {
      if (error.kind === 'not_found') {
        return new ApiException(
          HttpStatus.NOT_FOUND,
          ErrorCode.CONVERSATION_NOT_FOUND,
          'Conversation not found',
        );
      }
      if (error.kind === 'conflict') {
        if (error.engineCode === 'CONVERSATION_RESOLVED') {
          return new ApiException(
            HttpStatus.CONFLICT,
            ErrorCode.CONVERSATION_RESOLVED,
            'This conversation has already ended',
          );
        }
        if (error.engineCode === 'CONVERSATION_NOT_ASSIGNED_TO_YOU') {
          return new ApiException(
            HttpStatus.CONFLICT,
            ErrorCode.CONVERSATION_NOT_ASSIGNED_TO_YOU,
            'This conversation is not assigned to you',
          );
        }
        // ALREADY_CLAIMED, or a 409 without a code we know: the operation tells what it must be.
        return operation === 'claim'
          ? this.alreadyClaimed()
          : new ApiException(
              HttpStatus.CONFLICT,
              ErrorCode.CONVERSATION_NOT_ASSIGNED_TO_YOU,
              'This conversation is not assigned to you',
            );
      }
    }
    this.logEngineProblem(undefined, error);
    return new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      ErrorCode.ENGINE_UNAVAILABLE,
      'The assistant is not available right now',
    );
  }

  private async record(
    actor: Actor,
    action: string,
    conversationId: string,
    states: { before: Record<string, unknown>; after: Record<string, unknown> },
  ) {
    try {
      await this.audit.record({
        tenantId: actor.tenantId,
        actor: { userId: actor.userId, role: actor.role },
        action,
        targetType: 'conversation',
        targetId: conversationId,
        before: states.before,
        after: states.after,
      });
    } catch (error) {
      // The engine already did it; a lost audit line is logged loudly rather than failing the call.
      this.logger.error({
        message: 'Could not write the audit entry of a conversation change',
        tenantId: actor.tenantId,
        action,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private logEngineProblem(tenantId: string | undefined, error: unknown) {
    this.logger.warn({
      message: 'The engine could not serve a staff conversation call',
      tenantId,
      kind: error instanceof EngineError ? error.kind : 'unexpected',
      status: error instanceof EngineError ? error.status : undefined,
    });
  }

  // ---- views --------------------------------------------------------------------------------

  private async view(tenantId: string, conversation: EngineConversation) {
    return (await this.views(tenantId, [conversation]))[0];
  }

  /** Conversations with the customer and the assignee's name, both looked up in THIS tenant. */
  private async views(tenantId: string, conversations: EngineConversation[]) {
    const customerIds = [
      ...new Set(
        conversations
          .map((c) => c.endCustomerId)
          .filter((id): id is string => !!id),
      ),
    ];
    const userIds = [
      ...new Set(
        conversations
          .map((c) => c.assignedUserId)
          .filter((id): id is string => !!id),
      ),
    ];
    const [customers, users] = await Promise.all([
      customerIds.length
        ? this.prisma.endCustomer.findMany({
            where: { tenantId, id: { in: customerIds } },
            select: { id: true, name: true, externalId: true },
          })
        : [],
      userIds.length
        ? this.prisma.tenantUser.findMany({
            where: { tenantId, id: { in: userIds } },
            select: { id: true, name: true, email: true },
          })
        : [],
    ]);
    const customerById = new Map(customers.map((c) => [c.id, c]));
    const userById = new Map(users.map((u) => [u.id, u]));
    return conversations.map((c) => {
      const customer = c.endCustomerId
        ? customerById.get(c.endCustomerId)
        : undefined;
      const assignee = c.assignedUserId
        ? userById.get(c.assignedUserId)
        : undefined;
      return {
        id: c.id,
        endCustomerId: c.endCustomerId,
        customer: {
          name: customer?.name ?? null,
          externalId: customer ? displayExternalId(customer.externalId) : null,
          channel: c.channel,
        },
        channel: c.channel,
        status: c.status,
        assignedUserId: c.assignedUserId,
        assignedUserName: assignee ? (assignee.name ?? assignee.email) : null,
        escalatedAt: c.escalatedAt,
        escalationReason: c.escalationReason,
        summary: c.summary,
        lastMessageAt: c.lastMessageAt,
        resolvedAt: c.resolvedAt,
        resolvedBy: c.resolvedBy,
        createdAt: c.createdAt,
      };
    });
  }

  /** Messages without the engine's internal ones (tool calls), with the author's name. */
  private async messageViews(
    tenantId: string,
    conversation: EngineConversation,
    messages: EngineMessage[],
  ) {
    const visible = messages.filter((m) => m.authorType !== 'tool');
    const authorIds = [
      ...new Set(
        visible.map((m) => m.authorUserId).filter((id): id is string => !!id),
      ),
    ];
    const [authors, customer] = await Promise.all([
      authorIds.length
        ? this.prisma.tenantUser.findMany({
            where: { tenantId, id: { in: authorIds } },
            select: { id: true, name: true, email: true },
          })
        : [],
      conversation.endCustomerId
        ? this.prisma.endCustomer.findFirst({
            where: { tenantId, id: conversation.endCustomerId },
            select: { name: true },
          })
        : null,
    ]);
    const authorById = new Map(authors.map((a) => [a.id, a]));
    return visible.map((m) => {
      const author = m.authorUserId
        ? authorById.get(m.authorUserId)
        : undefined;
      return {
        id: m.id,
        authorType: m.authorType,
        authorUserId: m.authorUserId ?? null,
        authorName:
          m.authorType === 'human'
            ? author
              ? (author.name ?? author.email)
              : null
            : m.authorType === 'customer'
              ? (customer?.name ?? null)
              : null,
        content: m.content,
        contentKey: m.contentKey ?? null,
        createdAt: m.createdAt,
      };
    });
  }
}

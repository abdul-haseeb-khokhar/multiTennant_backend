import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { GatewayConversation } from '@prisma/client';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { looksLikeWidgetKey } from '../api-keys/api-key.util';
import { EntitlementsService } from '../billing/entitlements/entitlements.service';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { normalizeOrigin } from '../common/validation/origin';
import { EngineClient } from '../engine/engine-client';
import { EngineError } from '../engine/engine.types';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { CreateWidgetSessionDto } from './dto/create-widget-session.dto';
import { WidgetRateLimitService } from './widget-rate-limit.service';
import { WidgetTokenService } from './widget-token.service';
import { FallbackReason, WidgetTextService } from './widget-text.service';
import {
  WIDGET_CHANNEL,
  WIDGET_EXTERNAL_ID_PREFIX,
  WIDGET_TOKEN_TTL_SECONDS,
} from './widget.constants';

export interface SessionRequest {
  /** The raw `Origin` header (undefined for a non-browser caller, which is refused). */
  origin: string | undefined;
  ip: string;
  requestId?: string;
}

/** Whether a tenant's plan and standing allow the chat at all (suspended, closed, no chat in the plan). */
export interface ChatGate {
  open: boolean;
  poweredBy: boolean;
}

/**
 * Starts and refreshes widget sessions (architecture 5.2): validates the key together with the
 * Origin, decides whether this tenant may chat right now, finds or creates the visitor's end
 * customer and conversation, and issues the short-lived widget token.
 *
 * The end customer never gets an error where a message can help (I5, D7): a suspended tenant, a
 * plan without chat or an engine that is down answer 200 with `status: "blocked"` and a fallback
 * text; a tenant at its conversation limit gets a working session (`status: "limited"`) whose
 * messages go to a human.
 */
@Injectable()
export class WidgetSessionsService {
  private readonly logger = new Logger(WidgetSessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly apiKeys: ApiKeysService,
    private readonly entitlements: EntitlementsService,
    private readonly engine: EngineClient,
    private readonly usage: UsageService,
    private readonly tokens: WidgetTokenService,
    private readonly text: WidgetTextService,
    private readonly rateLimits: WidgetRateLimitService,
  ) {}

  /**
   * `onOriginAccepted` runs as soon as the key and the origin matched, before anything else can
   * fail, so the controller can let that origin read the response (CORS) even for a blocked or
   * rate-limited answer.
   */
  async start(
    dto: CreateWidgetSessionDto,
    request: SessionRequest,
    onOriginAccepted: (origin: string) => void,
  ) {
    const limits = this.rateLimits.config;
    // Cheapest check first: one caller must not be able to spend our database lookups.
    this.rateLimits.enforce([
      { scope: 'session-ip', id: request.ip, limit: limits.sessionPerIp },
    ]);

    const key = looksLikeWidgetKey(dto.widgetKey)
      ? await this.apiKeys.resolveWidgetKey(dto.widgetKey)
      : null;
    if (!key) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.WIDGET_KEY_INVALID,
        'The widget key is not valid',
      );
    }
    const origin = normalizeOrigin(request.origin);
    if (!origin || !this.apiKeys.originAllowed(key, origin)) {
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.ORIGIN_NOT_ALLOWED,
        'This origin is not allowed for the widget key',
      );
    }
    onOriginAccepted(origin);

    const tenantId = key.tenantId;
    this.rateLimits.enforce([
      { scope: 'session-key', id: key.id, limit: limits.sessionPerKey },
      {
        scope: 'session-visitor',
        id: `${tenantId}:${dto.visitorId}`,
        limit: limits.sessionPerVisitor,
      },
    ]);
    this.apiKeys.touch(tenantId, key.id);

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, defaultLocale: true },
    });
    if (!tenant) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.WIDGET_KEY_INVALID,
        'The widget key is not valid',
      );
    }
    const locale = this.text.resolveLocale(dto.locale, tenant.defaultLocale);
    const defaultLocale = this.text.resolveLocale(tenant.defaultLocale);

    const gate = await this.chatGate(tenantId, tenant.status);
    if (!gate.open) {
      return this.blocked(
        tenantId,
        'service_unavailable',
        locale,
        defaultLocale,
        gate.poweredBy,
      );
    }

    const endCustomer = await this.ensureEndCustomer(
      tenantId,
      dto.visitorId,
      locale,
    );
    const ctx = { tenantId, requestId: request.requestId };

    const outcome = await this.findOrCreateConversation(
      ctx,
      endCustomer.id,
      key.id,
      locale,
    );
    if (outcome === 'engine_unavailable') {
      return this.blocked(
        tenantId,
        'ai_unavailable',
        locale,
        defaultLocale,
        gate.poweredBy,
      );
    }

    const { token, expiresAt } = this.tokens.sign({
      tenantId,
      endCustomerId: endCustomer.id,
      conversationId: outcome.conversationId,
      keyId: key.id,
      locale,
    });
    const greeting = await this.text.greeting(tenantId, locale);
    return {
      status: outcome.aiBlocked ? 'limited' : 'ready',
      token,
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: WIDGET_TOKEN_TTL_SECONDS,
      conversationId: outcome.conversationId,
      locale,
      defaultLocale,
      greeting: greeting.greeting,
      personaName: greeting.personaName,
      poweredBy: gate.poweredBy,
      ...(outcome.aiBlocked && {
        fallback: await this.text.fallback(tenantId, 'limit_reached', locale),
      }),
    };
  }

  /**
   * Whether the tenant may chat: not suspended or closed (the tenant mirror is read fresh, the
   * subscription may be a few seconds cached), the plan includes chat, and a `past_due` tenant
   * still answers its customers (I5).
   */
  async chatGate(tenantId: string, tenantStatus?: string): Promise<ChatGate> {
    const status =
      tenantStatus ??
      (
        await this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { status: true },
        })
      )?.status;
    const subscription = await this.entitlements.forTenant(tenantId);
    const poweredBy = subscription?.entitlements.poweredByLabel ?? true;
    if (!status || status === 'suspended' || status === 'closed') {
      return { open: false, poweredBy };
    }
    const decision = await this.entitlements.check(
      tenantId,
      'channel:chat',
      1,
      { allowPastDue: true },
    );
    return { open: decision.allowed, poweredBy };
  }

  // -------------------------------------------------------------------------------------------

  private async blocked(
    tenantId: string,
    reason: FallbackReason,
    locale: string,
    defaultLocale: string,
    poweredBy: boolean,
  ) {
    return {
      status: 'blocked' as const,
      locale,
      defaultLocale,
      poweredBy,
      fallback: await this.text.fallback(tenantId, reason, locale),
    };
  }

  /** `web_<visitorId>` (B4). Two simultaneous first visits create one row. */
  private async ensureEndCustomer(
    tenantId: string,
    visitorId: string,
    locale: string,
  ) {
    const externalId = `${WIDGET_EXTERNAL_ID_PREFIX}${visitorId}`;
    try {
      return await this.prisma.endCustomer.upsert({
        where: { tenantId_externalId: { tenantId, externalId } },
        update: {},
        create: { tenantId, externalId, locale },
        select: { id: true },
      });
    } catch (error) {
      if (!isPrismaError(error, 'P2002')) throw error;
      // The other request won the insert; its row is there now.
      return this.prisma.endCustomer.findFirstOrThrow({
        where: { tenantId, externalId },
        select: { id: true },
      });
    }
  }

  /**
   * The visitor's open conversation, or a new one. A conversation counts once: it is counted when
   * it is created, never when a returning visitor resumes it.
   */
  private async findOrCreateConversation(
    ctx: { tenantId: string; requestId?: string },
    endCustomerId: string,
    keyId: string,
    locale: string,
  ): Promise<
    { conversationId: string; aiBlocked: boolean } | 'engine_unavailable'
  > {
    const { tenantId } = ctx;
    // ONE read decides both "resume?" and the engine Idempotency-Key: the visitor's latest
    // conversation row, open or closed. Parallel first visits see the same snapshot (no row yet,
    // or the same closed row) and so send the same key; the engine hands all of them the same
    // conversation and the unique index lets one row win. (A count taken in a second read could
    // already include the winner's row and start a second conversation.)
    const latest = await this.prisma.gatewayConversation.findFirst({
      where: { tenantId, endCustomerId, channel: WIDGET_CHANNEL },
      orderBy: { createdAt: 'desc' },
    });
    if (latest && !latest.closedAt && (await this.stillOpen(ctx, latest))) {
      return {
        conversationId: latest.conversationId,
        aiBlocked: latest.aiBlocked,
      };
    }
    const previous = latest?.conversationId ?? 'first';
    const limit = await this.entitlements.check(tenantId, 'conversations', 1);
    const aiBlocked = !limit.allowed;

    let created;
    try {
      created = await this.engine.createConversation(
        {
          ...ctx,
          idempotencyKey: `widget-conversation:${endCustomerId}:${previous}`,
        },
        { channel: WIDGET_CHANNEL, endCustomerId, locale },
      );
    } catch (error) {
      if (error instanceof EngineError && error.isOutage) {
        this.logger.warn({
          message: 'Engine unavailable while creating a conversation',
          tenantId,
          kind: error.kind,
        });
        return 'engine_unavailable';
      }
      throw this.engineFailure(error);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.gatewayConversation.create({
          data: {
            tenantId,
            conversationId: created.id,
            endCustomerId,
            channel: WIDGET_CHANNEL,
            apiKeyId: keyId,
            aiBlocked,
          },
        });
        await this.usage.recordConversation(tenantId, created.id, tx);
      });
    } catch (error) {
      if (!isPrismaError(error, 'P2002')) throw error;
      // A simultaneous request stored the same engine conversation first; it counted it.
    }
    const stored = await this.prisma.gatewayConversation.findFirstOrThrow({
      where: { tenantId, conversationId: created.id },
    });
    return {
      conversationId: stored.conversationId,
      aiBlocked: stored.aiBlocked,
    };
  }

  /**
   * True when the stored conversation can be resumed. A resolved or vanished conversation is
   * closed here so the visitor gets a fresh one; an engine that cannot answer does not stop a
   * returning visitor from resuming (the message call has its own fallback).
   */
  private async stillOpen(
    ctx: { tenantId: string; requestId?: string },
    row: GatewayConversation,
  ): Promise<boolean> {
    try {
      const { conversation } = await this.engine.getConversation(
        ctx,
        row.conversationId,
        { take: 1 },
      );
      if (conversation.status !== 'resolved') return true;
    } catch (error) {
      if (error instanceof EngineError && error.isOutage) return true;
      if (!(error instanceof EngineError && error.kind === 'not_found')) {
        throw this.engineFailure(error);
      }
    }
    await this.prisma.gatewayConversation.updateMany({
      where: { id: row.id, tenantId: ctx.tenantId },
      data: { closedAt: new Date() },
    });
    return false;
  }

  private engineFailure(error: unknown) {
    if (error instanceof EngineError) {
      this.logger.error({
        message: 'The engine refused a request',
        kind: error.kind,
        status: error.status,
        engineCode: error.engineCode,
      });
    }
    return new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      ErrorCode.ENGINE_UNAVAILABLE,
      'The assistant is not available right now',
    );
  }
}

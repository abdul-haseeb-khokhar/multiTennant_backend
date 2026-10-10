import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Clock } from '../billing/clock';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;
type UsageKind = 'conversation' | 'message';

export interface MessageUsage {
  /** The engine's id of the message (customer message or assistant reply). */
  messageId: string;
  tokensIn?: number;
  tokensOut?: number;
}

/** A UTC calendar date as a `Date` at 00:00 (the value type of a `@db.Date` column). */
export function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * The only writer of `usage_daily` (B6, I5). Each conversation and each message is counted ONCE,
 * however often it is reported: a row in `usage_events` (unique per tenant, kind and engine id)
 * decides, in the same transaction as the counter increment. So retries, a replayed stream and the
 * engine's later `usage.recorded` event for the same message cannot double count.
 */
@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Counts a conversation the first time it is reported. True when this call counted it. */
  recordConversation(
    tenantId: string,
    conversationId: string,
    tx?: Tx,
  ): Promise<boolean> {
    return this.count(
      tenantId,
      'conversation',
      conversationId,
      { conversations: 1 },
      tx,
    );
  }

  /** Counts a message (and its tokens) the first time it is reported. True when this call counted it. */
  recordMessage(
    tenantId: string,
    usage: MessageUsage,
    tx?: Tx,
  ): Promise<boolean> {
    return this.count(
      tenantId,
      'message',
      usage.messageId,
      {
        messages: 1,
        tokensIn: nonNegative(usage.tokensIn),
        tokensOut: nonNegative(usage.tokensOut),
      },
      tx,
    );
  }

  // -------------------------------------------------------------------------------------------

  private async count(
    tenantId: string,
    kind: UsageKind,
    refId: string,
    delta: {
      conversations?: number;
      messages?: number;
      tokensIn?: number;
      tokensOut?: number;
    },
    tx?: Tx,
  ): Promise<boolean> {
    const run = async (client: Tx) => {
      const day = utcDay(this.clock.now());
      const inserted = await client.usageEvent.createMany({
        data: [{ tenantId, kind, refId, day }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) return false;
      await this.increment(client, tenantId, day, delta);
      return true;
    };
    return tx ? run(tx) : this.prisma.$transaction(run);
  }

  /**
   * One atomic statement: insert the day's row or add to it. (The Prisma client's `upsert` can fail
   * on a first-event race, and inside a transaction a failed statement poisons the transaction.)
   */
  private async increment(
    client: Tx,
    tenantId: string,
    day: Date,
    delta: {
      conversations?: number;
      messages?: number;
      tokensIn?: number;
      tokensOut?: number;
    },
  ) {
    const date = day.toISOString().slice(0, 10);
    const conversations = delta.conversations ?? 0;
    const messages = delta.messages ?? 0;
    const tokensIn = delta.tokensIn ?? 0;
    const tokensOut = delta.tokensOut ?? 0;
    await client.$executeRaw`
      INSERT INTO "tenant_core"."usage_daily"
        ("tenant_id", "day", "conversations", "messages", "tokens_in", "tokens_out", "updated_at")
      VALUES
        (${tenantId}, to_date(${date}, 'YYYY-MM-DD'), ${conversations}, ${messages}, ${tokensIn}, ${tokensOut}, now())
      ON CONFLICT ("tenant_id", "day") DO UPDATE SET
        "conversations" = "usage_daily"."conversations" + EXCLUDED."conversations",
        "messages" = "usage_daily"."messages" + EXCLUDED."messages",
        "tokens_in" = "usage_daily"."tokens_in" + EXCLUDED."tokens_in",
        "tokens_out" = "usage_daily"."tokens_out" + EXCLUDED."tokens_out",
        "updated_at" = now()`;
  }
}

function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.trunc(value), 2_000_000_000)
    : 0;
}

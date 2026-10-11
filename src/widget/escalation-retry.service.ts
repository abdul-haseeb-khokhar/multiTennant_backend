import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../billing/clock';
import { EngineClient } from '../engine/engine-client';
import { EngineError, EscalationReason } from '../engine/engine.types';
import { PrismaService } from '../prisma/prisma.service';

/** Arbitrary constant: the Postgres advisory lock key of the escalation retry sweep. */
export const ESCALATION_RETRY_LOCK_KEY = 7_270_002;
/** After this many failed deliveries the retries stop and the flag stays set (a human must look). */
export const ESCALATION_MAX_ATTEMPTS = 10;
const BATCH = 50;
const FIRST_RUN_DELAY_MS = 20_000;
const DEFAULT_INTERVAL_SECONDS = 60;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const ENGINE_TIMEOUT_MS = 5000;
const JOB_TIMEOUT_MS = 5 * 60_000;

/** Wait before attempt number `attempts + 1`: 30 s, 1 min, 2 min, ... up to 30 min. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

export interface RetryResult {
  attempted: number;
  delivered: number;
  failed: number;
  skipped: boolean;
}

/**
 * Delivers the escalations the gateway could not hand to the engine (known issue 12): when a
 * customer's message hit a plan limit or a failing engine, the gateway marked the conversation
 * `escalation_pending` and moved on (the customer was told a colleague will reply). This job tells
 * the engine later, with the same idempotency key as the original attempt, so a delivery that had
 * in fact gone through is not repeated.
 *
 * Bounded: a conversation is tried with a growing wait (30 s doubling to 30 min) at most
 * `ESCALATION_MAX_ATTEMPTS` times; then the flag stays set and the row is left alone. A
 * conversation that the engine no longer knows or has resolved needs no escalation and is cleared.
 * Every instance runs the timer; a Postgres advisory lock lets one sweep at a time.
 * Off in tests and with `ESCALATION_RETRY_JOB=off`.
 */
@Injectable()
export class EscalationRetryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(EscalationRetryService.name);
  private first?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EngineClient,
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {}

  onApplicationBootstrap() {
    if (
      this.config.get('ESCALATION_RETRY_JOB') === 'off' ||
      this.config.get('NODE_ENV') === 'test'
    ) {
      return;
    }
    const seconds = Number(
      this.config.get('ESCALATION_RETRY_INTERVAL_SECONDS') ??
        DEFAULT_INTERVAL_SECONDS,
    );
    this.first = setTimeout(() => void this.sweep(), FIRST_RUN_DELAY_MS);
    this.timer = setInterval(() => void this.sweep(), seconds * 1000);
    this.first.unref();
    this.timer.unref();
  }

  onModuleDestroy() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  /** One timer tick. Never throws. */
  private async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.run();
      if (result.attempted > 0) {
        this.logger.log(
          `Escalation retry: ${result.delivered} delivered, ${result.failed} failed`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Escalation retry failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** One sweep over the pending escalations that are due (public for tests and manual runs). */
  async run(): Promise<RetryResult> {
    return this.prisma.$transaction(
      async (lockTx) => {
        const [{ locked }] = await lockTx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${ESCALATION_RETRY_LOCK_KEY}::bigint) AS locked`;
        if (!locked) {
          return { attempted: 0, delivered: 0, failed: 0, skipped: true };
        }
        const now = this.clock.now();
        const candidates = await this.prisma.gatewayConversation.findMany({
          where: {
            escalationPending: true,
            closedAt: null,
            escalationAttempts: { lt: ESCALATION_MAX_ATTEMPTS },
            escalationReason: { not: null },
          },
          orderBy: { createdAt: 'asc' },
          take: BATCH * 4,
        });
        const due = candidates
          .filter(
            (row) =>
              !row.escalationLastAttemptAt ||
              now.getTime() - row.escalationLastAttemptAt.getTime() >=
                backoffMs(row.escalationAttempts),
          )
          .slice(0, BATCH);

        let delivered = 0;
        let failed = 0;
        for (const row of due) {
          const outcome = await this.deliver(row);
          await this.prisma.gatewayConversation.updateMany({
            // Scoped to the row's own tenant, and only while it is still pending.
            where: {
              id: row.id,
              tenantId: row.tenantId,
              escalationPending: true,
            },
            data: {
              escalationPending: outcome === 'retry',
              escalationAttempts: { increment: 1 },
              escalationLastAttemptAt: now,
            },
          });
          if (outcome === 'retry') {
            failed += 1;
            if (row.escalationAttempts + 1 >= ESCALATION_MAX_ATTEMPTS) {
              this.logger.warn({
                message:
                  'Giving up delivering an escalation to the engine; the conversation stays flagged',
                tenantId: row.tenantId,
                conversationId: row.conversationId,
              });
            }
          } else {
            delivered += 1;
          }
        }
        return { attempted: due.length, delivered, failed, skipped: false };
      },
      { timeout: JOB_TIMEOUT_MS, maxWait: 10_000 },
    );
  }

  /** `done`: delivered, or nothing left to deliver. `retry`: try again later. */
  private async deliver(row: {
    tenantId: string;
    conversationId: string;
    escalationReason: string | null;
  }): Promise<'done' | 'retry'> {
    try {
      await this.engine.escalate(
        {
          // The tenant of the stored row, never anything from a request.
          tenantId: row.tenantId,
          // The gateway's original key: a delivery that did go through is replayed, not repeated.
          idempotencyKey: `escalate:${row.conversationId}:${row.escalationReason}`,
          signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
        },
        row.conversationId,
        { reason: row.escalationReason as EscalationReason },
      );
      return 'done';
    } catch (error) {
      if (
        error instanceof EngineError &&
        (error.kind === 'not_found' || error.kind === 'conflict')
      ) {
        return 'done'; // gone or already resolved: there is nothing to escalate
      }
      this.logger.warn({
        message: 'Could not deliver an escalation to the engine',
        tenantId: row.tenantId,
        kind: error instanceof EngineError ? error.kind : 'unexpected',
      });
      return 'retry';
    }
  }
}

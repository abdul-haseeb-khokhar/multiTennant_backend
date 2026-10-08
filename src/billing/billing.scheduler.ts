import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubscriptionService } from './subscriptions/subscription.service';

const FIRST_RUN_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MINUTES = 60;

/**
 * The time-based transition job (I3, I8): applies "Starter ended", "paid period ended unpaid" and
 * "grace expired" to every subscription that is due. It sweeps shortly after boot and then every
 * `BILLING_JOB_INTERVAL_MINUTES` (default 60, so at least daily even when instances restart
 * often). Every instance runs the timer; `processDueTransitions` takes a Postgres advisory lock so
 * only one sweeps at a time, and each transition is idempotent anyway.
 *
 * It is a convenience, not the source of correctness: `SubscriptionService.getEffective` applies
 * due transitions on read, so a late or dead job never grants a plan that has ended.
 *
 * Off in tests (`NODE_ENV=test`) and with `BILLING_JOB=off`.
 */
@Injectable()
export class BillingScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(BillingScheduler.name);
  private first?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  onApplicationBootstrap() {
    if (
      this.config.get('BILLING_JOB') === 'off' ||
      this.config.get('NODE_ENV') === 'test'
    ) {
      return;
    }
    const minutes = Number(
      this.config.get('BILLING_JOB_INTERVAL_MINUTES') ??
        DEFAULT_INTERVAL_MINUTES,
    );
    this.first = setTimeout(() => void this.run(), FIRST_RUN_DELAY_MS);
    this.timer = setInterval(() => void this.run(), minutes * 60_000);
    this.first.unref();
    this.timer.unref();
  }

  onModuleDestroy() {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  /** One sweep. Never throws: a failing sweep is logged and retried at the next tick. */
  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.subscriptions.processDueTransitions();
      if (result.processed > 0) {
        this.logger.log(
          `Applied due transitions to ${result.processed} subscriptions`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Transition job failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}

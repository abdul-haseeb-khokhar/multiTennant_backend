import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailFailureReason } from './mailer';

/** After this many deliveries in a row failed, the mail status turns `degraded`. */
export const MAIL_DEGRADED_AFTER = 3;

export interface MailHealthSnapshot {
  provider: string;
  /** `ok`; `degraded` after repeated failures in a row (a warning, readiness stays up); `not_configured` for the console mailer. */
  status: 'ok' | 'degraded' | 'not_configured';
  consecutiveFailures: number;
  lastFailureReason: MailFailureReason | null;
  lastFailureAt: string | null;
}

/**
 * Watches delivery outcomes in this process so a provider that keeps failing (an exhausted free
 * quota, a revoked key, an unverified domain) shows up in `GET /health/ready` and in the log
 * instead of only as silent invites. Per instance and in memory; a success resets it.
 */
@Injectable()
export class MailHealth {
  private readonly logger = new Logger('MailHealth');
  private consecutive = 0;
  private lastReason: MailFailureReason | null = null;
  private lastAt: Date | null = null;

  constructor(private readonly config: ConfigService) {}

  success() {
    if (this.consecutive >= MAIL_DEGRADED_AFTER) {
      this.logger.log('Mail delivery recovered');
    }
    this.consecutive = 0;
  }

  failure(reason: MailFailureReason) {
    this.consecutive += 1;
    this.lastReason = reason;
    this.lastAt = new Date();
    if (this.consecutive === MAIL_DEGRADED_AFTER) {
      this.logger.warn({
        message: 'Mail delivery is degraded: repeated failures',
        consecutiveFailures: this.consecutive,
        reason,
      });
    }
  }

  snapshot(): MailHealthSnapshot {
    const provider = this.config.get<string>('MAIL_PROVIDER') ?? 'console';
    return {
      provider,
      status:
        provider === 'console'
          ? 'not_configured'
          : this.consecutive >= MAIL_DEGRADED_AFTER
            ? 'degraded'
            : 'ok',
      consecutiveFailures: this.consecutive,
      lastFailureReason: this.lastReason,
      lastFailureAt: this.lastAt?.toISOString() ?? null,
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailHealth } from './mail-health';
import {
  MailDelivery,
  MailDeliveryError,
  MailFailureReason,
  MailParams,
  MailTemplate,
  Mailer,
} from './mailer';

const DEV_FRONTEND_URL = 'http://localhost:5173';

/** Frontend page that receives each kind of link. The single-use ones carry a token the page POSTs back to the API. */
const LINK_PATH: Record<MailTemplate, { path: string; token: boolean }> = {
  'staff-invite': { path: '/accept-invite', token: true },
  'password-reset': { path: '/reset-password', token: true },
  'email-verification': { path: '/verify-email', token: true },
  'billing-period-ending': { path: '/billing', token: false },
  'billing-grace-started': { path: '/billing', token: false },
  'billing-downgraded': { path: '/billing', token: false },
  // Goes to the platform admins: the console's list of upgrade requests (J5).
  'upgrade-request': { path: '/admin/upgrade-requests', token: false },
};

export interface MailRequest {
  to: string;
  template: MailTemplate;
  /** The single-use token of the three link emails; the billing emails link to a page and have none. */
  token?: string;
  locale: string;
  params?: MailParams;
}

/**
 * What happened to a message, as the API reports it to the caller (H3): `sent` = handed to the
 * mail provider, `failed` = the provider could not take it (the invite, reset or verification still
 * exists), `skipped` = nothing was sent because the development console mailer is active.
 */
export type DeliveryStatus = MailDelivery | 'failed';

export interface MailResult {
  delivery: DeliveryStatus;
  /** Only with `MAIL_MODE=link` (development; refused in production). */
  link?: string;
}

/**
 * Builds the emailed links and hands them to the `Mailer`. A delivery failure NEVER throws: the
 * flow that asked for the email already stored its invite, reset or verification record, so the
 * caller gets `delivery: 'failed'` and can offer a retry. Failures are logged by template and
 * reason only (no recipient, no link) and counted by `MailHealth`. With `MAIL_MODE=link`
 * (development only, refused in production at startup) the link is also returned to the caller.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly mailer: Mailer,
    private readonly config: ConfigService,
    private readonly health: MailHealth,
  ) {}

  /** Sends and waits for the provider's answer. */
  async sendNow(request: MailRequest): Promise<MailResult> {
    const link = this.buildLink(request);
    const delivery = await this.deliver(request, link);
    return { delivery, ...this.exposed(link) };
  }

  /**
   * Sends in the background and returns at once, so the response time does not depend on the
   * mail provider and says nothing about it (the password-reset request must not reveal whether an
   * account exists, so it cannot report a delivery either).
   */
  queue(request: MailRequest): { link?: string } {
    const link = this.buildLink(request);
    void this.deliver(request, link);
    return this.exposed(link);
  }

  private async deliver(
    request: MailRequest,
    link: string,
  ): Promise<DeliveryStatus> {
    try {
      const delivery = await this.mailer.send({
        to: request.to,
        template: request.template,
        locale: request.locale,
        link,
        params: request.params,
      });
      this.health.success();
      return delivery === 'skipped' ? 'skipped' : 'sent';
    } catch (error) {
      this.recordFailure(request.template, error);
      return 'failed';
    }
  }

  private buildLink(request: MailRequest) {
    const base = (
      this.config.get<string>('FRONTEND_URL') ?? DEV_FRONTEND_URL
    ).replace(/\/+$/, '');
    const target = LINK_PATH[request.template];
    return target.token
      ? `${base}${target.path}?token=${encodeURIComponent(request.token ?? '')}`
      : `${base}${target.path}`;
  }

  private exposed(link: string) {
    return this.config.get('MAIL_MODE') === 'link' ? { link } : {};
  }

  private recordFailure(template: MailTemplate, error: unknown) {
    const known = error instanceof MailDeliveryError;
    const reason: MailFailureReason = known ? error.reason : 'unknown';
    this.health.failure(reason);
    // The template and the reason only: neither the recipient, the link nor the provider's own
    // error text (which can quote an address) goes into the log.
    this.logger.error({
      message: 'email delivery failed',
      template,
      reason,
      ...(known && error.status !== undefined && { status: error.status }),
    });
  }
}

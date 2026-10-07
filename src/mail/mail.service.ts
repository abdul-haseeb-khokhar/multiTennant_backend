import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { MailTemplate, Mailer } from './mailer';

const DEV_FRONTEND_URL = 'http://localhost:5173';

/** Frontend page that receives each kind of link (the page POSTs the token back to the API). */
const LINK_PATH: Record<MailTemplate, string> = {
  'staff-invite': '/accept-invite',
  'password-reset': '/reset-password',
  'email-verification': '/verify-email',
};

export interface MailRequest {
  to: string;
  template: MailTemplate;
  token: string;
  locale: string;
}

/**
 * Builds the emailed links and hands them to the `Mailer`. With `MAIL_MODE=link` (development
 * only, refused in production at startup) the link is also returned to the caller so it can go
 * into the API response; otherwise `link` is undefined and the response never contains it.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly mailer: Mailer,
    private readonly config: ConfigService,
  ) {}

  /** Sends and waits; a delivery failure becomes 503 `MAIL_DELIVERY_FAILED`. */
  async sendNow(request: MailRequest): Promise<{ link?: string }> {
    const link = this.buildLink(request);
    try {
      await this.mailer.send({
        to: request.to,
        template: request.template,
        locale: request.locale,
        link,
      });
    } catch (error) {
      this.logFailure(request.template, error);
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        ErrorCode.MAIL_DELIVERY_FAILED,
        'The email could not be sent',
      );
    }
    return this.exposed(link);
  }

  /**
   * Sends in the background and returns at once, so the response time does not depend on the
   * mail provider (the password-reset request must not reveal whether an account exists).
   */
  queue(request: MailRequest): { link?: string } {
    const link = this.buildLink(request);
    // A provider that throws before returning a promise must not break the caller either.
    let delivery: Promise<void>;
    try {
      delivery = this.mailer.send({
        to: request.to,
        template: request.template,
        locale: request.locale,
        link,
      });
    } catch (error) {
      delivery = Promise.reject(error);
    }
    delivery.catch((error: unknown) =>
      this.logFailure(request.template, error),
    );
    return this.exposed(link);
  }

  private buildLink(request: MailRequest) {
    const base = (
      this.config.get<string>('FRONTEND_URL') ?? DEV_FRONTEND_URL
    ).replace(/\/+$/, '');
    return `${base}${LINK_PATH[request.template]}?token=${encodeURIComponent(request.token)}`;
  }

  private exposed(link: string) {
    return this.config.get('MAIL_MODE') === 'link' ? { link } : {};
  }

  private logFailure(template: MailTemplate, error: unknown) {
    // The template only: neither the recipient nor the link goes into the log.
    this.logger.error({
      message: 'email delivery failed',
      template,
      error: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

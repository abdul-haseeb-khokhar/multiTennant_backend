import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { MailRenderer } from './mail-renderer';
import {
  MailDelivery,
  MailDeliveryError,
  MailFailureReason,
  MailMessage,
  Mailer,
} from './mailer';

export interface ResendMailerOptions {
  /** A send-only key from the Resend dashboard. A secret: never logged. */
  apiKey: string;
  /** Sender address; `onboarding@resend.dev` in test mode, an address on the verified domain later. */
  from: string;
  /** Display name next to the sender address (the product name). */
  fromName: string;
  /**
   * Test stage: every message goes to this one address (the Resend account's own), with the
   * intended recipient named in the subject and at the top of the body.
   */
  redirectTo?: string;
  /** Per attempt, milliseconds. */
  timeoutMs: number;
  /** Base URL of the Resend API (overridden by the tests). */
  apiUrl: string;
  /** Pause before the single retry, milliseconds. */
  retryDelayMs: number;
}

export const RESEND_DEFAULTS = {
  apiUrl: 'https://api.resend.com',
  timeoutMs: 5000,
  retryDelayMs: 300,
} as const;

/**
 * Sends through Resend's HTTP API (`POST /emails`, Bearer key, JSON). Failure handling (H3):
 *  - one bounded attempt of `timeoutMs`, and exactly ONE retry, only when the connection broke,
 *    timed out or Resend answered 5xx. Every other answer (400, 401, 403, 429) is final: sending
 *    again cannot change it, and a 429 must not make a quota problem worse. The retry reuses the
 *    same `Idempotency-Key`, so a message whose first attempt did arrive is not delivered twice.
 *  - failures throw `MailDeliveryError` with a stable `reason`. Resend's own error text is never
 *    kept or logged: its test-mode refusal quotes the account's email address.
 *  - nothing here logs a recipient, a link or the key.
 */
export class ResendMailer extends Mailer {
  private readonly logger = new Logger('ResendMailer');

  constructor(
    private readonly options: ResendMailerOptions,
    private readonly renderer: MailRenderer,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    super();
  }

  async send(message: MailMessage): Promise<MailDelivery> {
    const { redirectTo } = this.options;
    const rendered = this.renderer.render(message, {
      product: this.options.fromName,
      redirectedFrom: redirectTo ? message.to : undefined,
    });
    const body = JSON.stringify({
      from: `"${this.options.fromName}" <${this.options.from}>`,
      to: [redirectTo ?? message.to],
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    const idempotencyKey = randomUUID();

    try {
      await this.attempt(body, idempotencyKey);
    } catch (first) {
      if (!(first instanceof MailDeliveryError) || !isRetryable(first)) {
        throw first;
      }
      this.logger.warn({
        message: 'Resend attempt failed, retrying once',
        reason: first.reason,
        status: first.status,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.retryDelayMs),
      );
      await this.attempt(body, idempotencyKey);
    }
    return 'sent';
  }

  private async attempt(body: string, idempotencyKey: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.options.apiUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      // By name, not instanceof: the abort reason is a DOMException that may come from another realm.
      const name = (error as { name?: unknown } | null)?.name;
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new MailDeliveryError(timedOut ? 'timeout' : 'network');
    }
    if (response.ok) {
      // Drain the body so the connection can be reused; its content (an id) is not needed.
      await response.arrayBuffer().catch(() => undefined);
      return;
    }
    const detail = await readError(response);
    throw new MailDeliveryError(
      classify(response.status, detail),
      response.status,
    );
  }
}

function isRetryable(error: MailDeliveryError): boolean {
  return (
    error.reason === 'timeout' ||
    error.reason === 'network' ||
    (error.status !== undefined && error.status >= 500)
  );
}

interface ErrorDetail {
  name: string;
  message: string;
}

async function readError(response: Response): Promise<ErrorDetail> {
  try {
    const json = (await response.json()) as Record<string, unknown>;
    return {
      name: typeof json.name === 'string' ? json.name : '',
      message: typeof json.message === 'string' ? json.message : '',
    };
  } catch {
    return { name: '', message: '' };
  }
}

/**
 * Maps Resend's documented errors (resend.com/docs/api-reference/errors) to a stable reason:
 * 403 `validation_error` is either the test-mode recipient refusal ("Testing emails can only be
 * sent to your own email address") or an unverified `from` domain; 429 is
 * `daily_quota_exceeded`, `monthly_quota_exceeded` or `rate_limit_exceeded`.
 */
export function classify(
  status: number,
  detail: ErrorDetail,
): MailFailureReason {
  if (status === 429) {
    if (detail.name === 'daily_quota_exceeded') return 'quota_daily';
    if (detail.name === 'monthly_quota_exceeded') return 'quota_monthly';
    return 'rate_limited';
  }
  if (status === 401) return 'auth';
  if (status === 403) {
    if (detail.name === 'validation_error') {
      return /testing emails/i.test(detail.message)
        ? 'test_mode_recipient'
        : /domain/i.test(detail.message)
          ? 'unverified_domain'
          : 'invalid_request';
    }
    return 'auth';
  }
  if (status >= 500) return 'provider_error';
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}

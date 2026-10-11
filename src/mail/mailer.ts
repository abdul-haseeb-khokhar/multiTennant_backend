/**
 * The emails the backend can send. The first three carry a single-use link (invite, reset,
 * verification); the billing ones (I8) carry a plain link to the billing page. Wording lives in the
 * `email.<template>.*` keys of the `notifications` translation namespace.
 */
export type MailTemplate =
  | 'staff-invite'
  | 'password-reset'
  | 'email-verification'
  | 'billing-period-ending'
  | 'billing-grace-started'
  | 'billing-downgraded';

/** Values a template may interpolate (plan names, day counts). Never tokens or links. */
export type MailParams = Record<string, string | number>;

export interface MailMessage {
  to: string;
  template: MailTemplate;
  /** Language of the recipient (BCP-47, e.g. `en`, `ur`); a provider renders `email.<template>.*` keys. */
  locale: string;
  /** The link of the email. A single-use link is a secret: never log it outside `ConsoleMailer`. */
  link: string;
  params?: MailParams;
}

/**
 * What happened to a message: `sent` = handed to the provider, `skipped` = nothing was sent
 * because the mailer is the development console one. A failure throws `MailDeliveryError`.
 */
export type MailDelivery = 'sent' | 'skipped';

/**
 * Why a delivery failed, as a stable code for logs and the health warning. The provider's own
 * message is never kept: Resend's test-mode refusal names the account's email address.
 */
export type MailFailureReason =
  /** The provider only delivers to the account owner's own address (Resend test mode, 403). */
  | 'test_mode_recipient'
  /** The `from` domain is not verified (403). */
  | 'unverified_domain'
  | 'quota_daily'
  | 'quota_monthly'
  | 'rate_limited'
  /** Missing, restricted, suspended or wrong API key (401/403). */
  | 'auth'
  | 'invalid_request'
  | 'timeout'
  | 'network'
  | 'provider_error'
  | 'unknown';

export class MailDeliveryError extends Error {
  constructor(
    readonly reason: MailFailureReason,
    readonly status?: number,
  ) {
    // The message carries only the reason: errors end up in logs.
    super(
      `Mail delivery failed (${reason}${status ? `, HTTP ${status}` : ''})`,
    );
    this.name = 'MailDeliveryError';
  }
}

/**
 * Delivery of an email. An abstract class so it can be injected as a provider token. `MailModule`
 * binds `ConsoleMailer` or `ResendMailer` from `MAIL_PROVIDER`; another provider (SES, Brevo) is
 * one new class that renders with `MailRenderer` and throws `MailDeliveryError` on failure.
 */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<MailDelivery>;
}

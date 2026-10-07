/** The emails the backend sends. Each carries a single link; wording lives in `notifications` (i18n). */
export type MailTemplate =
  'staff-invite' | 'password-reset' | 'email-verification';

export interface MailMessage {
  to: string;
  template: MailTemplate;
  /** Language of the recipient (BCP-47, e.g. `en`, `ur`); a provider renders `email.<template>.*` keys. */
  locale: string;
  /** The single-use link. Treat it as a secret: never log it outside `ConsoleMailer`. */
  link: string;
}

/**
 * Delivery of an email. An abstract class so it can be injected as a provider token.
 *
 * TODO(H3): the mail provider and sender domain are not chosen yet (SMTP, SES or Resend). To add
 * one, implement `send` in a new class, render the message from the `email.<template>.*` keys of
 * the `notifications` namespace in the recipient's `locale`, and bind it in `MailModule`
 * (`{ provide: Mailer, useClass: ... }`, or a factory that reads a `MAIL_PROVIDER` setting).
 * Nothing else changes.
 */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

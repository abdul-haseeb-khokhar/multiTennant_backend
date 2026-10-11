import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { I18nModule } from '../i18n/i18n.module';
import { ConsoleMailer } from './console.mailer';
import { MailHealth } from './mail-health';
import { MailRenderer } from './mail-renderer';
import { MailService } from './mail.service';
import { Mailer } from './mailer';
import { RESEND_DEFAULTS, ResendMailer } from './resend.mailer';

/** Sender and product name when `MAIL_FROM_NAME` is not set: a working name, decided 2026-10-10; configurable. */
export const DEFAULT_MAIL_FROM_NAME = 'SupportDesk AI';
/** The shared sender of Resend's test mode. */
export const DEFAULT_MAIL_FROM = 'onboarding@resend.dev';

/**
 * `MAIL_PROVIDER=console` (default) logs emails; `resend` sends them through Resend. Production
 * refuses `console` at startup (see `validateEnv`), so a real deployment cannot silently drop mail.
 */
@Module({
  imports: [I18nModule],
  providers: [
    MailRenderer,
    MailHealth,
    {
      provide: Mailer,
      inject: [ConfigService, MailRenderer],
      useFactory: (config: ConfigService, renderer: MailRenderer): Mailer => {
        if (config.get<string>('MAIL_PROVIDER') !== 'resend') {
          return new ConsoleMailer();
        }
        return new ResendMailer(
          {
            // validateEnv guarantees the key is present when the provider is resend
            apiKey: config.get<string>('RESEND_API_KEY') ?? '',
            from: config.get<string>('MAIL_FROM') ?? DEFAULT_MAIL_FROM,
            fromName:
              config.get<string>('MAIL_FROM_NAME') ?? DEFAULT_MAIL_FROM_NAME,
            redirectTo: config.get<string>('MAIL_REDIRECT_TO') || undefined,
            timeoutMs:
              Number(config.get('MAIL_TIMEOUT_MS')) ||
              RESEND_DEFAULTS.timeoutMs,
            apiUrl:
              config.get<string>('RESEND_API_URL') ?? RESEND_DEFAULTS.apiUrl,
            retryDelayMs: RESEND_DEFAULTS.retryDelayMs,
          },
          renderer,
        );
      },
    },
    MailService,
  ],
  exports: [MailService, MailHealth],
})
export class MailModule {}

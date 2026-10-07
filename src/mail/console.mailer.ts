import { Injectable, Logger } from '@nestjs/common';
import { MailMessage, Mailer } from './mailer';

/**
 * Development mailer: writes the message, link included, to the log instead of sending it. This
 * is the only place a link may be logged, and it is the reason the console mailer must not be
 * the production mailer: swap it for a real provider in `MailModule` before going live.
 */
@Injectable()
export class ConsoleMailer extends Mailer {
  private readonly logger = new Logger('ConsoleMailer');

  send(message: MailMessage): Promise<void> {
    this.logger.log({
      message: 'email (not sent: console mailer)',
      to: message.to,
      template: message.template,
      locale: message.locale,
      link: message.link,
    });
    return Promise.resolve();
  }
}

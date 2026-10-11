import { Injectable, Logger } from '@nestjs/common';
import { MailDelivery, MailMessage, Mailer } from './mailer';

/**
 * Development mailer: writes the message, link included, to the log instead of sending it. This
 * is the only place a link may be logged, and it is the reason the console mailer must not be
 * the production mailer: production refuses `MAIL_PROVIDER=console` at startup.
 */
@Injectable()
export class ConsoleMailer extends Mailer {
  private readonly logger = new Logger('ConsoleMailer');

  send(message: MailMessage): Promise<MailDelivery> {
    this.logger.log({
      message: 'email (not sent: console mailer)',
      to: message.to,
      template: message.template,
      locale: message.locale,
      link: message.link,
    });
    return Promise.resolve('skipped');
  }
}

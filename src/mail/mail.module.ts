import { Module } from '@nestjs/common';
import { ConsoleMailer } from './console.mailer';
import { MailService } from './mail.service';
import { Mailer } from './mailer';

@Module({
  providers: [
    // TODO(H3): replace with the real provider once chosen (see the note on `Mailer`).
    { provide: Mailer, useClass: ConsoleMailer },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}

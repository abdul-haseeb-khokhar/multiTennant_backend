import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailModule } from '../mail/mail.module';
import { InviteAcceptController } from './invite-accept.controller';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';

@Module({
  imports: [AuthModule, MailModule],
  controllers: [InvitesController, InviteAcceptController],
  providers: [InvitesService],
})
export class InvitesModule {}

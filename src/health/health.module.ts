import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { HealthController } from './health.controller';

@Module({ imports: [MailModule], controllers: [HealthController] })
export class HealthModule {}

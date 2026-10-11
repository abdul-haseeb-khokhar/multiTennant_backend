import { Module } from '@nestjs/common';
import { EndCustomersService } from './end-customers.service';
import { EndCustomersController } from './end-customers.controller';
import { AuthModule } from '../auth/auth.module';
import { ConversationsModule } from '../conversations/conversations.module';

@Module({
  imports: [AuthModule, ConversationsModule],
  controllers: [EndCustomersController],
  providers: [EndCustomersService],
})
export class EndCustomersModule {}

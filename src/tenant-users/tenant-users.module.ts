import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingCoreModule } from '../billing/billing-core.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { TenantUsersController } from './tenant-users.controller';
import { TenantUsersService } from './tenant-users.service';

@Module({
  imports: [AuthModule, BillingCoreModule, ConversationsModule],
  controllers: [TenantUsersController],
  providers: [TenantUsersService],
  exports: [TenantUsersService],
})
export class TenantUsersModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingCoreModule } from '../billing/billing-core.module';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';

@Module({
  imports: [AuthModule, BillingCoreModule],
  controllers: [ApiKeysController],
  providers: [ApiKeysService],
  // The widget gateway resolves public keys through this service.
  exports: [ApiKeysService],
})
export class ApiKeysModule {}

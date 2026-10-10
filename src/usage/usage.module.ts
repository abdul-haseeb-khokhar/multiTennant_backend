import { Module } from '@nestjs/common';
import { BillingCoreModule } from '../billing/billing-core.module';
import { UsageService } from './usage.service';

@Module({
  imports: [BillingCoreModule],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}

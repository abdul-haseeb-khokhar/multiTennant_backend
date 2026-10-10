import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingCoreModule } from '../billing/billing-core.module';
import { DataUseController } from './data-use.controller';
import { DataUseService } from './data-use.service';

@Module({
  imports: [AuthModule, BillingCoreModule],
  controllers: [DataUseController],
  providers: [DataUseService],
})
export class DataUseModule {}

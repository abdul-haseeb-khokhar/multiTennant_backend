import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingCoreModule } from '../billing/billing-core.module';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  imports: [AuthModule, BillingCoreModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}

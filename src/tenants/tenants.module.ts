import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingCoreModule } from '../billing/billing-core.module';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [AuthModule, BillingCoreModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingCoreModule } from '../billing/billing-core.module';
import { SlugsModule } from '../slugs/slugs.module';
import { TenantSettingsController } from './tenant-settings.controller';
import { TenantSettingsService } from './tenant-settings.service';
import { TenantsController } from './tenants.controller';
import { TenantsService } from './tenants.service';

@Module({
  imports: [AuthModule, BillingCoreModule, SlugsModule],
  controllers: [TenantsController, TenantSettingsController],
  providers: [TenantsService, TenantSettingsService],
})
export class TenantsModule {}

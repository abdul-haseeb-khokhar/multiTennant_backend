import { Module } from '@nestjs/common';
import { BillingCoreModule } from '../billing/billing-core.module';
import { SlugService } from './slug.service';

@Module({
  imports: [BillingCoreModule],
  providers: [SlugService],
  exports: [SlugService],
})
export class SlugsModule {}

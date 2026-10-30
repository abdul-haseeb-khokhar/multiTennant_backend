import { Module } from '@nestjs/common';
import { PlanCatalogSyncService } from './plan-catalog-sync.service';

/**
 * Applies the `PLAN_*` environment variables to the `plans` table at startup (L6, decided
 * 2026-10-21). Kept apart from the billing modules: it only writes plan rows, once, and nothing
 * else depends on it. PrismaModule and ConfigModule are global.
 */
@Module({ providers: [PlanCatalogSyncService] })
export class PlanCatalogModule {}

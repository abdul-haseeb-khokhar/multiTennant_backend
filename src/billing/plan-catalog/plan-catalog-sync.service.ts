import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PLAN_CATALOG_LOCK_KEY } from '../billing.constants';
import {
  PlanCatalogSetting,
  fieldLabel,
  readPlanCatalogSettings,
} from './plan-catalog.env';

/** One value the sync changed in the `plans` table. Plan codes and numbers are not secrets. */
export interface PlanCatalogChange {
  plan: string;
  field: string;
  from: number | null;
  to: number;
}

/**
 * Applies the plan variables of `plan-catalog.env.ts` to the `plans` table, once at startup (every
 * instance runs it; they queue behind a Postgres advisory lock and the later ones find nothing left
 * to change).
 *
 *  - Only the variables that are SET are applied. A variable that is unset leaves the value that is
 *    in the table (the migration's placeholder, or an edit made by hand).
 *  - Idempotent: a value that already matches is not written, and nothing is logged then.
 *  - It changes the limits/prices of EVERY tenant on that plan at once (entitlements are read live
 *    from the plan row, other instances within their 30 s cache); invoices already recorded are
 *    never touched. All instances must run with the same values, otherwise the one that starts
 *    last wins.
 *  - A failure refuses the boot: an operator who set a price must not run on a silently different
 *    one.
 *
 * Without any plan variable set it does not touch the database.
 */
@Injectable()
export class PlanCatalogSyncService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlanCatalogSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    await this.sync();
  }

  /** Applies the environment to the plans table; returns what changed (empty = nothing to do). */
  async sync(): Promise<PlanCatalogChange[]> {
    const settings = readPlanCatalogSettings((name) =>
      this.config.get<unknown>(name),
    );
    if (settings.length === 0) return [];

    const changes = await this.prisma.$transaction(async (tx) => {
      // Blocks until another instance that is syncing has committed; then the rows read below are
      // already up to date. (`$executeRaw`: the function returns void, which `$queryRaw` cannot read.)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLAN_CATALOG_LOCK_KEY}::bigint)`;
      const applied: PlanCatalogChange[] = [];
      const byPlan = new Map<string, PlanCatalogSetting[]>();
      for (const setting of settings) {
        const list = byPlan.get(setting.variable.planCode) ?? [];
        list.push(setting);
        byPlan.set(setting.variable.planCode, list);
      }
      for (const [planCode, planSettings] of byPlan) {
        const plan = await tx.plan.findUnique({ where: { code: planCode } });
        if (!plan) {
          this.logger.warn({
            message:
              'Plan catalogue: the plan does not exist, its variables were not applied',
            plan: planCode,
          });
          continue;
        }
        const raw = plan.entitlements;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          this.logger.warn({
            message:
              'Plan catalogue: the plan has malformed entitlements, its variables were not applied',
            plan: planCode,
          });
          continue;
        }
        const entitlements: Record<string, unknown> = {
          ...(raw as Record<string, unknown>),
        };
        const columns: { priceMinor?: number; yearlyPriceMinor?: number } = {};
        let entitlementsChanged = false;
        for (const { variable, value } of planSettings) {
          const { target } = variable;
          const current =
            target.kind === 'entitlement'
              ? entitlements[target.key]
              : plan[target.column];
          if (current === value) continue;
          applied.push({
            plan: planCode,
            field: fieldLabel(target),
            from: typeof current === 'number' ? current : null,
            to: value,
          });
          if (target.kind === 'entitlement') {
            entitlements[target.key] = value;
            entitlementsChanged = true;
          } else {
            columns[target.column] = value;
          }
        }
        if (entitlementsChanged || Object.keys(columns).length > 0) {
          await tx.plan.update({
            where: { code: planCode },
            data: {
              ...columns,
              ...(entitlementsChanged && {
                entitlements: entitlements as Prisma.InputJsonObject,
              }),
            },
          });
        }
      }
      return applied;
    });

    // After the commit, so a rolled-back change is never reported as made.
    for (const change of changes) {
      this.logger.log({
        message: 'Plan catalogue changed from the environment',
        ...change,
      });
    }
    return changes;
  }
}

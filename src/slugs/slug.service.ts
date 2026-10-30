import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Clock } from '../billing/clock';
import { PrismaService } from '../prisma/prisma.service';
import {
  SLUG_PATTERN,
  isReservedSlug,
  suggestionCandidates,
} from '../tenants/slug';

/** How long the old slug of a renamed tenant keeps working at login (J3). */
export const SLUG_ALIAS_ACCEPTED_DAYS = 30;
/** How long nobody else may take the old slug (J3). */
export const SLUG_ALIAS_RESERVED_DAYS = 90;
/** The shortest time between two renames of one tenant (J3). */
export const SLUG_CHANGE_INTERVAL_DAYS = 30;
/** How many alternatives an unavailable slug is answered with. */
export const MAX_SUGGESTIONS = 3;

const DAY_MS = 86_400_000;

type Db = Pick<
  Prisma.TransactionClient,
  'tenant' | 'tenantSlugAlias' | '$executeRaw'
>;

/**
 * Who owns a slug (J2, J3). A slug is taken when a tenant has it now, or when a tenant had it less
 * than 90 days ago (`tenant_slug_aliases.reserved_until`); for the first 30 days of that time the
 * old slug still logs in. This is the one place that decides availability, used by signup, the
 * public availability check and the owner's rename. It answers only yes or no (and free
 * alternatives): never who holds a slug.
 */
@Injectable()
export class SlugService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Lower-cases and trims what a person typed. */
  normalize(slug: string) {
    return slug.trim().toLowerCase();
  }

  /** The format rules of signup: 3-40 characters of a-z, 0-9 and dashes, and not a word we keep for ourselves. */
  isUsable(slug: string) {
    return SLUG_PATTERN.test(slug) && !isReservedSlug(slug);
  }

  /**
   * Which of `slugs` can be taken. `forTenantId` is the tenant that wants them: its own
   * reservations do not count against it (taking an old slug back), but its current slug is not
   * "available" (there is nothing to rename to). Unusable slugs are never available.
   */
  async availableAmong(
    slugs: string[],
    forTenantId?: string,
    db: Db = this.prisma,
  ): Promise<Set<string>> {
    const usable = [...new Set(slugs)].filter((slug) => this.isUsable(slug));
    if (usable.length === 0) return new Set();
    const now = this.clock.now();
    const [tenants, aliases] = await Promise.all([
      db.tenant.findMany({
        where: { slug: { in: usable } },
        select: { slug: true },
      }),
      db.tenantSlugAlias.findMany({
        where: { slug: { in: usable }, reservedUntil: { gt: now } },
        select: { slug: true, tenantId: true },
      }),
    ]);
    const taken = new Set(tenants.map((t) => t.slug));
    for (const alias of aliases) {
      if (alias.tenantId !== forTenantId) taken.add(alias.slug);
    }
    return new Set(usable.filter((slug) => !taken.has(slug)));
  }

  async isAvailable(slug: string, forTenantId?: string, db: Db = this.prisma) {
    return (await this.availableAmong([slug], forTenantId, db)).has(slug);
  }

  /** Up to three free alternatives to `wanted`, best first. */
  async suggest(
    wanted: string,
    forTenantId?: string,
    db: Db = this.prisma,
  ): Promise<string[]> {
    const candidates = suggestionCandidates(wanted).filter(
      (slug) => slug !== wanted,
    );
    const free = await this.availableAmong(candidates, forTenantId, db);
    return candidates
      .filter((slug) => free.has(slug))
      .slice(0, MAX_SUGGESTIONS);
  }

  /**
   * The tenant a login slug points to: the tenant that has it now, else the tenant that had it
   * in the last 30 days. Returns the tenant row, or null.
   */
  async resolveTenant(slug: string) {
    const current = await this.prisma.tenant.findUnique({ where: { slug } });
    if (current) return current;
    const alias = await this.prisma.tenantSlugAlias.findFirst({
      where: { slug, acceptedUntil: { gt: this.clock.now() } },
      include: { tenant: true },
    });
    return alias?.tenant ?? null;
  }

  /** The alias windows for a slug given up now. */
  aliasWindows(now = this.clock.now()) {
    return {
      acceptedUntil: new Date(
        now.getTime() + SLUG_ALIAS_ACCEPTED_DAYS * DAY_MS,
      ),
      reservedUntil: new Date(
        now.getTime() + SLUG_ALIAS_RESERVED_DAYS * DAY_MS,
      ),
    };
  }

  /** When the tenant may rename again, or null when it may now. */
  nextChangeAllowedAt(slugChangedAt: Date | null): Date | null {
    if (!slugChangedAt) return null;
    const next = new Date(
      slugChangedAt.getTime() + SLUG_CHANGE_INTERVAL_DAYS * DAY_MS,
    );
    return next > this.clock.now() ? next : null;
  }

  /**
   * Serialises everything that claims a slug (signup, rename) for the rest of the transaction. The
   * unique index on `tenants.slug` already stops two tenants taking one slug, but it cannot see an
   * alias created in another transaction at the same moment (a tenant giving a slug up while a new
   * signup takes it), so claims queue behind this lock.
   */
  async lock(tx: Pick<Prisma.TransactionClient, '$executeRaw'>) {
    // executeRaw, not queryRaw: the function returns void, which Prisma cannot read as a result row.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('tenant_core.slugs'))`;
  }
}

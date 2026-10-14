import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { FakeClock } from '../billing/clock';
import { PrismaService } from '../prisma/prisma.service';
import { SlugService } from './slug.service';

describe('SlugService', () => {
  let prisma: PrismaMock;
  let clock: FakeClock;
  let service: SlugService;
  /** Slugs held by tenants now, and the aliases that are still reserved: { slug, tenantId }. */
  let tenantSlugs: string[];
  let aliases: { slug: string; tenantId: string }[];

  beforeEach(() => {
    prisma = createPrismaMock();
    clock = new FakeClock(new Date('2026-10-13T00:00:00Z'));
    service = new SlugService(prisma as unknown as PrismaService, clock);
    tenantSlugs = [];
    aliases = [];
    prisma.tenant.findMany.mockImplementation(
      ({ where }: { where: { slug: { in: string[] } } }) =>
        Promise.resolve(
          tenantSlugs
            .filter((slug) => where.slug.in.includes(slug))
            .map((slug) => ({ slug })),
        ),
    );
    prisma.tenantSlugAlias.findMany.mockImplementation(
      ({ where }: { where: { slug: { in: string[] } } }) =>
        Promise.resolve(aliases.filter((a) => where.slug.in.includes(a.slug))),
    );
  });

  describe('availability', () => {
    it('a free, well-formed slug is available', async () => {
      await expect(service.isAvailable('acme-support')).resolves.toBe(true);
    });

    it('a slug a tenant has now is not', async () => {
      tenantSlugs = ['acme'];
      await expect(service.isAvailable('acme')).resolves.toBe(false);
      // not even for that same tenant: there is nothing to rename to
      await expect(service.isAvailable('acme', 't1')).resolves.toBe(false);
    });

    it('a slug another tenant gave up is reserved for them (90 days)', async () => {
      aliases = [{ slug: 'oldname', tenantId: 't2' }];
      await expect(service.isAvailable('oldname')).resolves.toBe(false);
      await expect(service.isAvailable('oldname', 't1')).resolves.toBe(false);
    });

    it('the tenant that gave a slug up may take it back', async () => {
      aliases = [{ slug: 'oldname', tenantId: 't1' }];
      await expect(service.isAvailable('oldname', 't1')).resolves.toBe(true);
    });

    it('only asks the database about aliases that are still reserved', async () => {
      await service.isAvailable('acme');
      expect(prisma.tenantSlugAlias.findMany).toHaveBeenCalledWith({
        where: {
          slug: { in: ['acme'] },
          reservedUntil: { gt: new Date('2026-10-13T00:00:00Z') },
        },
        select: { slug: true, tenantId: true },
      });
    });

    it.each(['admin', 'ab', 'Acme', '-acme', 'acme-', 'a'.repeat(41), 'a b'])(
      'a reserved word or malformed slug (%j) is never available, without a database call',
      async (slug) => {
        await expect(service.isAvailable(slug)).resolves.toBe(false);
        expect(prisma.tenant.findMany).not.toHaveBeenCalled();
      },
    );

    it('checks many candidates with one query per table', async () => {
      tenantSlugs = ['acme-2'];
      const free = await service.availableAmong(['acme-2', 'acme-3', 'acme-3']);
      expect([...free]).toEqual(['acme-3']);
      expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.tenantSlugAlias.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('suggest', () => {
    it('offers free alternatives, best first, at most three', async () => {
      tenantSlugs = ['acme', 'acme-2'];
      await expect(service.suggest('acme')).resolves.toEqual([
        'acme-3',
        'acme-support',
        'acme-team',
      ]);
    });

    it('skips alternatives that are reserved by an old name', async () => {
      aliases = [{ slug: 'acme-2', tenantId: 't9' }];
      const suggestions = await service.suggest('acme');
      expect(suggestions).not.toContain('acme-2');
      expect(suggestions).toHaveLength(3);
    });

    it('cleans up what the person typed and offers the cleaned form first', async () => {
      await expect(service.suggest('Acme Support!')).resolves.toEqual([
        'acme-support',
        'acme-support-2',
        'acme-support-3',
      ]);
    });

    it('never suggests the slug that was asked for, or an unusable one', async () => {
      const suggestions = await service.suggest('admin');
      expect(suggestions).not.toContain('admin');
      expect(suggestions.every((s) => s.startsWith('workspace'))).toBe(true);
    });
  });

  describe('resolveTenant (login)', () => {
    it('finds the tenant that has the slug now', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: 't1', slug: 'acme' });
      await expect(service.resolveTenant('acme')).resolves.toEqual({
        id: 't1',
        slug: 'acme',
      });
      expect(prisma.tenantSlugAlias.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to an alias that is still accepted (30 days), looked up by the clock', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      prisma.tenantSlugAlias.findFirst.mockResolvedValue({
        slug: 'acme',
        tenant: { id: 't1', slug: 'acme-support' },
      });
      await expect(service.resolveTenant('acme')).resolves.toEqual({
        id: 't1',
        slug: 'acme-support',
      });
      expect(prisma.tenantSlugAlias.findFirst).toHaveBeenCalledWith({
        where: {
          slug: 'acme',
          acceptedUntil: { gt: new Date('2026-10-13T00:00:00Z') },
        },
        include: { tenant: true },
      });
    });

    it('an alias past its 30 days (only reserved) does not log in', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      prisma.tenantSlugAlias.findFirst.mockResolvedValue(null);
      await expect(service.resolveTenant('acme')).resolves.toBeNull();
    });
  });

  describe('windows', () => {
    it('accepts the old slug for 30 days and reserves it for 90', () => {
      expect(service.aliasWindows()).toEqual({
        acceptedUntil: new Date('2026-11-12T00:00:00Z'),
        reservedUntil: new Date('2027-01-11T00:00:00Z'),
      });
    });

    it('allows one rename every 30 days', () => {
      expect(service.nextChangeAllowedAt(null)).toBeNull();
      const last = new Date('2026-10-01T00:00:00Z');
      expect(service.nextChangeAllowedAt(last)).toEqual(
        new Date('2026-10-31T00:00:00Z'),
      );
      clock.set('2026-10-31T00:00:00Z');
      expect(service.nextChangeAllowedAt(last)).toBeNull();
    });
  });

  it('lock takes a transaction-level advisory lock', async () => {
    prisma.$executeRaw.mockResolvedValue(1);
    await service.lock(prisma);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = (prisma.$executeRaw.mock.calls[0][0] as string[]).join('');
    expect(sql).toContain('pg_advisory_xact_lock');
  });
});

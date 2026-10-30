import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../auth/roles';
import { FakeClock } from '../billing/clock';
import { PrismaService } from '../prisma/prisma.service';
import { SlugService } from '../slugs/slug.service';
import { TenantSettingsService } from './tenant-settings.service';

describe('TenantSettingsService', () => {
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let slugs: Record<keyof SlugService, jest.Mock>;
  let clock: FakeClock;
  let service: TenantSettingsService;

  const NOW = new Date('2026-10-13T00:00:00Z');
  const owner: AuthUser = {
    userId: 'u1',
    tenantId: 't1',
    role: 'owner',
    emailVerified: true,
  };
  const tenant = {
    id: 't1',
    name: 'Acme',
    slug: 'acme',
    defaultLocale: 'en',
    timezone: 'Asia/Karachi',
    slugChangedAt: null as Date | null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    clock = new FakeClock(NOW);
    slugs = {
      normalize: jest.fn(),
      isUsable: jest.fn().mockReturnValue(true),
      availableAmong: jest.fn(),
      isAvailable: jest.fn().mockResolvedValue(true),
      suggest: jest.fn().mockResolvedValue(['acme-2', 'acme-3']),
      resolveTenant: jest.fn(),
      aliasWindows: jest.fn().mockReturnValue({
        acceptedUntil: new Date('2026-11-12T00:00:00Z'),
        reservedUntil: new Date('2027-01-11T00:00:00Z'),
      }),
      nextChangeAllowedAt: jest.fn().mockReturnValue(null),
      lock: jest.fn().mockResolvedValue(undefined),
    } as unknown as Record<keyof SlugService, jest.Mock>;
    service = new TenantSettingsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      slugs as unknown as SlugService,
      clock,
    );
    prisma.tenant.findUnique.mockResolvedValue({ ...tenant });
    prisma.tenant.update.mockResolvedValue({});
    prisma.tenantSlugAlias.findMany.mockResolvedValue([]);
    prisma.tenantSlugAlias.deleteMany.mockResolvedValue({ count: 0 });
    prisma.tenantSlugAlias.create.mockResolvedValue({});
  });

  describe('get', () => {
    it('returns the settings of the tenant, scoped by id, with the reserved previous slugs', async () => {
      const previous = [
        {
          slug: 'old',
          acceptedUntil: new Date('2026-11-01T00:00:00Z'),
          reservedUntil: new Date('2027-01-01T00:00:00Z'),
        },
      ];
      prisma.tenantSlugAlias.findMany.mockResolvedValue(previous);
      slugs.nextChangeAllowedAt.mockReturnValue(
        new Date('2026-11-01T00:00:00Z'),
      );
      await expect(service.get('t1')).resolves.toEqual({
        id: 't1',
        name: 'Acme',
        slug: 'acme',
        defaultLocale: 'en',
        timezone: 'Asia/Karachi',
        createdAt: tenant.createdAt,
        slugChangedAt: null,
        slugChangeAllowedAt: new Date('2026-11-01T00:00:00Z'),
        previousSlugs: previous,
      });
      expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: 't1' },
      });
      expect(prisma.tenantSlugAlias.findMany).toHaveBeenCalledWith({
        where: { tenantId: 't1', reservedUntil: { gt: NOW } },
        orderBy: { createdAt: 'desc' },
        select: { slug: true, acceptedUntil: true, reservedUntil: true },
      });
    });

    it('never exposes plan, status or anything else of the tenant row', async () => {
      prisma.tenant.findUnique.mockResolvedValue({
        ...tenant,
        plan: 'pro',
        status: 'active',
      });
      const view = await service.get('t1');
      expect(view).not.toHaveProperty('plan');
      expect(view).not.toHaveProperty('status');
    });

    it('404 TENANT_NOT_FOUND for an unknown tenant', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      await expect(service.get('t9')).rejects.toMatchObject({
        status: 404,
        response: { code: 'TENANT_NOT_FOUND' },
      });
    });
  });

  describe('update: name, language, time zone (J7)', () => {
    it('changes only what differs, scoped to the token tenant, and audits before and after', async () => {
      await service.update(owner, {
        name: 'Acme Ltd',
        timezone: 'Europe/London',
        defaultLocale: 'en', // unchanged
      });
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { name: 'Acme Ltd', timezone: 'Europe/London' },
      });
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: 't1',
          actor: { userId: 'u1', role: 'owner' },
          action: 'tenant.updated',
          targetType: 'tenant',
          targetId: 't1',
          before: { name: 'Acme', timezone: 'Asia/Karachi' },
          after: { name: 'Acme Ltd', timezone: 'Europe/London' },
        },
        prisma,
      );
    });

    it('writes nothing, and audits nothing, when nothing changes', async () => {
      await service.update(owner, { name: 'Acme', slug: 'acme' });
      await service.update(owner, {});
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('takes the tenant from the actor, never from the body', async () => {
      await service.update(owner, { name: 'Acme Ltd' });
      expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: 't1' },
      });
    });
  });

  describe('update: slug rename (J3)', () => {
    it('renames, keeps the old slug as an alias (30 + 90 days), stamps the time and audits tenant.slug_changed', async () => {
      await service.update(owner, { slug: 'acme-support' });

      expect(slugs.lock).toHaveBeenCalledWith(prisma);
      expect(slugs.isAvailable).toHaveBeenCalledWith(
        'acme-support',
        't1',
        prisma,
      );
      expect(prisma.tenantSlugAlias.create).toHaveBeenCalledWith({
        data: {
          tenantId: 't1',
          slug: 'acme',
          acceptedUntil: new Date('2026-11-12T00:00:00Z'),
          reservedUntil: new Date('2027-01-11T00:00:00Z'),
        },
      });
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { slug: 'acme-support', slugChangedAt: NOW },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tenant.slug_changed',
          before: { slug: 'acme' },
          after: { slug: 'acme-support' },
        }),
        prisma,
      );
      // the alias is created behind the lock, in the same transaction as the update
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('a slug rename together with a name change writes both audit entries', async () => {
      await service.update(owner, { slug: 'acme-support', name: 'Acme Ltd' });
      expect(audit.record.mock.calls.map((c) => c[0].action)).toEqual([
        'tenant.updated',
        'tenant.slug_changed',
      ]);
    });

    it('409 SLUG_TAKEN with suggestions when the slug is not free, and nothing is changed', async () => {
      slugs.isAvailable.mockResolvedValue(false);
      await expect(
        service.update(owner, { slug: 'taken' }),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'SLUG_TAKEN',
          suggestions: ['acme-2', 'acme-3'],
        },
      });
      expect(slugs.suggest).toHaveBeenCalledWith('taken', 't1', prisma);
      expect(prisma.tenantSlugAlias.create).not.toHaveBeenCalled();
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409 SLUG_CHANGE_TOO_SOON, with the date, within 30 days of the last rename', async () => {
      const last = new Date('2026-10-01T00:00:00Z');
      prisma.tenant.findUnique.mockResolvedValue({
        ...tenant,
        slugChangedAt: last,
      });
      slugs.nextChangeAllowedAt.mockReturnValue(
        new Date('2026-10-31T00:00:00Z'),
      );
      await expect(
        service.update(owner, { slug: 'acme-support' }),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'SLUG_CHANGE_TOO_SOON',
          nextAllowedAt: '2026-10-31T00:00:00.000Z',
        },
      });
      expect(slugs.nextChangeAllowedAt).toHaveBeenCalledWith(last);
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('taking one of its own old slugs back removes that alias instead of keeping both', async () => {
      await service.update(owner, { slug: 'older' });
      expect(prisma.tenantSlugAlias.deleteMany).toHaveBeenCalledWith({
        where: { tenantId: 't1', slug: 'older' },
      });
    });

    it('every alias statement is scoped to the tenant', async () => {
      await service.update(owner, { slug: 'acme-support' });
      for (const [arg] of prisma.tenantSlugAlias.deleteMany.mock.calls) {
        expect(arg.where.tenantId).toBe('t1');
      }
    });

    it('a rename that loses the race on the unique index is still a 409 SLUG_TAKEN with suggestions', async () => {
      prisma.tenant.update.mockRejectedValue(prismaError('P2002'));
      await expect(
        service.update(owner, { slug: 'acme-support' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'SLUG_TAKEN', suggestions: ['acme-2', 'acme-3'] },
      });
    });

    it('other database errors pass through', async () => {
      prisma.tenant.update.mockRejectedValue(new Error('db down'));
      await expect(
        service.update(owner, { slug: 'acme-support' }),
      ).rejects.toThrow('db down');
    });
  });
});

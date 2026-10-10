import { Test } from '@nestjs/testing';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
} from '../../test/utils/prisma-mock';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/roles';
import { Clock, FakeClock } from '../billing/clock';
import { PrismaService } from '../prisma/prisma.service';
import { DataUseService } from './data-use.service';

const T0 = new Date('2026-10-07T00:00:00.000Z');
const owner: AuthUser = {
  userId: 'owner-1',
  tenantId: 'tenant-a',
  role: 'owner',
  emailVerified: true,
};
const key = {
  tenantId_purpose: { tenantId: 'tenant-a', purpose: 'model_training' },
};

const consent = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  tenantId: 'tenant-a',
  purpose: 'model_training',
  status: 'granted',
  termsVersion: '2026-10-01',
  acceptedBy: 'owner-1',
  acceptedAt: T0,
  revokedAt: null,
  ...over,
});

describe('DataUseService (I11 consent, default off)', () => {
  let service: DataUseService;
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    prisma.dataUseConsent.upsert.mockImplementation(({ create }) =>
      Promise.resolve(consent(create)),
    );
    prisma.dataUseConsent.update.mockImplementation(({ data }) =>
      Promise.resolve(consent(data)),
    );
    const module = await Test.createTestingModule({
      providers: [
        DataUseService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: Clock, useValue: new FakeClock(T0) },
      ],
    }).compile();
    service = module.get(DataUseService);
  });

  describe('get', () => {
    it('is OFF by default: no record means not enabled, with nothing accepted', async () => {
      prisma.dataUseConsent.findUnique.mockResolvedValue(null);
      await expect(service.get('tenant-a')).resolves.toEqual({
        purpose: 'model_training',
        enabled: false,
        status: 'off',
        termsVersion: null,
        acceptedBy: null,
        acceptedAt: null,
        revokedAt: null,
      });
      expect(prisma.dataUseConsent.findUnique).toHaveBeenCalledWith({
        where: key,
      });
    });

    it('reports a granted consent with the terms version, who accepted and when', async () => {
      prisma.dataUseConsent.findUnique.mockResolvedValue(consent());
      await expect(service.get('tenant-a')).resolves.toMatchObject({
        enabled: true,
        status: 'granted',
        termsVersion: '2026-10-01',
        acceptedBy: 'owner-1',
        acceptedAt: T0,
      });
    });

    it('reports a revoked consent as not enabled, keeping the history', async () => {
      prisma.dataUseConsent.findUnique.mockResolvedValue(
        consent({ status: 'revoked', revokedAt: T0 }),
      );
      await expect(service.get('tenant-a')).resolves.toMatchObject({
        enabled: false,
        status: 'revoked',
        revokedAt: T0,
        acceptedBy: 'owner-1',
      });
    });
  });

  describe('update: granting', () => {
    it('records the owner, the terms version and the time, and audits it in the same transaction', async () => {
      prisma.dataUseConsent.findUnique.mockResolvedValue(null);
      const view = await service.update('tenant-a', owner, {
        enabled: true,
        termsVersion: '2026-10-01',
      });
      expect(prisma.dataUseConsent.upsert).toHaveBeenCalledWith({
        where: key,
        create: {
          tenantId: 'tenant-a',
          purpose: 'model_training',
          status: 'granted',
          termsVersion: '2026-10-01',
          acceptedBy: 'owner-1',
          acceptedAt: T0,
        },
        update: {
          status: 'granted',
          termsVersion: '2026-10-01',
          acceptedBy: 'owner-1',
          acceptedAt: T0,
          revokedAt: null,
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: 'tenant-a',
          actor: { userId: 'owner-1', role: 'owner' },
          action: 'data_use.granted',
          targetType: 'data_use',
          targetId: 'model_training',
          before: { status: 'off' },
          after: { status: 'granted', termsVersion: '2026-10-01' },
        },
        prisma,
      );
      expect(view).toMatchObject({ enabled: true, status: 'granted' });
    });

    it('granting again with the same terms changes and audits nothing', async () => {
      prisma.dataUseConsent.findUnique.mockResolvedValue(consent());
      await service.update('tenant-a', owner, {
        enabled: true,
        termsVersion: '2026-10-01',
      });
      expect(prisma.dataUseConsent.upsert).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('accepting a newer terms version is a new grant', async () => {
      prisma.dataUseConsent.findUnique.mockResolvedValue(consent());
      await service.update('tenant-a', owner, {
        enabled: true,
        termsVersion: '2027-01-01',
      });
      expect(prisma.dataUseConsent.upsert).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledTimes(1);
    });

    it('re-granting after a revocation clears revokedAt', async () => {
      prisma.dataUseConsent.findUnique.mockResolvedValue(
        consent({ status: 'revoked', revokedAt: T0 }),
      );
      await service.update('tenant-a', owner, {
        enabled: true,
        termsVersion: '2026-10-01',
      });
      expect(
        prisma.dataUseConsent.upsert.mock.calls[0][0].update,
      ).toMatchObject({
        status: 'granted',
        revokedAt: null,
      });
    });
  });

  describe('update: revoking', () => {
    it('marks it revoked with the time, scoped to the tenant, and audits it', async () => {
      prisma.dataUseConsent.findUnique.mockResolvedValue(consent());
      const view = await service.update('tenant-a', owner, { enabled: false });
      expect(prisma.dataUseConsent.update).toHaveBeenCalledWith({
        where: { id: 'c1', tenantId: 'tenant-a' },
        data: { status: 'revoked', revokedAt: T0 },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'data_use.revoked',
          before: { status: 'granted', termsVersion: '2026-10-01' },
          after: { status: 'revoked' },
        }),
        prisma,
      );
      expect(view).toMatchObject({ enabled: false, status: 'revoked' });
    });

    it('turning off what was never on creates no record and no audit entry (it stays the default)', async () => {
      prisma.dataUseConsent.findUnique.mockResolvedValue(null);
      const view = await service.update('tenant-a', owner, { enabled: false });
      expect(prisma.dataUseConsent.upsert).not.toHaveBeenCalled();
      expect(prisma.dataUseConsent.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(view).toMatchObject({ enabled: false, status: 'off' });
    });

    it('revoking twice is a no-op the second time', async () => {
      prisma.dataUseConsent.findUnique.mockResolvedValue(
        consent({ status: 'revoked', revokedAt: T0 }),
      );
      await service.update('tenant-a', owner, { enabled: false });
      expect(prisma.dataUseConsent.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  it('exports nothing: the service exposes no way to read or move conversation data', () => {
    const methods = Object.getOwnPropertyNames(DataUseService.prototype).filter(
      (m) => m !== 'constructor',
    );
    expect(methods.sort()).toEqual(['get', 'update']);
  });
});

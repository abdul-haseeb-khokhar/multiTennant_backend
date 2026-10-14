import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
  prismaError,
} from '../../../test/utils/prisma-mock';
import { AuditService } from '../../audit/audit.service';
import type { AuthUser } from '../../auth/roles';
import { RateLimiter } from '../../common/throttle/rate-limiter';
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { UpgradeRequestsService } from './upgrade-requests.service';

describe('UpgradeRequestsService (J5)', () => {
  let prisma: PrismaMock;
  let subscriptions: { getEffective: jest.Mock };
  let audit: { record: jest.Mock };
  let mail: { sendNow: jest.Mock };
  let config: { get: jest.Mock };
  let service: UpgradeRequestsService;

  const owner: AuthUser = {
    userId: 'u1',
    tenantId: 't1',
    role: 'owner',
    emailVerified: true,
  };
  const proPlan = {
    code: 'pro',
    name: 'Pro',
    visibility: 'public',
    active: true,
  };
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    tenantId: 't1',
    requestedPlanCode: 'pro',
    note: null,
    requestedBy: 'u1',
    status: 'pending',
    handledBy: null,
    handledAt: null,
    handledNote: null,
    createdAt: new Date('2026-10-13T00:00:00Z'),
    updatedAt: new Date('2026-10-13T00:00:00Z'),
    ...over,
  });

  beforeEach(() => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    subscriptions = {
      getEffective: jest
        .fn()
        .mockResolvedValue({ planCode: 'starter', planName: 'Starter' }),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    mail = { sendNow: jest.fn().mockResolvedValue({ delivery: 'sent' }) };
    config = {
      get: jest.fn((key: string) =>
        key === 'PLATFORM_ADMIN_NOTIFY_EMAIL' ? 'ops@platform.test' : undefined,
      ),
    };
    service = new UpgradeRequestsService(
      prisma as unknown as PrismaService,
      subscriptions as unknown as SubscriptionService,
      audit as unknown as AuditService,
      mail as unknown as MailService,
      config as never,
      new RateLimiter(),
    );
    prisma.plan.findUnique.mockResolvedValue(proPlan);
    prisma.tenant.findUnique.mockResolvedValue({ name: 'Acme' });
    prisma.upgradeRequest.findFirst.mockResolvedValue(null);
    prisma.upgradeRequest.create.mockImplementation(({ data }) =>
      Promise.resolve(row({ ...data })),
    );
  });

  describe('request', () => {
    it('stores a pending request for the tenant of the token, audits it and emails the platform address', async () => {
      const res = await service.request(owner, {
        planCode: 'pro',
        note: '  we need more seats ',
      });

      expect(prisma.upgradeRequest.create).toHaveBeenCalledWith({
        data: {
          tenantId: 't1',
          requestedPlanCode: 'pro',
          note: 'we need more seats',
          requestedBy: 'u1',
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: 't1',
          actor: { userId: 'u1', role: 'owner' },
          action: 'upgrade.requested',
          targetType: 'upgrade_request',
          targetId: 'r1',
          before: { planCode: 'starter' },
          after: { requestedPlanCode: 'pro' },
        },
        prisma,
      );
      expect(mail.sendNow).toHaveBeenCalledWith({
        to: 'ops@platform.test',
        template: 'upgrade-request',
        locale: 'en',
        params: {
          tenantName: 'Acme',
          currentPlan: 'Starter',
          requestedPlan: 'Pro',
          note: 'we need more seats',
        },
      });
      expect(res).toMatchObject({
        id: 'r1',
        requestedPlanCode: 'pro',
        requestedPlanName: 'Pro',
        status: 'pending',
        replacedPending: false,
        notification: 'sent',
      });
      // internals of the row that the owner does not need stay out
      expect(res).not.toHaveProperty('requestedBy');
      expect(res).not.toHaveProperty('handledBy');
    });

    it('a second request while one is pending REPLACES it: no second row, still audited', async () => {
      prisma.upgradeRequest.findFirst.mockResolvedValue(
        row({ requestedPlanCode: 'enterprise' }),
      );
      prisma.upgradeRequest.update.mockResolvedValue(row());
      const res = await service.request(owner, { planCode: 'pro' });

      expect(prisma.upgradeRequest.create).not.toHaveBeenCalled();
      expect(prisma.upgradeRequest.update).toHaveBeenCalledWith({
        where: { id: 'r1', tenantId: 't1' },
        data: { requestedPlanCode: 'pro', note: null, requestedBy: 'u1' },
      });
      expect(prisma.upgradeRequest.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 't1', status: 'pending' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          before: { requestedPlanCode: 'enterprise' },
          after: { requestedPlanCode: 'pro' },
        }),
        prisma,
      );
      expect(res.replacedPending).toBe(true);
    });

    it('two first requests at the same moment: the unique index refuses one, which then replaces the other', async () => {
      prisma.upgradeRequest.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(row());
      prisma.upgradeRequest.create.mockRejectedValueOnce(prismaError('P2002'));
      prisma.upgradeRequest.update.mockResolvedValue(row());
      const res = await service.request(owner, { planCode: 'pro' });
      expect(res.replacedPending).toBe(true);
    });

    it('an empty note is stored as null', async () => {
      await service.request(owner, { planCode: 'pro', note: '   ' });
      expect(
        prisma.upgradeRequest.create.mock.calls[0][0].data.note,
      ).toBeNull();
      expect(mail.sendNow.mock.calls[0][0].params.note).toBe('-');
    });

    it.each([
      ['unknown plan', null],
      [
        'hidden plan (Starter is not for sale)',
        { ...proPlan, visibility: 'hidden' },
      ],
      ['retired plan', { ...proPlan, active: false }],
    ])(
      '404 PLAN_NOT_FOUND for a %s, nothing stored or sent',
      async (_n, plan) => {
        prisma.plan.findUnique.mockResolvedValue(plan);
        await expect(
          service.request(owner, { planCode: 'x' }),
        ).rejects.toMatchObject({
          status: 404,
          response: { code: 'PLAN_NOT_FOUND' },
        });
        expect(prisma.upgradeRequest.create).not.toHaveBeenCalled();
        expect(mail.sendNow).not.toHaveBeenCalled();
      },
    );

    it('409 ALREADY_ON_PLAN when the workspace is on that plan now', async () => {
      subscriptions.getEffective.mockResolvedValue({
        planCode: 'pro',
        planName: 'Pro',
      });
      await expect(
        service.request(owner, { planCode: 'pro' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'ALREADY_ON_PLAN' },
      });
      expect(prisma.upgradeRequest.create).not.toHaveBeenCalled();
    });

    it('404 when the tenant has no subscription at all', async () => {
      subscriptions.getEffective.mockResolvedValue(null);
      await expect(
        service.request(owner, { planCode: 'pro' }),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'SUBSCRIPTION_NOT_FOUND' },
      });
    });

    it('without PLATFORM_ADMIN_NOTIFY_EMAIL the request is stored and no mail is attempted', async () => {
      config.get.mockReturnValue(undefined);
      const res = await service.request(owner, { planCode: 'pro' });
      expect(res.notification).toBe('not_configured');
      expect(mail.sendNow).not.toHaveBeenCalled();
      expect(prisma.upgradeRequest.create).toHaveBeenCalled();
    });

    it.each(['failed', 'skipped'])(
      'a mail that is %s never undoes the request, and is reported',
      async (delivery) => {
        mail.sendNow.mockResolvedValue({ delivery });
        const res = await service.request(owner, { planCode: 'pro' });
        expect(res.notification).toBe(delivery);
        expect(res.id).toBe('r1');
      },
    );

    it('is limited to five per hour per tenant (429), and other tenants have their own count', async () => {
      for (let i = 0; i < 5; i++) {
        await service.request(owner, { planCode: 'pro' });
      }
      await expect(
        service.request(owner, { planCode: 'pro' }),
      ).rejects.toMatchObject({ status: 429 });
      await expect(
        service.request({ ...owner, tenantId: 't2' }, { planCode: 'pro' }),
      ).resolves.toBeDefined();
    });
  });

  describe('latest', () => {
    it("reads only the tenant's own requests", async () => {
      prisma.upgradeRequest.findFirst.mockResolvedValue({
        ...row({ status: 'handled', handledNote: 'done' }),
        plan: { name: 'Pro' },
      });
      const { request } = await service.latest('t1');
      expect(request).toMatchObject({
        id: 'r1',
        status: 'handled',
        handledNote: 'done',
        requestedPlanName: 'Pro',
      });
      expect(prisma.upgradeRequest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 't1' } }),
      );
    });

    it('null when there never was one', async () => {
      await expect(service.latest('t1')).resolves.toEqual({ request: null });
    });
  });

  describe('list (platform admin)', () => {
    beforeEach(() => {
      prisma.upgradeRequest.findMany.mockResolvedValue([
        {
          ...row(),
          plan: { name: 'Pro' },
          tenant: { id: 't1', name: 'Acme', slug: 'acme' },
        },
      ]);
      prisma.upgradeRequest.count.mockResolvedValue(1);
      prisma.subscription.findMany.mockResolvedValue([
        { tenantId: 't1', planCode: 'starter' },
      ]);
      prisma.tenantUser.findMany.mockResolvedValue([
        { id: 'u1', tenantId: 't1', email: 'owner@acme.com' },
      ]);
    });

    it('pages newest first, filtered by status, with tenant, current plan and requester', async () => {
      const res = await service.list({ status: 'pending', skip: 0, take: 10 });
      expect(prisma.upgradeRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'pending' },
          skip: 0,
          take: 10,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }),
      );
      expect(res).toMatchObject({ total: 1, skip: 0, take: 10 });
      expect(res.data[0]).toMatchObject({
        id: 'r1',
        tenant: { id: 't1', name: 'Acme', slug: 'acme' },
        currentPlanCode: 'starter',
        requestedPlanCode: 'pro',
        requestedByEmail: 'owner@acme.com',
        handledBy: null,
      });
    });

    it('lists every status when no filter is given', async () => {
      await service.list({});
      expect(prisma.upgradeRequest.findMany.mock.calls[0][0].where).toEqual({});
    });

    it("looks the requester up inside the request's own tenant only", async () => {
      await service.list({});
      expect(prisma.tenantUser.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['u1'] }, tenantId: { in: ['t1'] } },
        select: { id: true, tenantId: true, email: true },
      });
    });
  });

  describe('handle (platform admin)', () => {
    beforeEach(() => {
      prisma.upgradeRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.upgradeRequest.findUnique.mockResolvedValue({
        ...row({ status: 'handled' }),
        plan: { name: 'Pro' },
      });
    });

    it('moves a pending request to handled in one transaction with an audit entry in the tenant log', async () => {
      const res = await service.handle('admin-1', 'r1', {
        status: 'handled',
        note: ' activated ',
      });
      expect(prisma.upgradeRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'r1', status: 'pending' },
        data: {
          status: 'handled',
          handledBy: 'admin-1',
          handledAt: expect.any(Date),
          handledNote: 'activated',
        },
      });
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: 't1',
          actor: { userId: 'admin-1', role: 'platform_admin' },
          action: 'upgrade.handled',
          targetType: 'upgrade_request',
          targetId: 'r1',
          before: { status: 'pending' },
          after: { status: 'handled', requestedPlanCode: 'pro' },
        },
        prisma,
      );
      expect(res).toMatchObject({ id: 'r1', requestedPlanName: 'Pro' });
    });

    it('409 UPGRADE_REQUEST_ALREADY_HANDLED when it is not pending any more, with no audit entry', async () => {
      prisma.upgradeRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.handle('admin-1', 'r1', { status: 'declined' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'UPGRADE_REQUEST_ALREADY_HANDLED' },
      });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404 UPGRADE_REQUEST_NOT_FOUND for an unknown id', async () => {
      prisma.upgradeRequest.updateMany.mockResolvedValue({ count: 0 });
      prisma.upgradeRequest.findUnique.mockResolvedValue(null);
      await expect(
        service.handle('admin-1', 'nope', { status: 'handled' }),
      ).rejects.toMatchObject({
        status: 404,
        response: { code: 'UPGRADE_REQUEST_NOT_FOUND' },
      });
    });
  });
});

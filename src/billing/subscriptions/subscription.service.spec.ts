import { Test, TestingModule } from '@nestjs/testing';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
  prismaError,
} from '../../../test/utils/prisma-mock';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { FakeClock, Clock } from '../clock';
import { InvoiceNumberService } from './invoice-number.service';
import { BillingEventInput, SubscriptionService } from './subscription.service';

const planRow = (over: Record<string, unknown> & { code: string }) => ({
  name: over.code,
  visibility: 'public',
  priceMinor: 0,
  currency: 'PKR',
  interval: 'none',
  yearlyPriceMinor: null,
  durationDays: null,
  fallbackPlanCode: null,
  entitlements: { seats: 3 },
  providerPriceIds: {},
  active: true,
  sortOrder: 0,
  ...over,
});

const PLAN_ROWS = [
  planRow({ code: 'starter', durationDays: 15, fallbackPlanCode: 'free' }),
  planRow({ code: 'free' }),
  planRow({
    code: 'pro',
    priceMinor: 1_999_900,
    interval: 'month',
    fallbackPlanCode: 'free',
  }),
];

const T0 = new Date('2026-10-07T00:00:00.000Z');

const subRow = (over: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  tenantId: 'tenant-a',
  planCode: 'starter',
  status: 'active',
  interval: 'none',
  currentPeriodStart: T0,
  currentPeriodEnd: new Date('2026-10-22T00:00:00.000Z'),
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  statusBeforeSuspension: null,
  closedAt: null,
  entitlementsOverride: null,
  provider: 'manual',
  providerCustomerId: null,
  providerSubscriptionId: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const admin = { userId: 'admin-1', role: 'platform_admin' };

const payment = (over: Record<string, unknown> = {}): BillingEventInput =>
  ({
    tenantId: 'tenant-a',
    type: 'payment.succeeded',
    source: 'manual',
    provider: 'manual',
    providerEventId: null,
    actor: admin,
    payload: {
      planCode: 'pro',
      amountMinor: 1_999_900,
      currency: 'PKR',
      method: 'bank_transfer',
      reference: 'TX-1',
    },
    ...over,
  }) as BillingEventInput;

describe('SubscriptionService', () => {
  let service: SubscriptionService;
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let clock: FakeClock;
  let invoiceNumbers: { next: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    clock = new FakeClock(T0);
    invoiceNumbers = { next: jest.fn().mockResolvedValue('INV-2026-000001') };
    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve(
        String(strings[0]).includes('pg_try_advisory')
          ? [{ locked: true }]
          : [{ id: 'sub-1' }],
      ),
    );
    prisma.plan.findMany.mockResolvedValue(PLAN_ROWS);
    prisma.subscription.findUnique.mockResolvedValue(subRow());
    prisma.subscription.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...subRow(), ...data }),
    );
    prisma.invoice.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'inv-1', ...data }),
    );
    prisma.billingEvent.findFirst.mockResolvedValue(null);
    prisma.billingEvent.create.mockResolvedValue({});
    prisma.tenant.update.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: Clock, useValue: clock },
        { provide: InvoiceNumberService, useValue: invoiceNumbers },
      ],
    }).compile();
    service = module.get(SubscriptionService);
  });

  describe('applyEvent: a payment', () => {
    it('does everything in ONE transaction: new state, invoice, billing event, audit entry and the tenant mirrors', async () => {
      const result = await service.applyEvent(payment());

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ applied: true, duplicate: false });

      expect(prisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-1', tenantId: 'tenant-a' },
        data: expect.objectContaining({
          planCode: 'pro',
          status: 'active',
          interval: 'month',
          currentPeriodStart: T0,
          currentPeriodEnd: new Date('2026-11-07T00:00:00.000Z'),
        }),
      });
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 'tenant-a' },
        data: { plan: 'pro', status: 'active' },
      });
      expect(prisma.invoice.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          number: 'INV-2026-000001',
          tenantId: 'tenant-a',
          subscriptionId: 'sub-1',
          planCode: 'pro',
          amountMinor: 1_999_900,
          currency: 'PKR',
          status: 'paid',
          method: 'bank_transfer',
          reference: 'TX-1',
          recordedBy: 'admin-1',
          paidAt: T0,
        }),
      });
      expect(prisma.billingEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          type: 'payment.succeeded',
          source: 'manual',
          provider: 'manual',
          providerEventId: null,
          payload: expect.objectContaining({
            amountMinor: 1_999_900,
            invoiceNumber: 'INV-2026-000001',
          }),
        }),
      });
      // The audit entry shares the transaction (second argument is the transaction client).
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-a',
          actor: admin,
          action: 'subscription.payment_recorded',
          targetType: 'subscription',
          targetId: 'sub-1',
          before: expect.objectContaining({ planCode: 'starter' }),
          after: expect.objectContaining({
            planCode: 'pro',
            invoiceNumber: 'INV-2026-000001',
          }),
        }),
        prisma,
      );
    });

    it('scopes every read and write to the tenant', async () => {
      await service.applyEvent(payment());
      expect(prisma.subscription.findUnique).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a' },
      });
      expect(prisma.invoice.create.mock.calls[0][0].data.tenantId).toBe(
        'tenant-a',
      );
      for (const [args] of prisma.billingEvent.create.mock.calls) {
        expect(args.data.tenantId).toBe('tenant-a');
      }
      for (const [entry] of audit.record.mock.calls) {
        expect(entry.tenantId).toBe('tenant-a');
      }
    });

    it('never puts a secret-looking key in the audit entry or the event payload', async () => {
      await service.applyEvent(payment());
      const text = JSON.stringify([
        audit.record.mock.calls.map(([entry]) => entry),
        prisma.billingEvent.create.mock.calls,
      ]);
      expect(text).not.toMatch(/password|token|secret|hash|link/i);
    });

    it('writes nothing at all when the state machine refuses the event', async () => {
      prisma.subscription.findUnique.mockResolvedValue(
        subRow({ status: 'suspended', statusBeforeSuspension: 'active' }),
      );
      await expect(service.applyEvent(payment())).rejects.toMatchObject({
        status: 409,
        response: { code: 'INVALID_SUBSCRIPTION_STATE' },
      });
      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(prisma.invoice.create).not.toHaveBeenCalled();
      expect(prisma.billingEvent.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('404 SUBSCRIPTION_NOT_FOUND when the tenant has no subscription', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(service.applyEvent(payment())).rejects.toMatchObject({
        status: 404,
        response: { code: 'SUBSCRIPTION_NOT_FOUND' },
      });
    });

    it('applies a transition that is already due BEFORE the payment, recording it as the system', async () => {
      // Starter ended 5 days ago but the job has not run.
      clock.set('2026-10-27T00:00:00.000Z');
      await service.applyEvent(payment());

      const types = prisma.billingEvent.create.mock.calls.map(
        ([a]) => a.data.type,
      );
      expect(types).toEqual(['period.ended', 'payment.succeeded']);
      expect(prisma.billingEvent.create.mock.calls[0][0].data).toMatchObject({
        source: 'system',
        provider: null,
        providerEventId: null,
      });
      const actors = audit.record.mock.calls.map(([e]) => e.actor.role);
      expect(actors).toEqual(['system', 'platform_admin']);
      // Net result: Pro from now.
      expect(prisma.tenant.update).toHaveBeenCalledTimes(1);
      expect(prisma.tenant.update.mock.calls[0][0].data).toEqual({
        plan: 'pro',
        status: 'active',
      });
    });
  });

  describe('applyEvent: idempotency', () => {
    const withId = payment({ providerEventId: 'tenant-a:key-1' });

    it('applying the same provider event id twice changes nothing the second time', async () => {
      const first = await service.applyEvent(withId);
      expect(first).toMatchObject({ applied: true, duplicate: false });
      expect(prisma.billingEvent.create.mock.calls[0][0].data).toMatchObject({
        provider: 'manual',
        providerEventId: 'tenant-a:key-1',
      });

      // The event now exists.
      prisma.billingEvent.findFirst.mockResolvedValue({ id: 'ev-1' });
      jest.clearAllMocks();
      mockTransaction(prisma);
      prisma.billingEvent.findFirst.mockResolvedValue({ id: 'ev-1' });
      prisma.$queryRaw.mockResolvedValue([{ id: 'sub-1' }]);

      const second = await service.applyEvent(withId);
      expect(second).toEqual({
        applied: false,
        duplicate: true,
        subscription: null,
        invoice: null,
      });
      expect(prisma.billingEvent.findFirst).toHaveBeenCalledWith({
        where: {
          tenantId: 'tenant-a',
          provider: 'manual',
          providerEventId: 'tenant-a:key-1',
        },
        select: { id: true },
      });
      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(prisma.invoice.create).not.toHaveBeenCalled();
      expect(prisma.billingEvent.create).not.toHaveBeenCalled();
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('treats a unique-index collision from a concurrent delivery as a duplicate', async () => {
      prisma.billingEvent.findFirst
        .mockResolvedValueOnce(null) // lookup inside the transaction
        .mockResolvedValueOnce({ id: 'ev-1' }); // lookup after the P2002
      prisma.billingEvent.create.mockRejectedValue(prismaError('P2002'));
      await expect(service.applyEvent(withId)).resolves.toMatchObject({
        applied: false,
        duplicate: true,
      });
    });

    it('rethrows a P2002 that is not a duplicate event', async () => {
      prisma.billingEvent.create.mockRejectedValue(prismaError('P2002'));
      await expect(service.applyEvent(withId)).rejects.toBeDefined();
    });

    it('does no event lookup for events without an id (admin commands without an idempotency key)', async () => {
      await service.applyEvent(payment());
      expect(prisma.billingEvent.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('applyEvent: other events', () => {
    it('a no-op event (already in the target state) writes nothing and does not notify', async () => {
      const listener = jest.fn();
      service.onChange(listener);
      prisma.subscription.findUnique.mockResolvedValue(
        subRow({ planCode: 'free', currentPeriodEnd: null }),
      );
      const result = await service.applyEvent({
        tenantId: 'tenant-a',
        type: 'plan.changed',
        payload: { planCode: 'free' },
        source: 'manual',
        actor: admin,
      });
      expect(result.applied).toBe(false);
      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(prisma.billingEvent.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });

    it('suspending writes the mirror, an event and the tenant.suspended audit entry', async () => {
      await service.applyEvent({
        tenantId: 'tenant-a',
        type: 'tenant.suspended',
        payload: {},
        source: 'manual',
        actor: admin,
      });
      expect(prisma.subscription.update.mock.calls[0][0].data).toMatchObject({
        status: 'suspended',
        statusBeforeSuspension: 'active',
      });
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 'tenant-a' },
        data: { plan: 'starter', status: 'suspended' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'tenant.suspended', actor: admin }),
        prisma,
      );
    });

    it('payment.failed is recorded (event + audit) without touching the subscription or the mirrors', async () => {
      prisma.subscription.findUnique.mockResolvedValue(
        subRow({
          planCode: 'pro',
          currentPeriodEnd: new Date('2026-11-07T00:00:00.000Z'),
        }),
      );
      await service.applyEvent({
        tenantId: 'tenant-a',
        type: 'payment.failed',
        payload: { reason: 'declined' },
        source: 'provider',
        provider: 'acme-pay',
        providerEventId: 'evt_1',
      });
      expect(prisma.billingEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.billingEvent.create.mock.calls[0][0].data).toMatchObject({
        type: 'payment.failed',
        source: 'provider',
        provider: 'acme-pay',
        providerEventId: 'evt_1',
      });
      expect(audit.record.mock.calls[0][0].actor).toEqual({
        userId: null,
        role: 'system',
      });
      expect(prisma.subscription.update).not.toHaveBeenCalled();
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it('a bare period.ended with nothing due records nothing', async () => {
      const result = await service.applyEvent({
        tenantId: 'tenant-a',
        type: 'period.ended',
        payload: {},
        source: 'system',
        actor: { role: 'system' },
      });
      expect(result.applied).toBe(false);
      expect(prisma.billingEvent.create).not.toHaveBeenCalled();
    });

    it('a bare period.ended applies Starter -> Free when due', async () => {
      clock.set('2026-10-22T00:00:00.000Z');
      const result = await service.applyEvent({
        tenantId: 'tenant-a',
        type: 'period.ended',
        payload: {},
        source: 'system',
        actor: { role: 'system' },
      });
      expect(result.applied).toBe(true);
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 'tenant-a' },
        data: { plan: 'free', status: 'active' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription.period_ended',
          actor: { userId: null, role: 'system' },
        }),
        prisma,
      );
    });
  });

  describe('onChange', () => {
    it('notifies listeners after a successful change, and not after a failure', async () => {
      const listener = jest.fn();
      service.onChange(listener);
      await service.applyEvent(payment());
      expect(listener).toHaveBeenCalledWith('tenant-a');

      listener.mockClear();
      prisma.subscription.findUnique.mockResolvedValue(
        subRow({ status: 'closed' }),
      );
      await expect(service.applyEvent(payment())).rejects.toBeDefined();
      expect(listener).not.toHaveBeenCalled();
    });

    it('a failing listener cannot break the change', async () => {
      service.onChange(() => {
        throw new Error('listener bug');
      });
      await expect(service.applyEvent(payment())).resolves.toMatchObject({
        applied: true,
      });
    });
  });

  describe('getEffective (request-time correctness)', () => {
    const withPlan = (row: Record<string, unknown>, planCode = 'starter') => ({
      ...row,
      plan: PLAN_ROWS.find((p) => p.code === planCode),
    });

    it('returns null for a tenant without a subscription', async () => {
      prisma.subscription.findUnique.mockResolvedValue(null);
      await expect(service.getEffective('tenant-a')).resolves.toBeNull();
    });

    it('reads one row and writes nothing while nothing is due', async () => {
      clock.set('2026-10-10T00:00:00.000Z');
      prisma.subscription.findUnique.mockResolvedValue(withPlan(subRow()));
      const effective = await service.getEffective('tenant-a');
      expect(effective).toMatchObject({
        planCode: 'starter',
        status: 'active',
        daysLeft: 12,
      });
      expect(prisma.subscription.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('treats an expired Starter as Free even though the job never ran', async () => {
      clock.set('2026-10-25T00:00:00.000Z');
      prisma.subscription.findUnique
        .mockResolvedValueOnce(withPlan(subRow()))
        // applyEvent's own read inside the transaction
        .mockResolvedValueOnce(subRow())
        // the re-read after the transition
        .mockResolvedValueOnce(
          withPlan(
            subRow({
              planCode: 'free',
              currentPeriodStart: new Date('2026-10-22T00:00:00.000Z'),
              currentPeriodEnd: null,
            }),
            'free',
          ),
        );
      const effective = await service.getEffective('tenant-a');
      expect(effective).toMatchObject({
        planCode: 'free',
        status: 'active',
        daysLeft: null,
      });
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 'tenant-a' },
        data: { plan: 'free', status: 'active' },
      });
    });
  });

  describe('createStarter (signup)', () => {
    it('creates a 15-day Starter subscription from the clock, sets the mirrors and records event + audit in the given transaction', async () => {
      prisma.plan.findUnique.mockResolvedValue(PLAN_ROWS[0]);
      prisma.subscription.create.mockImplementation(({ data }) =>
        Promise.resolve(subRow(data)),
      );
      await service.createStarter(prisma as never, 'tenant-a');

      expect(prisma.plan.findUnique).toHaveBeenCalledWith({
        where: { code: 'starter' },
      });
      expect(prisma.subscription.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: 'tenant-a',
          planCode: 'starter',
          status: 'active',
          currentPeriodStart: T0,
          currentPeriodEnd: new Date('2026-10-22T00:00:00.000Z'),
          provider: 'manual',
        }),
      });
      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: 'tenant-a' },
        data: { plan: 'starter', status: 'trial' },
      });
      expect(prisma.billingEvent.create.mock.calls[0][0].data).toMatchObject({
        tenantId: 'tenant-a',
        type: 'subscription.created',
        source: 'system',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'subscription.created',
          actor: { userId: null, role: 'system' },
        }),
        prisma,
      );
      // It does not open its own transaction: it runs inside the caller's.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('fails loudly when the Starter plan row is missing', async () => {
      prisma.plan.findUnique.mockResolvedValue(null);
      await expect(
        service.createStarter(prisma as never, 'tenant-a'),
      ).rejects.toThrow(/starter/);
    });
  });

  describe('processDueTransitions (the job)', () => {
    it('does nothing when another instance holds the advisory lock', async () => {
      prisma.$queryRaw.mockResolvedValue([{ locked: false }]);
      await expect(service.processDueTransitions()).resolves.toEqual({
        processed: 0,
        skipped: true,
      });
      expect(prisma.subscription.findMany).not.toHaveBeenCalled();
    });

    it('applies the due transition of every due tenant and stops when none are left', async () => {
      clock.set('2026-10-25T00:00:00.000Z');
      prisma.subscription.findMany
        .mockResolvedValueOnce([
          { tenantId: 'tenant-a' },
          { tenantId: 'tenant-b' },
        ])
        .mockResolvedValueOnce([]);
      prisma.subscription.findUnique.mockImplementation(({ where }) =>
        Promise.resolve(subRow({ tenantId: where.tenantId })),
      );
      const result = await service.processDueTransitions();
      expect(result).toEqual({ processed: 2, skipped: false });
      const mirrored = prisma.tenant.update.mock.calls.map(([a]) => a.where.id);
      expect(mirrored).toEqual(['tenant-a', 'tenant-b']);
      // Only live subscriptions with something due are looked at.
      expect(prisma.subscription.findMany.mock.calls[0][0]).toMatchObject({
        where: {
          status: { in: ['active', 'canceled', 'past_due'] },
        },
      });
    });

    it('survives a failing tenant, continues with the others and does not loop on it', async () => {
      clock.set('2026-10-25T00:00:00.000Z');
      prisma.subscription.findMany.mockResolvedValue([
        { tenantId: 'tenant-bad' },
        { tenantId: 'tenant-b' },
      ]);
      prisma.subscription.findUnique.mockImplementation(({ where }) =>
        where.tenantId === 'tenant-bad'
          ? Promise.reject(new Error('db hiccup'))
          : Promise.resolve(subRow({ tenantId: where.tenantId })),
      );
      const result = await service.processDueTransitions();
      expect(result.processed).toBe(1);
      expect(prisma.subscription.findMany).toHaveBeenCalledTimes(2);
    });
  });
});

import { Test } from '@nestjs/testing';
import { createPrismaMock, PrismaMock } from '../../../test/utils/prisma-mock';
import { PrismaService } from '../../prisma/prisma.service';
import { OverageService } from '../overage.service';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { TenantBillingService } from './tenant-billing.service';

const T0 = new Date('2026-10-07T00:00:00.000Z');

const effective = {
  tenantId: 'tenant-a',
  subscriptionId: 'sub-1',
  planCode: 'pro',
  planName: 'Pro',
  status: 'active',
  interval: 'month',
  currentPeriodStart: T0,
  currentPeriodEnd: new Date('2026-11-07T00:00:00.000Z'),
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  daysLeft: 31,
  graceDaysLeft: null,
  provider: 'manual',
  currency: 'PKR',
  overageEnabled: true,
  entitlements: { seats: 10, overageConversationMinor: 1500 },
  entitlementsOverride: { seats: 25 },
  nextTransitionAt: new Date('2026-11-07T00:00:00.000Z'),
};

const invoice = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1',
  number: 'INV-2026-000001',
  tenantId: 'tenant-a',
  subscriptionId: 'sub-1',
  planCode: 'pro',
  amountMinor: 1_999_900,
  currency: 'PKR',
  status: 'paid',
  periodStart: T0,
  periodEnd: new Date('2026-11-07T00:00:00.000Z'),
  method: 'bank_transfer',
  reference: 'TX-1',
  recordedBy: 'admin-1',
  providerInvoiceId: 'pi_1',
  paidAt: T0,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

describe('TenantBillingService', () => {
  let service: TenantBillingService;
  let prisma: PrismaMock;
  let subscriptions: { getEffective: jest.Mock; setOverageEnabled: jest.Mock };
  let overage: { conversationSummary: jest.Mock };

  beforeEach(async () => {
    prisma = createPrismaMock();
    subscriptions = {
      getEffective: jest.fn().mockResolvedValue(effective),
      setOverageEnabled: jest.fn().mockResolvedValue({ changed: true }),
    };
    overage = {
      conversationSummary: jest.fn().mockResolvedValue({
        period: 'month',
        periodStart: new Date('2026-10-01T00:00:00.000Z'),
        included: 1500,
        used: 1620,
        overage: {
          available: true,
          enabled: true,
          priceMinor: 1500,
          currency: 'PKR',
          count: 120,
          amountMinor: 180_000,
        },
      }),
    };
    prisma.invoice.findMany.mockResolvedValue([invoice()]);
    prisma.invoice.count.mockResolvedValue(1);
    prisma.billingEvent.findMany.mockResolvedValue([
      {
        id: 'ev-1',
        tenantId: 'tenant-a',
        type: 'payment.succeeded',
        source: 'manual',
        provider: 'manual',
        providerEventId: 'tenant-a:k',
        payload: { amountMinor: 1_999_900 },
        createdAt: T0,
      },
    ]);
    prisma.billingEvent.count.mockResolvedValue(1);
    const module = await Test.createTestingModule({
      providers: [
        TenantBillingService,
        { provide: PrismaService, useValue: prisma },
        { provide: SubscriptionService, useValue: subscriptions },
        { provide: OverageService, useValue: overage },
      ],
    }).compile();
    service = module.get(TenantBillingService);
  });

  describe('getForTenant (owner view)', () => {
    it('returns the summary and the tenant invoices, reading only this tenant', async () => {
      const result = await service.getForTenant('tenant-a', {});
      expect(subscriptions.getEffective).toHaveBeenCalledWith('tenant-a');
      expect(prisma.invoice.findMany).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a' },
        skip: 0,
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(prisma.invoice.count).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-a' },
      });
      expect(result.subscription).toMatchObject({
        planCode: 'pro',
        status: 'active',
        daysLeft: 31,
        limits: { seats: 10 },
      });
      expect(result.invoices).toMatchObject({ total: 1, skip: 0, take: 20 });
      expect(result.invoices.data[0]).toMatchObject({
        number: 'INV-2026-000001',
        amountMinor: 1_999_900,
        currency: 'PKR',
        status: 'paid',
      });
    });

    it('does not leak admin-only columns: who recorded it, provider ids, the override, the billing event log', async () => {
      const result = await service.getForTenant('tenant-a', {});
      const text = JSON.stringify(result);
      expect(text).not.toMatch(/recordedBy|admin-1|providerInvoiceId|pi_1/);
      expect(text).not.toMatch(/entitlementsOverride|provider"|subscriptionId/);
      expect(result).not.toHaveProperty('events');
    });

    it('pages invoices with skip and take (capped at 100)', async () => {
      await service.getForTenant('tenant-a', { skip: 5, take: 500 });
      expect(prisma.invoice.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 5, take: 100 }),
      );
    });

    it('404 SUBSCRIPTION_NOT_FOUND when the tenant has none', async () => {
      subscriptions.getEffective.mockResolvedValue(null);
      await expect(service.getForTenant('tenant-a', {})).rejects.toMatchObject({
        status: 404,
        response: { code: 'SUBSCRIPTION_NOT_FOUND' },
      });
    });
  });

  describe('overage (J6)', () => {
    it('shows the setting and the period figures: included, used, overage count and amount', async () => {
      const result = await service.getForTenant('tenant-a', {});
      expect(result.subscription.overage).toEqual({
        available: true,
        enabled: true,
        priceMinor: 1500,
        currency: 'PKR',
      });
      expect(result.usage.conversations).toEqual({
        period: 'month',
        periodStart: new Date('2026-10-01T00:00:00.000Z'),
        included: 1500,
        used: 1620,
        overageCount: 120,
        overageAmountMinor: 180_000,
        overagePriceMinor: 1500,
        currency: 'PKR',
      });
      expect(overage.conversationSummary).toHaveBeenCalledWith(effective);
    });

    it('the platform admin view carries the same figures', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-a' });
      const result = await service.getForAdmin('tenant-a', {});
      expect(result.usage.conversations).toMatchObject({
        used: 1620,
        overageCount: 120,
        overageAmountMinor: 180_000,
      });
      expect(result.subscription.overage.enabled).toBe(true);
    });

    it('updateSettings stores the choice for the actor and answers with the new summary', async () => {
      subscriptions.getEffective.mockResolvedValue({
        ...effective,
        overageEnabled: false,
      });
      const result = await service.updateSettings(
        'tenant-a',
        { userId: 'owner-1', tenantId: 'tenant-a', role: 'owner' } as never,
        { overageEnabled: false },
      );
      expect(subscriptions.setOverageEnabled).toHaveBeenCalledWith(
        'tenant-a',
        false,
        { userId: 'owner-1', role: 'owner' },
      );
      expect(result.subscription.overage).toMatchObject({
        available: true,
        enabled: false,
      });
      expect(result.usage.conversations.overageCount).toBe(120);
    });
  });

  describe('getForAdmin (platform admin view)', () => {
    it('adds ids, the override, who recorded each invoice and the billing event log', async () => {
      prisma.tenant.findUnique.mockResolvedValue({ id: 'tenant-a' });
      const result = await service.getForAdmin('tenant-a', {});
      expect(result.subscription).toMatchObject({
        id: 'sub-1',
        provider: 'manual',
        entitlementsOverride: { seats: 25 },
      });
      expect(result.invoices.data[0]).toMatchObject({
        recordedBy: 'admin-1',
        providerInvoiceId: 'pi_1',
      });
      expect(result.events).toMatchObject({ total: 1 });
      expect(result.events.data[0]).toMatchObject({
        type: 'payment.succeeded',
        source: 'manual',
      });
      expect(prisma.billingEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 'tenant-a' } }),
      );
    });

    it('404 TENANT_NOT_FOUND for an unknown tenant', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      await expect(service.getForAdmin('nope', {})).rejects.toMatchObject({
        status: 404,
        response: { code: 'TENANT_NOT_FOUND' },
      });
      expect(subscriptions.getEffective).not.toHaveBeenCalled();
    });
  });
});

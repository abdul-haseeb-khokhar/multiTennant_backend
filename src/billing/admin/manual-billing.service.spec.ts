import { Test } from '@nestjs/testing';
import { BillingProviders } from '../providers/billing-providers';
import { ManualProvider } from '../providers/manual.provider';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { TenantBillingService } from '../tenant/tenant-billing.service';
import { ManualBillingService } from './manual-billing.service';

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
  entitlements: { seats: 10 },
  entitlementsOverride: null,
  nextTransitionAt: null,
};

const payment = {
  amountMinor: 1_999_900,
  currency: 'PKR',
  method: 'bank_transfer',
  reference: 'TX-1',
};

describe('ManualBillingService (platform admin commands)', () => {
  let service: ManualBillingService;
  let subscriptions: { applyEvent: jest.Mock; getEffective: jest.Mock };
  let billing: { assertTenantExists: jest.Mock };
  let manualCancel: jest.Mock;

  beforeEach(async () => {
    subscriptions = {
      applyEvent: jest.fn().mockResolvedValue({
        applied: true,
        duplicate: false,
        subscription: {},
        invoice: {
          id: 'inv-1',
          number: 'INV-2026-000001',
          tenantId: 'tenant-a',
          planCode: 'pro',
          amountMinor: 1_999_900,
          currency: 'PKR',
          status: 'paid',
          periodStart: T0,
          periodEnd: T0,
          method: 'bank_transfer',
          reference: 'TX-1',
          recordedBy: 'admin-1',
          providerInvoiceId: null,
          paidAt: T0,
          createdAt: T0,
        },
      }),
      getEffective: jest.fn().mockResolvedValue(effective),
    };
    billing = { assertTenantExists: jest.fn().mockResolvedValue(undefined) };
    const manual = new ManualProvider();
    manualCancel = jest.spyOn(manual, 'cancel') as unknown as jest.Mock;
    const module = await Test.createTestingModule({
      providers: [
        ManualBillingService,
        { provide: SubscriptionService, useValue: subscriptions },
        { provide: TenantBillingService, useValue: billing },
        { provide: ManualProvider, useValue: manual },
        { provide: BillingProviders, useValue: new BillingProviders(manual) },
      ],
    }).compile();
    service = module.get(ManualBillingService);
  });

  const appliedEvent = () => subscriptions.applyEvent.mock.calls[0][0];

  it('activate: a payment.succeeded event for the chosen plan, from the platform admin', async () => {
    const result = await service.activate('tenant-a', 'admin-1', {
      ...payment,
      planCode: 'pro',
      interval: 'year',
      idempotencyKey: 'k-1',
    });
    expect(billing.assertTenantExists).toHaveBeenCalledWith('tenant-a');
    expect(appliedEvent()).toEqual({
      tenantId: 'tenant-a',
      type: 'payment.succeeded',
      source: 'manual',
      provider: 'manual',
      providerEventId: 'tenant-a:k-1',
      actor: { userId: 'admin-1', role: 'platform_admin' },
      payload: expect.objectContaining({
        planCode: 'pro',
        amountMinor: 1_999_900,
        currency: 'PKR',
        interval: 'year',
        method: 'bank_transfer',
        reference: 'TX-1',
      }),
    });
    expect(result).toMatchObject({
      applied: true,
      duplicate: false,
      subscription: { planCode: 'pro', status: 'active' },
      invoice: { number: 'INV-2026-000001', amountMinor: 1_999_900 },
    });
  });

  it('activate: validates and passes the entitlement override, rejecting unknown keys with 400', async () => {
    await service.activate('tenant-a', 'admin-1', {
      ...payment,
      planCode: 'enterprise',
      periodEnd: new Date('2027-01-01'),
      entitlementsOverride: { seats: 40, voice: true },
    });
    expect(appliedEvent().payload.entitlementsOverride).toEqual({
      seats: 40,
      voice: true,
    });

    subscriptions.applyEvent.mockClear();
    await expect(
      service.activate('tenant-a', 'admin-1', {
        ...payment,
        planCode: 'enterprise',
        entitlementsOverride: { everything: true },
      }),
    ).rejects.toMatchObject({
      status: 400,
      response: { code: 'VALIDATION_ERROR' },
    });
    expect(subscriptions.applyEvent).not.toHaveBeenCalled();
  });

  it('recordPayment: a renewal is a payment.succeeded without a plan code', async () => {
    await service.recordPayment('tenant-a', 'admin-1', payment);
    expect(appliedEvent()).toMatchObject({
      type: 'payment.succeeded',
      providerEventId: null,
    });
    expect(appliedEvent().payload.planCode).toBeUndefined();
  });

  it('extend and changePlan map to period.extended and plan.changed', async () => {
    await service.extend('tenant-a', 'admin-1', { days: 7 });
    expect(appliedEvent()).toMatchObject({
      type: 'period.extended',
      payload: { days: 7, until: undefined },
    });
    subscriptions.applyEvent.mockClear();
    await service.changePlan('tenant-a', 'admin-1', { planCode: 'free' });
    expect(appliedEvent()).toMatchObject({
      type: 'plan.changed',
      payload: expect.objectContaining({ planCode: 'free' }),
    });
  });

  it('cancel: asks the subscription provider to stop renewals first, then applies subscription.canceled (at period end by default)', async () => {
    await service.cancel('tenant-a', 'admin-1', {});
    expect(manualCancel).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      providerSubscriptionId: null,
      atPeriodEnd: true,
    });
    expect(appliedEvent()).toMatchObject({
      type: 'subscription.canceled',
      payload: { atPeriodEnd: true },
    });

    subscriptions.applyEvent.mockClear();
    await service.cancel('tenant-a', 'admin-1', { atPeriodEnd: false });
    expect(appliedEvent().payload).toEqual({ atPeriodEnd: false });
  });

  it('cancel: an unknown provider on the subscription is refused before anything changes', async () => {
    subscriptions.getEffective.mockResolvedValue({
      ...effective,
      provider: 'somebody-else',
    });
    await expect(
      service.cancel('tenant-a', 'admin-1', {}),
    ).rejects.toMatchObject({ status: 501 });
    expect(subscriptions.applyEvent).not.toHaveBeenCalled();
  });

  it('every command starts by checking that the tenant exists (404 TENANT_NOT_FOUND otherwise)', async () => {
    billing.assertTenantExists.mockRejectedValue(
      Object.assign(new Error('nope'), {
        status: 404,
        response: { code: 'TENANT_NOT_FOUND' },
      }),
    );
    await expect(
      service.activate('nope', 'admin-1', { ...payment, planCode: 'pro' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.recordPayment('nope', 'admin-1', payment),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.extend('nope', 'admin-1', { days: 1 }),
    ).rejects.toBeDefined();
    await expect(
      service.changePlan('nope', 'admin-1', { planCode: 'free' }),
    ).rejects.toBeDefined();
    await expect(service.cancel('nope', 'admin-1', {})).rejects.toBeDefined();
    expect(subscriptions.applyEvent).not.toHaveBeenCalled();
  });

  it('reports a duplicate (same idempotency key) without an invoice', async () => {
    subscriptions.applyEvent.mockResolvedValue({
      applied: false,
      duplicate: true,
      subscription: null,
      invoice: null,
    });
    await expect(
      service.recordPayment('tenant-a', 'admin-1', {
        ...payment,
        idempotencyKey: 'k-1',
      }),
    ).resolves.toMatchObject({
      applied: false,
      duplicate: true,
      invoice: null,
    });
  });
});

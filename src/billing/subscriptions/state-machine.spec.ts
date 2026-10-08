import { GRACE_DAYS } from '../billing.constants';
import { addDays } from '../periods';
import {
  PlanMap,
  PlanSnapshot,
  SubscriptionState,
  advance,
  applyEventToState,
  mirrorOf,
  nextTransitionAt,
} from './state-machine';

const T0 = new Date('2026-10-07T00:00:00.000Z');
const at = (days: number, from: Date = T0) => addDays(from, days);

const plan = (
  over: Partial<PlanSnapshot> & { code: string },
): PlanSnapshot => ({
  name: over.code,
  priceMinor: 0,
  currency: 'PKR',
  interval: 'none',
  durationDays: null,
  fallbackPlanCode: null,
  active: true,
  ...over,
});

const PLANS: PlanMap = new Map(
  [
    plan({ code: 'starter', durationDays: 15, fallbackPlanCode: 'free' }),
    plan({ code: 'free' }),
    plan({
      code: 'pro',
      priceMinor: 1_999_900,
      interval: 'month',
      fallbackPlanCode: 'free',
    }),
    plan({
      code: 'enterprise',
      priceMinor: null,
      interval: 'none',
      fallbackPlanCode: 'free',
    }),
    plan({ code: 'retired', active: false }),
  ].map((p) => [p.code, p]),
);

const state = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
  planCode: 'starter',
  status: 'active',
  interval: 'none',
  currentPeriodStart: T0,
  currentPeriodEnd: at(15),
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
  statusBeforeSuspension: null,
  closedAt: null,
  entitlementsOverride: null,
  ...over,
});

const pro = (over: Partial<SubscriptionState> = {}) =>
  state({
    planCode: 'pro',
    interval: 'month',
    currentPeriodStart: T0,
    currentPeriodEnd: new Date('2026-11-07T00:00:00.000Z'),
    ...over,
  });

const free = (over: Partial<SubscriptionState> = {}) =>
  state({ planCode: 'free', currentPeriodEnd: null, ...over });

const PRO_END = new Date('2026-11-07T00:00:00.000Z');

describe('advance: time-based transitions (I3)', () => {
  type Case = {
    name: string;
    start: SubscriptionState;
    now: Date;
    expected: Partial<SubscriptionState>;
    steps: string[];
  };

  const cases: Case[] = [
    {
      name: 'Starter one day before its end: nothing happens',
      start: state(),
      now: at(14),
      expected: { planCode: 'starter', status: 'active' },
      steps: [],
    },
    {
      name: 'Starter exactly at 15 days falls back to Free, starting at the moment it ended',
      start: state(),
      now: at(15),
      expected: {
        planCode: 'free',
        status: 'active',
        currentPeriodStart: at(15),
        currentPeriodEnd: null,
        interval: 'none',
      },
      steps: ['trial_ended'],
    },
    {
      name: 'a late job still dates the Free period from the Starter end, not from now',
      start: state(),
      now: at(40),
      expected: { planCode: 'free', currentPeriodStart: at(15) },
      steps: ['trial_ended'],
    },
    {
      name: 'Free never ends',
      start: free(),
      now: at(3650),
      expected: { planCode: 'free', status: 'active' },
      steps: [],
    },
    {
      name: 'a paid plan before its end stays active',
      start: pro(),
      now: at(30),
      expected: { planCode: 'pro', status: 'active' },
      steps: [],
    },
    {
      name: 'a paid period that ends without renewal becomes past_due with 7 days of grace',
      start: pro(),
      now: PRO_END,
      expected: {
        planCode: 'pro',
        status: 'past_due',
        graceEndsAt: addDays(PRO_END, GRACE_DAYS),
      },
      steps: ['period_ended_unpaid'],
    },
    {
      name: 'past_due inside the grace period stays past_due',
      start: pro({
        status: 'past_due',
        graceEndsAt: addDays(PRO_END, GRACE_DAYS),
      }),
      now: addDays(PRO_END, GRACE_DAYS - 1),
      expected: { planCode: 'pro', status: 'past_due' },
      steps: [],
    },
    {
      name: 'past_due falls back to Free when the grace period ends',
      start: pro({
        status: 'past_due',
        graceEndsAt: addDays(PRO_END, GRACE_DAYS),
      }),
      now: addDays(PRO_END, GRACE_DAYS),
      expected: {
        planCode: 'free',
        status: 'active',
        graceEndsAt: null,
        currentPeriodStart: addDays(PRO_END, GRACE_DAYS),
        currentPeriodEnd: null,
      },
      steps: ['grace_expired'],
    },
    {
      name: 'a job that is weeks late applies both steps in one go (past_due, then Free)',
      start: pro(),
      now: addDays(PRO_END, 60),
      expected: { planCode: 'free', status: 'active' },
      steps: ['period_ended_unpaid', 'grace_expired'],
    },
    {
      name: 'a canceled plan keeps the paid plan until the period ends',
      start: pro({ status: 'canceled', cancelAtPeriodEnd: true }),
      now: at(30),
      expected: { planCode: 'pro', status: 'canceled' },
      steps: [],
    },
    {
      name: 'a canceled plan falls back to Free at the period end, with the cancel flag cleared',
      start: pro({ status: 'canceled', cancelAtPeriodEnd: true }),
      now: PRO_END,
      expected: {
        planCode: 'free',
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodStart: PRO_END,
      },
      steps: ['canceled'],
    },
    {
      name: 'an override does not survive the fall back to Free',
      start: pro({
        status: 'canceled',
        cancelAtPeriodEnd: true,
        entitlementsOverride: { seats: 99 },
      }),
      now: PRO_END,
      expected: { planCode: 'free', entitlementsOverride: null },
      steps: ['canceled'],
    },
    {
      name: 'suspended is frozen: nothing is applied however late',
      start: pro({ status: 'suspended', statusBeforeSuspension: 'active' }),
      now: addDays(PRO_END, 90),
      expected: { planCode: 'pro', status: 'suspended' },
      steps: [],
    },
    {
      name: 'closed is final',
      start: pro({ status: 'closed' }),
      now: addDays(PRO_END, 90),
      expected: { planCode: 'pro', status: 'closed' },
      steps: [],
    },
  ];

  it.each(cases)('$name', ({ start, now, expected, steps }) => {
    const result = advance(start, PLANS, now);
    expect(result.state).toMatchObject(expected);
    expect(result.steps.map((s) => s.payload.reason)).toEqual(
      steps.length ? steps : [],
    );
    for (const step of result.steps) {
      expect(step.type).toBe('period.ended');
      expect(step.auditAction).toBe('subscription.period_ended');
    }
  });

  it('is idempotent: advancing an already advanced state again does nothing', () => {
    const once = advance(pro(), PLANS, addDays(PRO_END, 60));
    const twice = advance(once.state, PLANS, addDays(PRO_END, 60));
    expect(twice.steps).toEqual([]);
    expect(twice.state).toEqual(once.state);
  });

  it('records the state before and after each step', () => {
    const { steps } = advance(pro(), PLANS, addDays(PRO_END, 60));
    expect(steps[0].before.status).toBe('active');
    expect(steps[0].after.status).toBe('past_due');
    expect(steps[1].before.status).toBe('past_due');
    expect(steps[1].after.planCode).toBe('free');
  });
});

describe('nextTransitionAt', () => {
  it.each([
    ['Starter: its end', state(), at(15)],
    ['paid active: the period end', pro(), PRO_END],
    [
      'past_due: the grace end',
      pro({ status: 'past_due', graceEndsAt: at(99) }),
      at(99),
    ],
    ['canceled: the period end', pro({ status: 'canceled' }), PRO_END],
    ['Free: never', free(), null],
    ['suspended: never', pro({ status: 'suspended' }), null],
    ['closed: never', pro({ status: 'closed' }), null],
  ])('%s', (_name, s, expected) => {
    expect(nextTransitionAt(s, PLANS)).toEqual(expected);
  });
});

describe('mirrorOf: the tenants.plan / tenants.status mirrors', () => {
  it.each([
    [state(), { plan: 'starter', status: 'trial' }],
    [free(), { plan: 'free', status: 'active' }],
    [pro(), { plan: 'pro', status: 'active' }],
    [pro({ status: 'past_due' }), { plan: 'pro', status: 'active' }],
    [pro({ status: 'canceled' }), { plan: 'pro', status: 'active' }],
    [pro({ status: 'suspended' }), { plan: 'pro', status: 'suspended' }],
    [pro({ status: 'closed' }), { plan: 'pro', status: 'closed' }],
    [state({ status: 'suspended' }), { plan: 'starter', status: 'suspended' }],
  ])('%#', (s, expected) => {
    expect(mirrorOf(s, PLANS)).toEqual(expected);
  });
});

describe('applyEventToState: payment.succeeded', () => {
  const pay = (
    s: SubscriptionState,
    payload: Record<string, unknown>,
    now = T0,
  ) =>
    applyEventToState(
      s,
      'payment.succeeded',
      {
        amountMinor: 1_999_900,
        currency: 'PKR',
        method: 'bank_transfer',
        reference: 'TX-1',
        ...payload,
      } as never,
      PLANS,
      now,
    );

  it('Starter + payment becomes Pro now, for one month, and produces a paid invoice draft', () => {
    const { state: next, step } = pay(state(), { planCode: 'pro' }, at(3));
    expect(next).toMatchObject({
      planCode: 'pro',
      status: 'active',
      interval: 'month',
      currentPeriodStart: at(3),
      currentPeriodEnd: new Date('2026-11-10T00:00:00.000Z'),
      cancelAtPeriodEnd: false,
      graceEndsAt: null,
    });
    expect(step).toMatchObject({
      type: 'payment.succeeded',
      auditAction: 'subscription.payment_recorded',
      invoice: {
        planCode: 'pro',
        amountMinor: 1_999_900,
        currency: 'PKR',
        method: 'bank_transfer',
        reference: 'TX-1',
        periodStart: at(3),
        providerInvoiceId: null,
      },
    });
  });

  it('Free + payment becomes Pro; a yearly interval lasts twelve months', () => {
    const { state: next } = pay(free(), {
      planCode: 'pro',
      interval: 'year',
      amountMinor: 19_999_000,
    });
    expect(next.planCode).toBe('pro');
    expect(next.interval).toBe('year');
    expect(next.currentPeriodEnd).toEqual(new Date('2027-10-07T00:00:00.000Z'));
  });

  it('an explicit periodEnd wins over the interval (Enterprise is per contract)', () => {
    const end = new Date('2027-03-31T00:00:00.000Z');
    const { state: next } = pay(state(), {
      planCode: 'enterprise',
      periodEnd: end,
      entitlementsOverride: { seats: 40 },
    });
    expect(next).toMatchObject({
      planCode: 'enterprise',
      currentPeriodEnd: end,
      entitlementsOverride: { seats: 40 },
    });
  });

  it('a renewal on time starts the new period where the old one ends (no days lost)', () => {
    const { state: next, step } = pay(pro(), {}, at(25));
    expect(next.currentPeriodStart).toEqual(PRO_END);
    expect(next.currentPeriodEnd).toEqual(new Date('2026-12-07T00:00:00.000Z'));
    expect(step?.payload.renewal).toBe(true);
  });

  it('a renewal after the period lapsed (past_due) starts now and clears the grace period', () => {
    const lapsed = pro({
      status: 'past_due',
      graceEndsAt: addDays(PRO_END, GRACE_DAYS),
    });
    const now = addDays(PRO_END, 3);
    const { state: next } = pay(lapsed, {}, now);
    expect(next).toMatchObject({
      status: 'active',
      graceEndsAt: null,
      currentPeriodStart: now,
    });
  });

  it('a renewal clears a pending cancellation', () => {
    const { state: next } = pay(
      pro({ status: 'canceled', cancelAtPeriodEnd: true }),
      {},
      at(25),
    );
    expect(next).toMatchObject({ status: 'active', cancelAtPeriodEnd: false });
  });

  it('a renewal keeps the tenant override, a plan change drops it', () => {
    const withOverride = pro({ entitlementsOverride: { seats: 25 } });
    expect(pay(withOverride, {}, at(25)).state.entitlementsOverride).toEqual({
      seats: 25,
    });
    expect(
      pay(withOverride, { planCode: 'enterprise', periodEnd: at(400) }, at(25))
        .state.entitlementsOverride,
    ).toBeNull();
  });

  it.each([
    ['a plan that is not paid', { planCode: 'free' }, 400, 'VALIDATION_ERROR'],
    ['an unknown plan', { planCode: 'gold' }, 404, 'PLAN_NOT_FOUND'],
    ['a retired plan', { planCode: 'retired' }, 404, 'PLAN_NOT_FOUND'],
    [
      'a different currency',
      { planCode: 'pro', currency: 'USD' },
      400,
      'VALIDATION_ERROR',
    ],
    [
      'a zero amount',
      { planCode: 'pro', amountMinor: 0 },
      400,
      'VALIDATION_ERROR',
    ],
    [
      'a fractional amount (money is integer minor units)',
      { planCode: 'pro', amountMinor: 19.99 },
      400,
      'VALIDATION_ERROR',
    ],
    [
      'a plan without an interval and no periodEnd',
      { planCode: 'enterprise' },
      400,
      'VALIDATION_ERROR',
    ],
    [
      'a periodEnd that is not after the start',
      { planCode: 'pro', periodEnd: T0 },
      400,
      'VALIDATION_ERROR',
    ],
    [
      'a renewal of a plan that is not paid (no planCode on Free)',
      {},
      400,
      'VALIDATION_ERROR',
    ],
  ])('rejects %s', (_name, payload, status, code) => {
    const start = _name.includes('renewal') ? free() : state();
    expect(() => pay(start, payload)).toThrow(
      expect.objectContaining({
        status,
        response: expect.objectContaining({ code }),
      }),
    );
  });

  it.each(['suspended', 'closed'] as const)(
    'rejects a payment while the subscription is %s (409)',
    (status) => {
      expect(() => pay(pro({ status }), { planCode: 'pro' })).toThrow(
        expect.objectContaining({
          status: 409,
          response: expect.objectContaining({
            code: 'INVALID_SUBSCRIPTION_STATE',
          }),
        }),
      );
    },
  );
});

describe('applyEventToState: payment.failed', () => {
  it('is recorded but changes no state, in any status', () => {
    for (const status of [
      'active',
      'past_due',
      'suspended',
      'closed',
    ] as const) {
      const s = pro({ status });
      const result = applyEventToState(
        s,
        'payment.failed',
        { reason: 'card_declined' },
        PLANS,
        T0,
      );
      expect(result.state).toEqual(s);
      expect(result.step).toMatchObject({
        type: 'payment.failed',
        auditAction: 'subscription.payment_failed',
      });
    }
  });
});

describe('applyEventToState: subscription.canceled', () => {
  const cancel = (s: SubscriptionState, payload = {}, now = T0) =>
    applyEventToState(s, 'subscription.canceled', payload, PLANS, now);

  it('by default keeps the paid plan until the period ends (status canceled)', () => {
    const { state: next, step } = cancel(pro());
    expect(next).toMatchObject({
      planCode: 'pro',
      status: 'canceled',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: PRO_END,
    });
    expect(step?.auditAction).toBe('subscription.canceled');
  });

  it('atPeriodEnd=false falls back to Free now', () => {
    const { state: next } = cancel(pro(), { atPeriodEnd: false }, at(5));
    expect(next).toMatchObject({
      planCode: 'free',
      status: 'active',
      currentPeriodStart: at(5),
      currentPeriodEnd: null,
    });
  });

  it('cancelling a past_due plan falls back to Free immediately (the period is already over)', () => {
    const { state: next } = cancel(
      pro({ status: 'past_due', graceEndsAt: at(99) }),
      {},
      addDays(PRO_END, 2),
    );
    expect(next).toMatchObject({ planCode: 'free', status: 'active' });
  });

  it('cancelling twice is a no-op', () => {
    const canceled = pro({ status: 'canceled', cancelAtPeriodEnd: true });
    const result = cancel(canceled);
    expect(result.step).toBeNull();
    expect(result.state).toEqual(canceled);
  });

  it.each([
    ['Starter', state()],
    ['Free', free()],
  ])('%s has nothing to cancel (409)', (_name, s) => {
    expect(() => cancel(s)).toThrow(
      expect.objectContaining({
        status: 409,
        response: expect.objectContaining({
          code: 'INVALID_SUBSCRIPTION_STATE',
        }),
      }),
    );
  });

  it('is refused for a suspended or closed subscription', () => {
    expect(() => cancel(pro({ status: 'suspended' }))).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => cancel(pro({ status: 'closed' }))).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });
});

describe('applyEventToState: plan.changed', () => {
  const change = (
    s: SubscriptionState,
    payload: Record<string, unknown>,
    now = T0,
  ) => applyEventToState(s, 'plan.changed', payload as never, PLANS, now);

  it('Pro to Free is immediate and has no end', () => {
    const { state: next } = change(pro(), { planCode: 'free' }, at(5));
    expect(next).toMatchObject({
      planCode: 'free',
      status: 'active',
      interval: 'none',
      currentPeriodStart: at(5),
      currentPeriodEnd: null,
    });
  });

  it('Free to Pro without a payment grants one interval from now', () => {
    const { state: next, step } = change(free(), { planCode: 'pro' }, at(2));
    expect(next).toMatchObject({
      planCode: 'pro',
      status: 'active',
      currentPeriodStart: at(2),
      currentPeriodEnd: new Date('2026-11-09T00:00:00.000Z'),
    });
    expect(step?.invoice).toBeUndefined();
  });

  it('keeps a running paid period when moving between paid plans', () => {
    const { state: next } = change(
      pro(),
      { planCode: 'enterprise', entitlementsOverride: { seats: 50 } },
      at(10),
    );
    expect(next).toMatchObject({
      planCode: 'enterprise',
      currentPeriodStart: T0,
      currentPeriodEnd: PRO_END,
      entitlementsOverride: { seats: 50 },
    });
  });

  it('re-granting Starter starts a new 15-day period', () => {
    const { state: next } = change(free(), { planCode: 'starter' }, at(100));
    expect(next).toMatchObject({
      planCode: 'starter',
      currentPeriodStart: at(100),
      currentPeriodEnd: at(115),
    });
  });

  it('is a no-op when nothing would change', () => {
    expect(change(pro(), { planCode: 'pro' }, at(2)).step).toBeNull();
    expect(change(free(), { planCode: 'free' }).step).toBeNull();
  });

  it('un-cancels when the same plan is chosen again', () => {
    const { state: next } = change(
      pro({ status: 'canceled', cancelAtPeriodEnd: true }),
      { planCode: 'pro' },
      at(2),
    );
    expect(next).toMatchObject({ status: 'active', cancelAtPeriodEnd: false });
  });

  it.each([
    ['an unknown plan', { planCode: 'gold' }, 404],
    ['a retired plan', { planCode: 'retired' }, 404],
    ['a periodEnd in the past', { planCode: 'pro', periodEnd: at(-1) }, 400],
  ])('rejects %s', (_name, payload, status) => {
    expect(() => change(free(), payload, T0)).toThrow(
      expect.objectContaining({ status }),
    );
  });

  it('Enterprise needs a periodEnd (it has no interval)', () => {
    expect(() => change(free(), { planCode: 'enterprise' })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    const { state: next } = change(free(), {
      planCode: 'enterprise',
      periodEnd: at(365),
    });
    expect(next.currentPeriodEnd).toEqual(at(365));
  });
});

describe('applyEventToState: period.extended', () => {
  const extend = (
    s: SubscriptionState,
    payload: Record<string, unknown>,
    now = T0,
  ) => applyEventToState(s, 'period.extended', payload as never, PLANS, now);

  it('extends Starter by days', () => {
    const { state: next, step } = extend(state(), { days: 7 }, at(10));
    expect(next.currentPeriodEnd).toEqual(at(22));
    expect(step?.auditAction).toBe('subscription.extended');
  });

  it('extends to an explicit date', () => {
    const { state: next } = extend(state(), { until: at(30) });
    expect(next.currentPeriodEnd).toEqual(at(30));
  });

  it('brings a past_due paid plan back to active', () => {
    const { state: next } = extend(
      pro({ status: 'past_due', graceEndsAt: at(99) }),
      { days: 10 },
      addDays(PRO_END, 2),
    );
    expect(next).toMatchObject({ status: 'active', graceEndsAt: null });
    expect(next.currentPeriodEnd).toEqual(addDays(PRO_END, 12));
  });

  it('keeps a canceled plan canceled', () => {
    const { state: next } = extend(
      pro({ status: 'canceled', cancelAtPeriodEnd: true }),
      { days: 5 },
    );
    expect(next.status).toBe('canceled');
  });

  it.each([
    ['both until and days', { until: at(30), days: 5 }, 400],
    ['neither until nor days', {}, 400],
    ['an end that is not later than the current one', { until: at(10) }, 400],
    ['zero days', { days: 0 }, 400],
  ])('rejects %s', (_name, payload, status) => {
    expect(() => extend(state(), payload)).toThrow(
      expect.objectContaining({ status }),
    );
  });

  it('Free has no end to extend (409)', () => {
    expect(() => extend(free(), { days: 5 })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });
});

describe('applyEventToState: account.closed, tenant.suspended, tenant.unsuspended', () => {
  const apply = (
    s: SubscriptionState,
    type: 'account.closed' | 'tenant.suspended' | 'tenant.unsuspended',
    now = T0,
  ) => applyEventToState(s, type, {}, PLANS, now);

  it('closes from any live status and stamps closedAt', () => {
    for (const status of [
      'active',
      'past_due',
      'canceled',
      'suspended',
    ] as const) {
      const { state: next, step } = apply(
        pro({ status }),
        'account.closed',
        at(3),
      );
      expect(next).toMatchObject({
        status: 'closed',
        closedAt: at(3),
        statusBeforeSuspension: null,
      });
      expect(step?.auditAction).toBe('subscription.closed');
    }
  });

  it('closing twice is a no-op', () => {
    expect(apply(pro({ status: 'closed' }), 'account.closed').step).toBeNull();
  });

  it('suspending remembers the previous status and un-suspending restores it', () => {
    const suspended = apply(pro({ status: 'past_due' }), 'tenant.suspended');
    expect(suspended.state).toMatchObject({
      status: 'suspended',
      statusBeforeSuspension: 'past_due',
    });
    expect(suspended.step?.auditAction).toBe('tenant.suspended');

    const restored = apply(suspended.state, 'tenant.unsuspended');
    expect(restored.state).toMatchObject({
      status: 'past_due',
      statusBeforeSuspension: null,
    });
    expect(restored.step?.auditAction).toBe('tenant.reactivated');
  });

  it('suspending a suspended tenant and un-suspending an active one are no-ops', () => {
    expect(
      apply(pro({ status: 'suspended' }), 'tenant.suspended').step,
    ).toBeNull();
    expect(apply(pro(), 'tenant.unsuspended').step).toBeNull();
  });

  it('a closed account can be neither suspended nor un-suspended into life (409 for suspend)', () => {
    expect(() => apply(pro({ status: 'closed' }), 'tenant.suspended')).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it('un-suspending defaults to active when no previous status was stored (migrated rows)', () => {
    const { state: next } = apply(
      state({ status: 'suspended', statusBeforeSuspension: null }),
      'tenant.unsuspended',
    );
    expect(next.status).toBe('active');
  });
});

describe('applyEventToState: period.ended', () => {
  it('is only "evaluate what is due": it never changes state by itself', () => {
    const result = applyEventToState(pro(), 'period.ended', {}, PLANS, T0);
    expect(result.step).toBeNull();
  });
});

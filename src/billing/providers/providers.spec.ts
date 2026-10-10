import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import { BillingProvider } from './billing-provider';
import { BillingProviders } from './billing-providers';
import { ManualProvider } from './manual.provider';

describe('ManualProvider', () => {
  const manual = new ManualProvider();

  it('is a BillingProvider named "manual"', () => {
    expect(manual).toBeInstanceOf(BillingProvider);
    expect(manual.name).toBe('manual');
  });

  it.each([
    [
      'createCheckout',
      () => manual.createCheckout({ tenantId: 't', planCode: 'pro' }),
    ],
    [
      'createPortalSession',
      () => manual.createPortalSession({ tenantId: 't' }),
    ],
    ['handleWebhook', () => manual.handleWebhook()],
  ])('%s is a clear 501 NOT_IMPLEMENTED', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({
      status: 501,
      response: { code: 'NOT_IMPLEMENTED' },
    });
  });

  it('cancel has nothing to stop outside this system, so it succeeds', async () => {
    await expect(
      manual.cancel({
        tenantId: 't',
        providerSubscriptionId: null,
        atPeriodEnd: true,
      }),
    ).resolves.toBeUndefined();
  });

  describe('event (an admin action as a normalised event)', () => {
    it('marks the event manual, from the platform admin, with no event id unless a key is given', () => {
      const event = manual.event('tenant-a', 'admin-1', 'plan.changed', {
        planCode: 'free',
      });
      expect(event).toEqual({
        tenantId: 'tenant-a',
        type: 'plan.changed',
        payload: { planCode: 'free' },
        source: 'manual',
        provider: 'manual',
        providerEventId: null,
        actor: { userId: 'admin-1', role: 'platform_admin' },
      });
    });

    it('scopes the idempotency key to the tenant so keys never collide across tenants', () => {
      const a = manual.event(
        'tenant-a',
        'admin-1',
        'subscription.canceled',
        {},
        'k1',
      );
      const b = manual.event(
        'tenant-b',
        'admin-1',
        'subscription.canceled',
        {},
        'k1',
      );
      expect(a.providerEventId).toBe('tenant-a:k1');
      expect(b.providerEventId).toBe('tenant-b:k1');
    });
  });
});

describe('BillingProviders', () => {
  it('finds the manual provider by name and refuses unknown names with 501', async () => {
    const module = await Test.createTestingModule({
      providers: [ManualProvider, BillingProviders],
    }).compile();
    const providers = module.get(BillingProviders);
    expect(providers.get('manual')).toBe(module.get(ManualProvider));
    expect(() => providers.get('somebody-else')).toThrow(
      expect.objectContaining({ status: 501 }),
    );
  });
});

describe('provider neutrality (I4, Phase 2B done-when)', () => {
  // Built from fragments so this file does not contain the names it forbids elsewhere.
  const COMPANIES = [
    ['str', 'ipe'],
    ['pay', 'pal'],
    ['razor', 'pay'],
    ['pad', 'dle'],
    ['brain', 'tree'],
    ['ad', 'yen'],
    ['2check', 'out'],
    ['pay', 'oneer'],
    ['easy', 'paisa'],
    ['jazz', 'cash'],
    ['safe', 'pay'],
    ['pay', 'fast'],
    ['lemon', 'squeezy'],
  ].map((parts) => parts.join(''));

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|json)$/.test(name) ? [path] : [];
    });
  }

  it('no source file names a specific payment company', () => {
    const srcRoot = join(__dirname, '..', '..');
    const offenders: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      if (file === __filename) continue;
      const text = readFileSync(file, 'utf8').toLowerCase();
      for (const company of COMPANIES) {
        if (text.includes(company)) offenders.push(`${file}: ${company}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

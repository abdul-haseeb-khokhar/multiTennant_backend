import { ConfigService } from '@nestjs/config';
import { MAIL_DEGRADED_AFTER, MailHealth } from './mail-health';

const health = (provider = 'resend') => {
  const h = new MailHealth({
    get: (key: string) => (key === 'MAIL_PROVIDER' ? provider : undefined),
  } as unknown as ConfigService);
  const warn = jest
    .spyOn((h as any).logger, 'warn')
    .mockImplementation(() => undefined);
  jest.spyOn((h as any).logger, 'log').mockImplementation(() => undefined);
  return { h, warn };
};

describe('MailHealth', () => {
  it('starts ok with no failures', () => {
    expect(health().h.snapshot()).toEqual({
      provider: 'resend',
      status: 'ok',
      consecutiveFailures: 0,
      lastFailureReason: null,
      lastFailureAt: null,
    });
  });

  it(`turns degraded after ${MAIL_DEGRADED_AFTER} failures in a row and warns once, with the reason`, () => {
    const { h, warn } = health();
    for (let i = 0; i < MAIL_DEGRADED_AFTER - 1; i++) h.failure('quota_daily');
    expect(h.snapshot().status).toBe('ok');
    h.failure('quota_daily');
    expect(h.snapshot()).toMatchObject({
      status: 'degraded',
      consecutiveFailures: MAIL_DEGRADED_AFTER,
      lastFailureReason: 'quota_daily',
    });
    h.failure('quota_daily');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain('quota_daily');
  });

  it('a success in between resets the count', () => {
    const { h } = health();
    h.failure('network');
    h.failure('network');
    h.success();
    h.failure('network');
    expect(h.snapshot()).toMatchObject({
      status: 'ok',
      consecutiveFailures: 1,
    });
  });

  it('recovers on the first success after being degraded, and keeps the last reason for the record', () => {
    const { h } = health();
    for (let i = 0; i < 5; i++) h.failure('auth');
    expect(h.snapshot().status).toBe('degraded');
    h.success();
    expect(h.snapshot()).toMatchObject({
      status: 'ok',
      consecutiveFailures: 0,
      lastFailureReason: 'auth',
    });
  });

  it('the console mailer is reported as not configured, never as degraded', () => {
    const { h } = health('console');
    for (let i = 0; i < 5; i++) h.failure('unknown');
    expect(h.snapshot().status).toBe('not_configured');
  });

  it('exposes a reason code and a time, never an address or a link', () => {
    const { h } = health();
    h.failure('test_mode_recipient');
    const text = JSON.stringify(h.snapshot());
    expect(text).toContain('test_mode_recipient');
    expect(text).not.toMatch(/@|https?:/);
  });
});

import { ConfigService } from '@nestjs/config';
import { MailHealth } from './mail-health';
import { MailService } from './mail.service';
import { MailDeliveryError, Mailer } from './mailer';

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('MailService', () => {
  let mailer: { send: jest.Mock };
  let health: { success: jest.Mock; failure: jest.Mock };
  const request = {
    to: 'agent@acme.com',
    template: 'staff-invite' as const,
    token: 'tok en/1',
    locale: 'ur',
  };

  beforeEach(() => {
    mailer = { send: jest.fn().mockResolvedValue('sent') };
    health = { success: jest.fn(), failure: jest.fn() };
  });

  const service = (env: Record<string, string | undefined> = {}) =>
    new MailService(
      mailer as unknown as Mailer,
      config(env),
      health as unknown as MailHealth,
    );

  const silence = (svc: MailService) =>
    jest
      .spyOn((svc as any).logger, 'error')
      .mockImplementation(() => undefined);

  it('builds the link from FRONTEND_URL, with the page for the template and an encoded token', async () => {
    await service({ FRONTEND_URL: 'https://app.example.com/' }).sendNow(
      request,
    );
    expect(mailer.send).toHaveBeenCalledWith({
      to: 'agent@acme.com',
      template: 'staff-invite',
      locale: 'ur',
      link: 'https://app.example.com/accept-invite?token=tok%20en%2F1',
      params: undefined,
    });
    for (const [template, path] of [
      ['password-reset', '/reset-password'],
      ['email-verification', '/verify-email'],
    ] as const) {
      await service({ FRONTEND_URL: 'https://a.io' }).sendNow({
        ...request,
        template,
      });
      expect(mailer.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          link: `https://a.io${path}?token=tok%20en%2F1`,
        }),
      );
    }
  });

  it('billing emails link to the billing page, without a token, and pass their params', async () => {
    await service({ FRONTEND_URL: 'https://a.io' }).sendNow({
      to: 'owner@acme.com',
      template: 'billing-period-ending',
      locale: 'en',
      params: { plan: 'Pro', daysLeft: 3 },
    });
    expect(mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        link: 'https://a.io/billing',
        params: { plan: 'Pro', daysLeft: 3 },
      }),
    );
  });

  it('falls back to the local frontend when FRONTEND_URL is unset (production requires it, see env validation)', async () => {
    await service().sendNow(request);
    expect(mailer.send.mock.calls[0][0].link).toMatch(
      /^http:\/\/localhost:5173\/accept-invite\?token=/,
    );
  });

  describe('MAIL_MODE', () => {
    it('does not return the link by default', async () => {
      await expect(service({}).sendNow(request)).resolves.toEqual({
        delivery: 'sent',
      });
      expect(service({ MAIL_MODE: 'console' }).queue(request)).toEqual({});
    });

    it('returns the link only with MAIL_MODE=link', async () => {
      const { link } = await service({ MAIL_MODE: 'link' }).sendNow(request);
      expect(link).toContain('/accept-invite?token=');
      expect(service({ MAIL_MODE: 'link' }).queue(request).link).toContain(
        '/accept-invite?token=',
      );
    });
  });

  describe('sendNow reports what happened', () => {
    it('sent when the provider took the message, and the health watcher sees a success', async () => {
      await expect(service().sendNow(request)).resolves.toMatchObject({
        delivery: 'sent',
      });
      expect(health.success).toHaveBeenCalledTimes(1);
    });

    it('skipped when the console mailer did not send anything (and that is not a failure)', async () => {
      mailer.send.mockResolvedValue('skipped');
      await expect(service().sendNow(request)).resolves.toMatchObject({
        delivery: 'skipped',
      });
      expect(health.failure).not.toHaveBeenCalled();
    });

    it('failed, WITHOUT throwing, when the provider refuses: the flow that asked for the email goes on', async () => {
      const svc = service({ MAIL_MODE: 'link' });
      silence(svc);
      mailer.send.mockRejectedValue(new MailDeliveryError('quota_daily', 429));
      const result = await svc.sendNow(request);
      expect(result.delivery).toBe('failed');
      // the link is still handed back in development so the flow can be finished by hand
      expect(result.link).toContain('/accept-invite');
      expect(health.failure).toHaveBeenCalledWith('quota_daily');
    });

    it('an unexpected error is a failure with reason "unknown"', async () => {
      const svc = service();
      silence(svc);
      mailer.send.mockRejectedValue(new Error('boom'));
      await expect(svc.sendNow(request)).resolves.toEqual({
        delivery: 'failed',
      });
      expect(health.failure).toHaveBeenCalledWith('unknown');
    });

    it('logs the template and the reason (distinct for a quota), never the recipient, the link or the provider text', async () => {
      const svc = service({ FRONTEND_URL: 'https://app.example.com' });
      const error = silence(svc);
      mailer.send.mockRejectedValue(
        Object.assign(new MailDeliveryError('test_mode_recipient', 403), {
          message: 'only agent@acme.com may receive; token=tok',
        }),
      );
      await svc.sendNow(request);
      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain('staff-invite');
      expect(logged).toContain('test_mode_recipient');
      expect(logged).toContain('403');
      expect(logged).not.toContain('agent@acme.com');
      expect(logged).not.toContain('token=');
      expect(logged).not.toContain('app.example.com');
    });
  });

  describe('queue', () => {
    it('returns before delivery finishes', async () => {
      let release!: (value: string) => void;
      mailer.send.mockReturnValue(
        new Promise<string>((resolve) => (release = resolve)),
      );
      expect(service().queue(request)).toEqual({});
      expect(mailer.send).toHaveBeenCalledTimes(1);
      release('sent');
      await flush();
      expect(health.success).toHaveBeenCalledTimes(1);
    });

    it('survives a provider that throws instead of returning a promise', async () => {
      const svc = service();
      silence(svc);
      mailer.send.mockImplementation(() => {
        throw new Error('sync boom');
      });
      expect(() => svc.queue(request)).not.toThrow();
      await flush();
      expect((svc as any).logger.error).toHaveBeenCalledTimes(1);
      expect(health.failure).toHaveBeenCalledWith('unknown');
    });

    it('swallows a failure but logs the template, never the recipient or the link', async () => {
      const svc = service();
      const error = silence(svc);
      mailer.send.mockRejectedValue(new Error('smtp down'));
      expect(() => svc.queue(request)).not.toThrow();
      await flush();
      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain('staff-invite');
      expect(logged).not.toContain('agent@acme.com');
      expect(logged).not.toContain('token=');
    });
  });
});

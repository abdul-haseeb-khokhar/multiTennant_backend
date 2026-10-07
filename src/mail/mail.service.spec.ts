import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { Mailer } from './mailer';

const config = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('MailService', () => {
  let mailer: { send: jest.Mock };
  const request = {
    to: 'agent@acme.com',
    template: 'staff-invite' as const,
    token: 'tok en/1',
    locale: 'ur',
  };

  beforeEach(() => {
    mailer = { send: jest.fn().mockResolvedValue(undefined) };
  });

  const service = (env: Record<string, string | undefined> = {}) =>
    new MailService(mailer as unknown as Mailer, config(env));

  it('builds the link from FRONTEND_URL, with the page for the template and an encoded token', async () => {
    await service({ FRONTEND_URL: 'https://app.example.com/' }).sendNow(
      request,
    );
    expect(mailer.send).toHaveBeenCalledWith({
      to: 'agent@acme.com',
      template: 'staff-invite',
      locale: 'ur',
      link: 'https://app.example.com/accept-invite?token=tok%20en%2F1',
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

  it('falls back to the local frontend when FRONTEND_URL is unset (production requires it, see env validation)', async () => {
    await service().sendNow(request);
    expect(mailer.send.mock.calls[0][0].link).toMatch(
      /^http:\/\/localhost:5173\/accept-invite\?token=/,
    );
  });

  describe('MAIL_MODE', () => {
    it('does not return the link by default', async () => {
      await expect(service({}).sendNow(request)).resolves.toEqual({});
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

  describe('sendNow', () => {
    it('turns a delivery failure into 503 MAIL_DELIVERY_FAILED without leaking the link', async () => {
      const svc = service();
      jest
        .spyOn((svc as any).logger, 'error')
        .mockImplementation(() => undefined);
      mailer.send.mockRejectedValue(new Error('smtp down'));
      const error = await svc.sendNow(request).catch((e: unknown) => e);
      expect(error).toMatchObject({
        status: 503,
        response: { code: 'MAIL_DELIVERY_FAILED' },
      });
      expect(JSON.stringify((error as any).response)).not.toContain('token=');
    });
  });

  describe('queue', () => {
    it('returns before delivery finishes', async () => {
      let release!: () => void;
      mailer.send.mockReturnValue(
        new Promise<void>((resolve) => (release = resolve)),
      );
      expect(service().queue(request)).toEqual({});
      expect(mailer.send).toHaveBeenCalledTimes(1);
      release();
      await flush();
    });

    it('survives a provider that throws instead of returning a promise', async () => {
      const svc = service();
      jest
        .spyOn((svc as any).logger, 'error')
        .mockImplementation(() => undefined);
      mailer.send.mockImplementation(() => {
        throw new Error('sync boom');
      });
      expect(() => svc.queue(request)).not.toThrow();
      await flush();
      expect((svc as any).logger.error).toHaveBeenCalledTimes(1);
    });

    it('swallows a failure but logs the template, never the recipient or the link', async () => {
      const svc = service();
      const error = jest
        .spyOn((svc as any).logger, 'error')
        .mockImplementation(() => undefined);
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

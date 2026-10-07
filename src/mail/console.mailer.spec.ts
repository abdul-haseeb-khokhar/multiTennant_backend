import { ConsoleMailer } from './console.mailer';

describe('ConsoleMailer', () => {
  it('logs the message with its link (the only place a link may be logged) and delivers nothing', async () => {
    const mailer = new ConsoleMailer();
    const log = jest
      .spyOn((mailer as any).logger, 'log')
      .mockImplementation(() => undefined);
    await expect(
      mailer.send({
        to: 'a@b.co',
        template: 'password-reset',
        locale: 'en',
        link: 'http://x/reset-password?token=t',
      }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'a@b.co',
        template: 'password-reset',
        link: 'http://x/reset-password?token=t',
      }),
    );
  });
});

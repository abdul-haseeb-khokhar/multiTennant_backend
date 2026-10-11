import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { validateEnv } from '../config/env.validation';
import { ConsoleMailer } from './console.mailer';
import { MailModule } from './mail.module';
import { Mailer } from './mailer';
import { ResendMailer } from './resend.mailer';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'a-secret-with-at-least-16-chars',
};

async function mailerFor(env: Record<string, string>) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
        load: [() => validateEnv({ ...base, ...env })],
      }),
      MailModule,
    ],
  }).compile();
  return moduleRef.get(Mailer);
}

describe('MailModule provider selection (MAIL_PROVIDER)', () => {
  it('uses the console mailer by default', async () => {
    expect(await mailerFor({})).toBeInstanceOf(ConsoleMailer);
  });

  it('uses Resend with MAIL_PROVIDER=resend and a key', async () => {
    const mailer = await mailerFor({
      MAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_0123456789',
    });
    expect(mailer).toBeInstanceOf(ResendMailer);
  });

  it('the Resend mailer starts with the documented defaults: test sender and the SupportDesk AI working name', async () => {
    const mailer = (await mailerFor({
      MAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_0123456789',
    })) as unknown as { options: Record<string, unknown> };
    expect(mailer.options).toMatchObject({
      from: 'onboarding@resend.dev',
      fromName: 'SupportDesk AI',
      redirectTo: undefined,
      timeoutMs: 5000,
      apiUrl: 'https://api.resend.com',
    });
  });

  it('takes the sender, name, redirect and timeout from the environment', async () => {
    const mailer = (await mailerFor({
      MAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_0123456789',
      MAIL_FROM: 'noreply@example.com',
      MAIL_FROM_NAME: 'Acme Support',
      MAIL_REDIRECT_TO: 'me@example.com',
      MAIL_TIMEOUT_MS: '2000',
    })) as unknown as { options: Record<string, unknown> };
    expect(mailer.options).toMatchObject({
      from: 'noreply@example.com',
      fromName: 'Acme Support',
      redirectTo: 'me@example.com',
      timeoutMs: 2000,
    });
  });
});

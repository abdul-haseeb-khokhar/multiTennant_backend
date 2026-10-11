import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { I18nService } from '../i18n/i18n.service';
import { MailRenderer } from './mail-renderer';
import { MailDeliveryError, MailMessage } from './mailer';
import { ResendMailer, ResendMailerOptions, classify } from './resend.mailer';

const API_KEY = 're_secret_key_0123456789';
const TO = 'customer@acme.com';
const LINK = 'https://app.example.com/accept-invite?token=SECRET-TOKEN-123';

interface Received {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: any;
}

/** A fake Resend: records requests and answers with whatever the test queued (or hangs / drops the socket). */
class FakeResend {
  server: Server;
  url = '';
  requests: Received[] = [];
  /** One entry per request; the last one repeats. */
  script: Array<{ status: number; json?: unknown } | 'hang' | 'drop'> = [
    { status: 200, json: { id: 'email-1' } },
  ];

  constructor() {
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      this.requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
      });
      const step =
        this.script[Math.min(this.requests.length - 1, this.script.length - 1)];
      if (step === 'hang') return; // never answer
      if (step === 'drop') return req.socket.destroy();
      res.writeHead(step.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(step.json ?? {}));
    });
  }
}

describe('ResendMailer (against a fake Resend server)', () => {
  const fake = new FakeResend();
  const renderer = new MailRenderer(new I18nService());
  let logs: unknown[];

  beforeAll(() => fake.start());
  afterAll(() => fake.stop());
  beforeEach(() => {
    fake.requests = [];
    fake.script = [{ status: 200, json: { id: 'email-1' } }];
    logs = [];
  });

  const mailer = (over: Partial<ResendMailerOptions> = {}) => {
    const m = new ResendMailer(
      {
        apiKey: API_KEY,
        from: 'onboarding@resend.dev',
        fromName: 'SupportDesk AI',
        timeoutMs: 1000,
        apiUrl: fake.url,
        retryDelayMs: 5,
        ...over,
      },
      renderer,
    );
    const capture = (...args: unknown[]) => void logs.push(args);
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn((m as any).logger, level).mockImplementation(capture);
    }
    return m;
  };

  const message = (over: Partial<MailMessage> = {}): MailMessage => ({
    to: TO,
    template: 'staff-invite',
    locale: 'en',
    link: LINK,
    ...over,
  });

  const failure = async (m: ResendMailer, msg = message()) =>
    (await m.send(msg).then(
      () => null,
      (e: unknown) => e,
    )) as MailDeliveryError;

  describe('success', () => {
    it('POSTs /emails with the Bearer key and JSON from, to, subject, html and text', async () => {
      await expect(mailer().send(message())).resolves.toBe('sent');
      expect(fake.requests).toHaveLength(1);
      const [request] = fake.requests;
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/emails');
      expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(request.headers['content-type']).toBe('application/json');
      expect(request.body).toMatchObject({
        from: '"SupportDesk AI" <onboarding@resend.dev>',
        to: [TO],
        subject: 'You are invited to join the team',
      });
      expect(request.body.html).toContain(LINK);
      expect(request.body.text).toContain(LINK);
      expect(request.body.html).toContain('<html lang="en" dir="ltr">');
    });

    it('renders in the recipient language (Urdu, right-to-left)', async () => {
      await mailer().send(message({ locale: 'ur' }));
      expect(fake.requests[0].body.html).toContain(
        '<html lang="ur" dir="rtl">',
      );
    });

    it('sends an Idempotency-Key so a retried attempt cannot deliver twice', async () => {
      await mailer().send(message());
      expect(fake.requests[0].headers['idempotency-key']).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    });

    it('uses a different key for a different message', async () => {
      const m = mailer();
      await m.send(message());
      await m.send(message());
      expect(fake.requests[0].headers['idempotency-key']).not.toBe(
        fake.requests[1].headers['idempotency-key'],
      );
    });
  });

  describe('redirect mode (MAIL_REDIRECT_TO, test stage)', () => {
    it('sends every message to the redirect address only, naming the intended recipient in the subject and body', async () => {
      await mailer({ redirectTo: 'owner@resend-account.test' }).send(message());
      const { body } = fake.requests[0];
      expect(body.to).toEqual(['owner@resend-account.test']);
      expect(JSON.stringify(body.to)).not.toContain(TO);
      expect(body.subject).toBe(
        `[TEST for ${TO}] You are invited to join the team`,
      );
      expect(body.html).toContain(`meant for ${TO}`);
      expect(body.text.split('\n')[0]).toContain(TO);
    });

    it('without a redirect the message goes to the real recipient with no test marker', async () => {
      await mailer().send(message());
      expect(fake.requests[0].body.to).toEqual([TO]);
      expect(fake.requests[0].body.subject).not.toContain('[TEST');
      expect(fake.requests[0].body.html).not.toContain('Test mode');
    });
  });

  describe('failures that are final (no retry)', () => {
    it('403 test mode: "testing emails can only be sent to your own address" is reason test_mode_recipient', async () => {
      fake.script = [
        {
          status: 403,
          json: {
            name: 'validation_error',
            message:
              'You can only send testing emails to your own email address (owner@resend-account.test). To send emails to other recipients, verify a domain.',
          },
        },
      ];
      const error = await failure(mailer());
      expect(error).toBeInstanceOf(MailDeliveryError);
      expect(error).toMatchObject({
        reason: 'test_mode_recipient',
        status: 403,
      });
      expect(fake.requests).toHaveLength(1);
    });

    it('403 unverified domain', async () => {
      fake.script = [
        {
          status: 403,
          json: {
            name: 'validation_error',
            message: 'The acme.com domain is not verified.',
          },
        },
      ];
      expect(await failure(mailer())).toMatchObject({
        reason: 'unverified_domain',
      });
    });

    it.each([
      ['daily_quota_exceeded', 'quota_daily'],
      ['monthly_quota_exceeded', 'quota_monthly'],
      ['rate_limit_exceeded', 'rate_limited'],
    ])(
      '429 %s is its own reason (%s) and is NOT retried',
      async (name, reason) => {
        fake.script = [{ status: 429, json: { name, message: 'x' } }];
        expect(await failure(mailer())).toMatchObject({ reason, status: 429 });
        expect(fake.requests).toHaveLength(1);
      },
    );

    it.each([
      [401, 'missing_api_key', 'auth'],
      [403, 'restricted_api_key', 'auth'],
      [400, 'validation_error', 'invalid_request'],
      [422, 'missing_required_field', 'invalid_request'],
      [409, 'concurrent_idempotent_requests', 'invalid_request'],
    ])('%s %s is %s and not retried', async (status, name, reason) => {
      fake.script = [{ status, json: { name, message: 'x' } }];
      expect(await failure(mailer())).toMatchObject({ reason, status });
      expect(fake.requests).toHaveLength(1);
    });

    it('an error body that is not JSON still classifies by status', async () => {
      fake.script = [{ status: 429 }];
      expect(await failure(mailer())).toMatchObject({ reason: 'rate_limited' });
    });
  });

  describe('retry: exactly once, only for network errors, timeouts and 5xx', () => {
    it('a 5xx followed by success is delivered, with the same Idempotency-Key', async () => {
      fake.script = [
        { status: 503, json: { name: 'service_unavailable' } },
        { status: 200, json: { id: 'x' } },
      ];
      await expect(mailer().send(message())).resolves.toBe('sent');
      expect(fake.requests).toHaveLength(2);
      expect(fake.requests[0].headers['idempotency-key']).toBe(
        fake.requests[1].headers['idempotency-key'],
      );
    });

    it('a 500 twice fails after exactly two attempts (never more)', async () => {
      fake.script = [{ status: 500, json: { name: 'application_error' } }];
      expect(await failure(mailer())).toMatchObject({
        reason: 'provider_error',
        status: 500,
      });
      expect(fake.requests).toHaveLength(2);
    });

    it('a dropped connection is retried once', async () => {
      fake.script = ['drop', { status: 200, json: { id: 'x' } }];
      await expect(mailer().send(message())).resolves.toBe('sent');
      expect(fake.requests).toHaveLength(2);
    });

    it('a dropped connection twice is reason "network"', async () => {
      fake.script = ['drop'];
      expect(await failure(mailer())).toMatchObject({ reason: 'network' });
      expect(fake.requests).toHaveLength(2);
    });

    it('a server that never answers hits the timeout (reason "timeout") after one retry, within a bound', async () => {
      fake.script = ['hang'];
      const started = Date.now();
      const error = await failure(mailer({ timeoutMs: 150 }));
      expect(error).toMatchObject({ reason: 'timeout' });
      expect(fake.requests).toHaveLength(2);
      expect(Date.now() - started).toBeLessThan(1500);
    });

    it('a timeout followed by success is delivered', async () => {
      fake.script = ['hang', { status: 200, json: { id: 'x' } }];
      await expect(mailer({ timeoutMs: 150 }).send(message())).resolves.toBe(
        'sent',
      );
      expect(fake.requests).toHaveLength(2);
    });

    it('a refused connection (nothing listening) is "network" after one retry', async () => {
      const dead = new FakeResend();
      await dead.start();
      const url = dead.url;
      await dead.stop();
      expect(await failure(mailer({ apiUrl: url }))).toMatchObject({
        reason: 'network',
      });
    });
  });

  describe('nothing sensitive leaks', () => {
    const everythingLogged = () => JSON.stringify(logs);

    it('the error carries only the reason and status, not the provider text (which can quote an address)', async () => {
      fake.script = [
        {
          status: 403,
          json: {
            name: 'validation_error',
            message:
              'You can only send testing emails to your own email address (owner@resend-account.test).',
          },
        },
      ];
      const error = await failure(mailer());
      expect(error.message).toBe(
        'Mail delivery failed (test_mode_recipient, HTTP 403)',
      );
      expect(JSON.stringify(error)).not.toContain('resend-account');
      expect(String(error.stack)).not.toContain(API_KEY);
    });

    it.each([
      [[{ status: 500 }]],
      [['drop']],
      [
        [
          {
            status: 403,
            json: { name: 'validation_error', message: `testing emails ${TO}` },
          },
        ],
      ],
      [[{ status: 429, json: { name: 'daily_quota_exceeded' } }]],
    ])(
      'logs contain no recipient, link, token or API key (script %#)',
      async (script) => {
        fake.script = script as FakeResend['script'];
        await failure(mailer({ redirectTo: 'owner@resend-account.test' }));
        const text = everythingLogged();
        expect(text).not.toContain(TO);
        expect(text).not.toContain('resend-account');
        expect(text).not.toContain('SECRET-TOKEN');
        expect(text).not.toContain('accept-invite');
        expect(text).not.toContain(API_KEY);
      },
    );
  });
});

describe('classify', () => {
  it.each([
    [429, { name: 'daily_quota_exceeded', message: '' }, 'quota_daily'],
    [429, { name: 'monthly_quota_exceeded', message: '' }, 'quota_monthly'],
    [429, { name: 'rate_limit_exceeded', message: '' }, 'rate_limited'],
    [429, { name: '', message: '' }, 'rate_limited'],
    [401, { name: 'missing_api_key', message: '' }, 'auth'],
    [403, { name: 'invalid_permission', message: '' }, 'auth'],
    [403, { name: 'suspended_api_key', message: '' }, 'auth'],
    [
      403,
      {
        name: 'validation_error',
        message: 'Testing emails can only be sent to your own email address.',
      },
      'test_mode_recipient',
    ],
    [
      403,
      {
        name: 'validation_error',
        message: 'The domain in the from field is not verified.',
      },
      'unverified_domain',
    ],
    [
      403,
      {
        name: 'validation_error',
        message: "You've reached your plan's inbox limit.",
      },
      'invalid_request',
    ],
    [400, { name: 'validation_error', message: '' }, 'invalid_request'],
    [422, { name: 'missing_required_field', message: '' }, 'invalid_request'],
    [500, { name: 'application_error', message: '' }, 'provider_error'],
    [503, { name: 'service_unavailable', message: '' }, 'provider_error'],
  ])('%s %j is %s', (status, detail, reason) => {
    expect(classify(status, detail)).toBe(reason);
  });
});

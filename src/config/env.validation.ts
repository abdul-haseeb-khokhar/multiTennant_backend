import 'reflect-metadata';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';
import { parseTrustProxy } from './trust-proxy';

export class EnvironmentVariables {
  @IsString()
  @MinLength(1)
  DATABASE_URL: string;

  @IsString()
  @MinLength(16, { message: 'JWT_SECRET must be at least 16 characters' })
  JWT_SECRET: string;

  @IsOptional()
  @IsString()
  JWT_EXPIRES_IN: string = '1d';

  /** Lifetime of platform-admin tokens; kept shorter than staff tokens on purpose. */
  @IsOptional()
  @IsString()
  PLATFORM_JWT_EXPIRES_IN: string = '1h';

  /** Dashboard origin allowed by CORS. When unset, cross-origin browser calls are refused. */
  @IsOptional()
  @IsUrl({ require_tld: false })
  FRONTEND_URL?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  /**
   * Proxies in front of the app, so `req.ip` (audit log, rate limits) is the real client: a number
   * of hops (`1` behind the dashboard's server), or a list of addresses/CIDRs/`loopback`. Unset
   * trusts nobody. `true` is refused (see `parseTrustProxy`).
   */
  @IsOptional()
  @IsString()
  TRUST_PROXY?: string;

  @IsOptional()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: string = 'development';

  /**
   * How emailed links (invites, password reset, email verification) are delivered. `console`
   * logs them (ConsoleMailer, until a provider is chosen, H3). `link` additionally returns the
   * link in the API response so a developer can pass it on; it is refused in production.
   */
  @IsOptional()
  @IsIn(['console', 'link'])
  MAIL_MODE: string = 'console';

  /**
   * Who delivers the emails (H3). `console` (default) only logs them; `resend` sends them
   * through Resend and needs RESEND_API_KEY. Production refuses `console`.
   */
  @IsOptional()
  @IsIn(['console', 'resend'])
  MAIL_PROVIDER: string = 'console';

  /** A send-only Resend API key (MAIL_PROVIDER=resend). A secret: never logged or printed. */
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'RESEND_API_KEY looks too short' })
  RESEND_API_KEY?: string;

  /** Sender address. Default `onboarding@resend.dev` (Resend's test sender); later an address on a verified domain. */
  @IsOptional()
  @IsEmail()
  MAIL_FROM?: string;

  /** Sender name shown to recipients (the product name, not chosen yet; a neutral default is used). */
  @IsOptional()
  @Matches(/^[^<>"\u0000-\u001f]{1,80}$/, {
    message:
      'MAIL_FROM_NAME must be 1 to 80 characters without < > " or line breaks',
  })
  MAIL_FROM_NAME?: string;

  /**
   * Test stage only: every email goes to this one address (the Resend account's own) with the
   * intended recipient named in the subject and body. Production refuses it.
   */
  @IsOptional()
  @IsEmail()
  MAIL_REDIRECT_TO?: string;

  /**
   * Where the platform's own notifications go (J5): today an email when a tenant owner asks for a
   * plan upgrade. Optional; when unset the request is only stored. In the Resend test stage
   * MAIL_REDIRECT_TO still sends the message to the redirect address instead.
   */
  @IsOptional()
  @IsEmail()
  PLATFORM_ADMIN_NOTIFY_EMAIL?: string;

  /** Time allowed per attempt when calling the mail provider (default 5000 ms; one retry follows a network error or a 5xx). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(500)
  @Max(30_000)
  MAIL_TIMEOUT_MS: number = 5000;

  /** Base URL of the Resend API; only for tests against a fake server. Production refuses it. */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  RESEND_API_URL?: string;

  /**
   * The billing job that applies due plan transitions (Starter to Free, grace expiry). `off`
   * disables the timer on this instance; request-time checks stay correct either way.
   */
  @IsOptional()
  @IsIn(['on', 'off'])
  BILLING_JOB: string = 'on';

  /** How often the billing job sweeps (default 60 minutes; always at least daily). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  BILLING_JOB_INTERVAL_MINUTES: number = 60;

  /**
   * The job that re-delivers escalations the gateway could not hand to the engine
   * (`gateway_conversations.escalation_pending`). `off` disables the timer on this instance.
   */
  @IsOptional()
  @IsIn(['on', 'off'])
  ESCALATION_RETRY_JOB: string = 'on';

  /** How often that job sweeps, in seconds (default 60). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(3600)
  ESCALATION_RETRY_INTERVAL_SECONDS: number = 60;

  /**
   * Which AI engine the gateway talks to. `http` = the real engine (ENGINE_BASE_URL and
   * INTERNAL_API_TOKEN required); `mock` = the in-process mock engine, the default outside
   * production. Production must set `http` explicitly.
   */
  @IsOptional()
  @IsIn(['mock', 'http'])
  ENGINE_MODE?: string;

  /** Private address of the engine (ENGINE_MODE=http). */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  ENGINE_BASE_URL?: string;

  /** Service token shared with the engine (D2). At least 32 characters; never logged. */
  @IsOptional()
  @IsString()
  @MinLength(32, {
    message: 'INTERNAL_API_TOKEN must be at least 32 characters',
  })
  INTERNAL_API_TOKEN?: string;

  /** D7: time allowed until the first answer event of a reply stream. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(60_000)
  ENGINE_FIRST_TOKEN_TIMEOUT_MS: number = 5000;

  /** D7: time allowed for a whole reply stream. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(300_000)
  ENGINE_TOTAL_TIMEOUT_MS: number = 30_000;

  /** Time allowed for the engine's plain request/response calls. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(500)
  @Max(120_000)
  ENGINE_REQUEST_TIMEOUT_MS: number = 10_000;

  /** Pause between tokens of the mock engine's streamed reply (ENGINE_MODE=mock). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2000)
  MOCK_ENGINE_TOKEN_DELAY_MS: number = 25;
}

const MAIL_OPTIONAL_TEXT = [
  'RESEND_API_KEY',
  'MAIL_FROM',
  'MAIL_FROM_NAME',
  'MAIL_REDIRECT_TO',
  'RESEND_API_URL',
  'PLATFORM_ADMIN_NOTIFY_EMAIL',
];

/** Used by `ConfigModule.forRoot({ validate })`: the app refuses to start on a bad environment. */
export function validateEnv(rawConfig: Record<string, unknown>) {
  // `MAIL_REDIRECT_TO=` (or PLATFORM_ADMIN_NOTIFY_EMAIL=) left empty in .env means "not set", not "an invalid address".
  const config = { ...rawConfig };
  for (const name of MAIL_OPTIONAL_TEXT) {
    if (config[name] === '') delete config[name];
  }
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: false,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    const problems = errors
      .map(
        (e) =>
          `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('; ');
    // Names and rules only, never values: secrets must not reach the logs.
    throw new Error(`Invalid environment configuration (${problems})`);
  }

  const problems: string[] = [];
  try {
    parseTrustProxy(validated.TRUST_PROXY);
  } catch (error) {
    problems.push(
      error instanceof Error ? error.message : 'TRUST_PROXY invalid',
    );
  }
  if (validated.ENGINE_MODE === 'http') {
    if (!validated.ENGINE_BASE_URL) {
      problems.push('ENGINE_BASE_URL is required when ENGINE_MODE=http');
    }
    if (!validated.INTERNAL_API_TOKEN) {
      problems.push('INTERNAL_API_TOKEN is required when ENGINE_MODE=http');
    }
  }
  if (validated.MAIL_PROVIDER === 'resend' && !validated.RESEND_API_KEY) {
    problems.push('RESEND_API_KEY is required when MAIL_PROVIDER=resend');
  }
  if (validated.NODE_ENV === 'production') {
    if (validated.MAIL_PROVIDER !== 'resend') {
      problems.push(
        'MAIL_PROVIDER=resend is required when NODE_ENV=production (the console mailer only logs emails)',
      );
    }
    if (validated.MAIL_REDIRECT_TO) {
      problems.push(
        'MAIL_REDIRECT_TO is not allowed when NODE_ENV=production (it sends every email to one address)',
      );
    }
    if (validated.MAIL_FROM?.toLowerCase().endsWith('@resend.dev')) {
      problems.push(
        'MAIL_FROM must be an address on your verified domain when NODE_ENV=production (the resend.dev test sender only delivers to the Resend account owner)',
      );
    }
    if (validated.RESEND_API_URL) {
      problems.push(
        'RESEND_API_URL is not allowed when NODE_ENV=production (it is for tests)',
      );
    }
    if (validated.ENGINE_MODE !== 'http') {
      problems.push(
        'ENGINE_MODE=http is required when NODE_ENV=production (the mock engine is for development)',
      );
    }
    if (validated.MAIL_MODE === 'link') {
      problems.push('MAIL_MODE=link is not allowed when NODE_ENV=production');
    }
    if (!validated.FRONTEND_URL) {
      problems.push(
        'FRONTEND_URL is required when NODE_ENV=production (emailed links point at it)',
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration (${problems.join('; ')})`,
    );
  }
  return { ...config, ...validated };
}

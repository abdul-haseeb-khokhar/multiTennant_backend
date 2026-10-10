import 'reflect-metadata';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

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

/** Used by `ConfigModule.forRoot({ validate })`: the app refuses to start on a bad environment. */
export function validateEnv(config: Record<string, unknown>) {
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
  if (validated.ENGINE_MODE === 'http') {
    if (!validated.ENGINE_BASE_URL) {
      problems.push('ENGINE_BASE_URL is required when ENGINE_MODE=http');
    }
    if (!validated.INTERNAL_API_TOKEN) {
      problems.push('INTERNAL_API_TOKEN is required when ENGINE_MODE=http');
    }
  }
  if (validated.NODE_ENV === 'production') {
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

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
  return { ...config, ...validated };
}

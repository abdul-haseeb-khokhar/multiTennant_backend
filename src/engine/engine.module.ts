import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EngineClient } from './engine-client';
import { HttpEngineClient } from './http-engine.client';
import { MockEngineClient } from './mock-engine.client';

/**
 * Binds `EngineClient` to the implementation `ENGINE_MODE` selects: `http` (the real engine,
 * ENGINE_BASE_URL + INTERNAL_API_TOKEN) or `mock` (in-process, the default outside production).
 * Production must say `http` explicitly: env validation refuses to boot otherwise
 * (`src/config/env.validation.ts`).
 */
@Global()
@Module({
  providers: [
    {
      provide: EngineClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService): EngineClient => {
        const firstTokenTimeoutMs = config.get<number>(
          'ENGINE_FIRST_TOKEN_TIMEOUT_MS',
          5000,
        );
        const totalTimeoutMs = config.get<number>(
          'ENGINE_TOTAL_TIMEOUT_MS',
          30_000,
        );
        if (config.get<string>('ENGINE_MODE') === 'http') {
          return new HttpEngineClient({
            baseUrl: config.getOrThrow<string>('ENGINE_BASE_URL'),
            token: config.getOrThrow<string>('INTERNAL_API_TOKEN'),
            requestTimeoutMs: config.get<number>(
              'ENGINE_REQUEST_TIMEOUT_MS',
              10_000,
            ),
            firstTokenTimeoutMs,
            totalTimeoutMs,
          });
        }
        new Logger('Engine').warn(
          'ENGINE_MODE=mock: conversations are answered by the in-process mock engine (not for production)',
        );
        return new MockEngineClient({
          tokenDelayMs: config.get<number>('MOCK_ENGINE_TOKEN_DELAY_MS', 25),
          firstTokenTimeoutMs,
          totalTimeoutMs,
        });
      },
    },
  ],
  exports: [EngineClient],
})
export class EngineModule {}

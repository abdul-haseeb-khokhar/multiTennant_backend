import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { validateEnv } from '../config/env.validation';
import { EngineClient } from './engine-client';
import { EngineModule } from './engine.module';
import { HttpEngineClient } from './http-engine.client';
import { MockEngineClient } from './mock-engine.client';

async function engineFor(env: Record<string, unknown>) {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        ignoreEnvVars: true,
        load: [() => env],
      }),
      EngineModule,
    ],
  }).compile();
  return module.get(EngineClient);
}

describe('EngineModule: ENGINE_MODE selects the EngineClient', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_SECRET: 'a-secret-with-at-least-16-chars',
  };

  it('uses the mock by default', async () => {
    expect(await engineFor({})).toBeInstanceOf(MockEngineClient);
    expect(await engineFor({ ENGINE_MODE: 'mock' })).toBeInstanceOf(
      MockEngineClient,
    );
  });

  it('uses the HTTP client for ENGINE_MODE=http', async () => {
    const env = validateEnv({
      ...base,
      ENGINE_MODE: 'http',
      ENGINE_BASE_URL: 'http://engine.internal:4000',
      INTERNAL_API_TOKEN: 'z'.repeat(40),
    });
    expect(await engineFor(env)).toBeInstanceOf(HttpEngineClient);
  });
});

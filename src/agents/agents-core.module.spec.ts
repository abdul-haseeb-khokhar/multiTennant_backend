import { AgentsCoreModule } from './agents-core.module';
import { MockEngineClient } from '../engine/mock-engine.client';
import { HttpEngineClient } from '../engine/http-engine.client';

describe('AgentsCoreModule', () => {
  const pulled = {
    tenantId: 't1',
    agentId: 'a1',
    version: 2,
    status: 'active' as const,
    config: { businessName: 'Acme' },
    etag: '"x"',
  };

  it('connects the mock engine to the very service the pull route uses', async () => {
    const engine = new MockEngineClient();
    const pullForCall = jest.fn().mockResolvedValue(pulled);
    new AgentsCoreModule(engine, { pullForCall } as never).onModuleInit();
    const call = await engine.simulateCall('t1');
    expect(pullForCall).toHaveBeenCalledWith('t1', undefined);
    expect(call).toMatchObject({ agentId: 'a1', settingsVersion: 2 });
  });

  it('leaves the real engine client alone', () => {
    const engine = new HttpEngineClient({
      baseUrl: 'http://engine.invalid',
      token: 'x'.repeat(40),
      requestTimeoutMs: 1000,
      firstTokenTimeoutMs: 1000,
      totalTimeoutMs: 1000,
    });
    const pullForCall = jest.fn();
    expect(() =>
      new AgentsCoreModule(engine, { pullForCall } as never).onModuleInit(),
    ).not.toThrow();
    expect(pullForCall).not.toHaveBeenCalled();
  });
});

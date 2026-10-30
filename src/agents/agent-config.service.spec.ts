import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { ApiException } from '../common/errors/api.exception';
import { AgentConfigService, etagOf } from './agent-config.service';

const settings = (version: number) => ({
  tenantId: 't1',
  agentId: 'a1',
  version,
  document: { businessName: 'Acme', tone: 'friendly' },
});

describe('AgentConfigService (the engine pull, L7)', () => {
  let prisma: PrismaMock;
  let service: AgentConfigService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new AgentConfigService(prisma as never);
    prisma.agent.findFirst.mockResolvedValue({ id: 'a1', status: 'active' });
    prisma.agentSettings.findFirst.mockResolvedValue(settings(3));
  });

  it('returns the current version of an agent of this tenant, with its status and an ETag', async () => {
    const pulled = await service.pull('t1', 'a1');
    expect(prisma.agent.findFirst).toHaveBeenCalledWith({
      where: { id: 'a1', tenantId: 't1' },
      select: { id: true, status: true },
    });
    expect(prisma.agentSettings.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 't1', agentId: 'a1' },
      orderBy: { version: 'desc' },
    });
    expect(pulled).toEqual({
      tenantId: 't1',
      agentId: 'a1',
      version: 3,
      status: 'active',
      config: { businessName: 'Acme', tone: 'friendly' },
      etag: etagOf('a1', 3, 'active'),
    });
  });

  it('can pin a version (a call ticket names the version it was issued for)', async () => {
    prisma.agentSettings.findFirst.mockResolvedValue(settings(2));
    const pulled = await service.pull('t1', 'a1', 2);
    expect(prisma.agentSettings.findFirst).toHaveBeenCalledWith({
      where: { tenantId: 't1', agentId: 'a1', version: 2 },
    });
    expect(pulled.version).toBe(2);
  });

  it('a disabled agent is still returned, flagged, so the engine can play the "not available" message', async () => {
    prisma.agent.findFirst.mockResolvedValue({ id: 'a1', status: 'disabled' });
    const pulled = await service.pull('t1', 'a1');
    expect(pulled.status).toBe('disabled');
    expect(pulled.etag).not.toBe(etagOf('a1', 3, 'active'));
  });

  it('the ETag changes with the version and the status, and reveals neither', () => {
    const tags = new Set([
      etagOf('a1', 1, 'active'),
      etagOf('a1', 2, 'active'),
      etagOf('a1', 1, 'disabled'),
      etagOf('a2', 1, 'active'),
    ]);
    expect(tags.size).toBe(4);
    expect(etagOf('a1', 1, 'active')).toMatch(/^"[0-9a-f]{24}"$/);
  });

  it("an agent that is not this tenant's is AGENT_NOT_FOUND and its settings are never read", async () => {
    prisma.agent.findFirst.mockResolvedValue(null);
    await expect(service.pull('t1', 'a-of-t2')).rejects.toMatchObject({
      code: 'AGENT_NOT_FOUND',
    });
    expect(prisma.agentSettings.findFirst).not.toHaveBeenCalled();
  });

  it('an unknown version is AGENT_SETTINGS_VERSION_NOT_FOUND', async () => {
    prisma.agentSettings.findFirst.mockResolvedValue(null);
    const error = await service.pull('t1', 'a1', 99).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe(
      'AGENT_SETTINGS_VERSION_NOT_FOUND',
    );
  });

  describe('listForEngine (his GET /internal/tenants/{tenantId}/agents)', () => {
    it('lists the tenant agents default first, with the engine words, and only looks under the tenant', async () => {
      prisma.agent.findMany.mockResolvedValue([
        { id: 'a1', name: 'Front desk', status: 'active', isDefault: true },
        { id: 'a2', name: 'Branch', status: 'disabled', isDefault: false },
      ]);
      await expect(service.listForEngine('t1')).resolves.toEqual([
        {
          agentId: 'a1',
          name: 'Front desk',
          status: 'active',
          isDefault: true,
        },
        {
          agentId: 'a2',
          name: 'Branch',
          status: 'disabled',
          isDefault: false,
        },
      ]);
      expect(prisma.agent.findMany).toHaveBeenCalledWith({
        where: { tenantId: 't1' },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, status: true, isDefault: true },
      });
      // a tenant that has agents never needs the tenant lookup
      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    });

    it('an unknown tenant is 404 TENANT_NOT_FOUND, not an empty list', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.tenant.findUnique.mockResolvedValue(null);
      const error = await service
        .listForEngine('nope')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).getStatus()).toBe(404);
      expect((error as ApiException).code).toBe('TENANT_NOT_FOUND');
    });
  });

  describe('pullForCall', () => {
    it("without an agent id uses the tenant's default agent", async () => {
      prisma.agent.findFirst
        .mockResolvedValueOnce({ id: 'a1' })
        .mockResolvedValueOnce({ id: 'a1', status: 'active' });
      const pulled = await service.pullForCall('t1');
      expect(prisma.agent.findFirst).toHaveBeenNthCalledWith(1, {
        where: { tenantId: 't1', isDefault: true },
        select: { id: true },
      });
      expect(pulled?.agentId).toBe('a1');
    });

    it('with an id pulls that agent (still scoped to the tenant)', async () => {
      await service.pullForCall('t1', 'a1');
      expect(prisma.agent.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.agent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'a1', tenantId: 't1' } }),
      );
    });

    it('is null for a tenant without any agent', async () => {
      prisma.agent.findFirst.mockResolvedValue(null);
      await expect(service.pullForCall('t1')).resolves.toBeNull();
    });
  });
});

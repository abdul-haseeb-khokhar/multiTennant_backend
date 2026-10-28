import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { AgentProvisioningService } from './agent-provisioning.service';

const tenant = {
  id: 't1',
  name: 'Acme Dental',
  timezone: 'Asia/Karachi',
  defaultLocale: 'ur',
};

describe('AgentProvisioningService', () => {
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let service: AgentProvisioningService;

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new AgentProvisioningService(audit as never);
    prisma.agent.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'a1',
        status: 'active',
        ...data,
      }),
    );
    prisma.agentSettings.create.mockResolvedValue({});
  });

  it("creates the agent and settings version 1 from the tenant, in the caller's transaction", async () => {
    const agent = await service.provision(prisma as never, tenant, {
      isDefault: true,
      actor: { userId: 'u1', role: 'owner' },
    });
    expect(prisma.agent.create).toHaveBeenCalledWith({
      data: {
        tenantId: 't1',
        name: 'Acme Dental',
        isDefault: true,
        createdBy: 'u1',
      },
      omit: { createdBy: true },
    });
    expect(prisma.agentSettings.create).toHaveBeenCalledWith({
      data: {
        tenantId: 't1',
        agentId: 'a1',
        version: 1,
        document: expect.objectContaining({
          businessName: 'Acme Dental',
          timezone: 'Asia/Karachi',
          uiLocale: 'ur',
          replyLanguage: 'ur',
          collect: null,
        }),
        createdBy: 'u1',
      },
    });
    expect(agent.isDefault).toBe(true);
  });

  it('takes the name it is given, and has no creator without an actor', async () => {
    await service.provision(prisma as never, tenant, {
      name: 'Night desk',
      isDefault: false,
    });
    expect(prisma.agent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Night desk',
          isDefault: false,
          createdBy: null,
        }),
      }),
    );
  });

  it('audits agent.created inside the same transaction with the name, status and default flag only', async () => {
    await service.provision(prisma as never, tenant, {
      isDefault: true,
      actor: { userId: 'u1', role: 'owner' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      {
        tenantId: 't1',
        actor: { userId: 'u1', role: 'owner' },
        action: 'agent.created',
        targetType: 'agent',
        targetId: 'a1',
        after: { name: 'Acme Dental', status: 'active', isDefault: true },
      },
      prisma,
    );
  });
});

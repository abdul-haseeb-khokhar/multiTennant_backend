import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import { AgentNumbersCheck } from './agent-numbers.check';
import { AgentsService } from './agents.service';

const actor = { userId: 'u1', tenantId: 't1', role: 'owner' } as never;

const agentRow = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  tenantId: 't1',
  name: 'Acme',
  status: 'active',
  isDefault: false,
  createdAt: new Date('2026-10-28T00:00:00Z'),
  updatedAt: new Date('2026-10-28T00:00:00Z'),
  ...over,
});

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiException) {
      return [error.getStatus(), error.code];
    }
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('AgentsService', () => {
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let entitlements: { assertCountAvailable: jest.Mock };
  let provisioning: { provision: jest.Mock };
  let numbers: { countForAgent: jest.Mock };
  let service: AgentsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    entitlements = {
      assertCountAvailable: jest.fn().mockResolvedValue(undefined),
    };
    provisioning = {
      provision: jest.fn(async (_tx, _tenant, o) =>
        agentRow({ name: o.name, isDefault: o.isDefault }),
      ),
    };
    numbers = { countForAgent: jest.fn().mockResolvedValue(0) };
    service = new AgentsService(
      prisma as never,
      audit as never,
      entitlements as never,
      provisioning as never,
      numbers as unknown as AgentNumbersCheck,
    );
  });

  describe('create', () => {
    beforeEach(() => {
      prisma.tenant.findUnique.mockResolvedValue({
        id: 't1',
        name: 'Acme',
        timezone: 'Asia/Karachi',
        defaultLocale: 'en',
      });
    });

    it('checks the plan limit inside the transaction, then creates a non-default agent for the verified tenant', async () => {
      const created = await service.create('t1', { name: 'Night' }, actor);
      expect(entitlements.assertCountAvailable).toHaveBeenCalledWith(
        prisma,
        't1',
        'agents',
      );
      expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: 't1' },
        select: { id: true, name: true, timezone: true, defaultLocale: true },
      });
      expect(provisioning.provision).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ id: 't1' }),
        {
          name: 'Night',
          isDefault: false,
          actor: { userId: 'u1', role: 'owner' },
        },
      );
      expect(created.name).toBe('Night');
    });

    it('creates nothing when the plan limit is reached', async () => {
      entitlements.assertCountAvailable.mockRejectedValue(
        new ApiException(403, ErrorCode.PLAN_LIMIT_REACHED, 'limit'),
      );
      expect(
        await codeOf(service.create('t1', { name: 'Night' }, actor)),
      ).toEqual([403, 'PLAN_LIMIT_REACHED']);
      expect(provisioning.provision).not.toHaveBeenCalled();
    });

    it('409 AGENT_NAME_TAKEN when the name exists (unique, ignoring case)', async () => {
      provisioning.provision.mockRejectedValue(prismaError('P2002'));
      expect(
        await codeOf(service.create('t1', { name: 'Night' }, actor)),
      ).toEqual([409, 'AGENT_NAME_TAKEN']);
    });

    it('404 when the tenant vanished', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      expect(await codeOf(service.create('t1', { name: 'N' }, actor))).toEqual([
        404,
        'TENANT_NOT_FOUND',
      ]);
    });
  });

  describe('findAll / findOne', () => {
    it('scopes the list to the tenant, default first, in the page envelope, without createdBy', async () => {
      prisma.agent.findMany.mockResolvedValue([agentRow()]);
      prisma.agent.count.mockResolvedValue(1);
      const page = await service.findAll('t1', { skip: 0, take: 20 });
      expect(prisma.agent.findMany).toHaveBeenCalledWith({
        where: { tenantId: 't1' },
        skip: 0,
        take: 20,
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        omit: { createdBy: true },
      });
      expect(prisma.agent.count).toHaveBeenCalledWith({
        where: { tenantId: 't1' },
      });
      expect(page).toEqual({
        data: [expect.objectContaining({ id: 'a1' })],
        total: 1,
        skip: 0,
        take: 20,
      });
    });

    it('filters by status and caps take at 100', async () => {
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.agent.count.mockResolvedValue(0);
      const page = await service.findAll('t1', {
        status: 'disabled',
        take: 500,
      });
      expect(prisma.agent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 't1', status: 'disabled' },
          take: 100,
        }),
      );
      expect(page.take).toBe(100);
    });

    it('findOne looks the agent up by id AND tenant; another tenant gets 404 AGENT_NOT_FOUND', async () => {
      prisma.agent.findFirst.mockResolvedValue(null);
      expect(await codeOf(service.findOne('t1', 'a-of-t2'))).toEqual([
        404,
        'AGENT_NOT_FOUND',
      ]);
      expect(prisma.agent.findFirst).toHaveBeenCalledWith({
        where: { id: 'a-of-t2', tenantId: 't1' },
        omit: { createdBy: true },
      });
    });
  });

  describe('update', () => {
    const find = (row: Record<string, unknown> | null) =>
      prisma.agent.findFirst.mockResolvedValue(row);

    it('renames inside one transaction, scopes the write to the tenant and audits agent.renamed with names only', async () => {
      find(agentRow());
      prisma.agent.updateMany.mockResolvedValue({ count: 1 });
      prisma.agent.findFirstOrThrow.mockResolvedValue(
        agentRow({ name: 'Front desk' }),
      );
      const after = await service.update(
        't1',
        'a1',
        { name: 'Front desk' },
        actor,
      );
      expect(prisma.agent.updateMany).toHaveBeenCalledWith({
        where: { id: 'a1', tenantId: 't1' },
        data: { name: 'Front desk' },
      });
      expect(after.name).toBe('Front desk');
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 't1',
          action: 'agent.renamed',
          targetType: 'agent',
          targetId: 'a1',
          before: { name: 'Acme' },
          after: { name: 'Front desk' },
        }),
        prisma,
      );
    });

    it('disables (audit agent.disabled) and enables (agent.enabled)', async () => {
      find(agentRow());
      prisma.agent.updateMany.mockResolvedValue({ count: 1 });
      prisma.agent.findFirstOrThrow.mockResolvedValue(
        agentRow({ status: 'disabled' }),
      );
      await service.update('t1', 'a1', { status: 'disabled' }, actor);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({
          action: 'agent.disabled',
          before: { status: 'active' },
          after: { status: 'disabled' },
        }),
        prisma,
      );
      find(agentRow({ status: 'disabled' }));
      prisma.agent.findFirstOrThrow.mockResolvedValue(agentRow());
      await service.update('t1', 'a1', { status: 'active' }, actor);
      expect(audit.record).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'agent.enabled' }),
        prisma,
      );
    });

    it('writes one audit entry per change when both name and status change', async () => {
      find(agentRow());
      prisma.agent.updateMany.mockResolvedValue({ count: 1 });
      prisma.agent.findFirstOrThrow.mockResolvedValue(
        agentRow({ name: 'X', status: 'disabled' }),
      );
      await service.update(
        't1',
        'a1',
        { name: 'X', status: 'disabled' },
        actor,
      );
      expect(audit.record.mock.calls.map(([e]) => e.action)).toEqual([
        'agent.renamed',
        'agent.disabled',
      ]);
    });

    it('changing nothing writes nothing and audits nothing', async () => {
      find(agentRow());
      const same = await service.update(
        't1',
        'a1',
        { name: 'Acme', status: 'active' },
        actor,
      );
      expect(same.id).toBe('a1');
      expect(prisma.agent.updateMany).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('refuses to disable an agent that has phone numbers (AGENT_HAS_NUMBERS) and changes nothing', async () => {
      find(agentRow());
      numbers.countForAgent.mockResolvedValue(2);
      expect(
        await codeOf(service.update('t1', 'a1', { status: 'disabled' }, actor)),
      ).toEqual([409, 'AGENT_HAS_NUMBERS']);
      expect(numbers.countForAgent).toHaveBeenCalledWith('t1', 'a1', prisma);
      expect(prisma.agent.updateMany).not.toHaveBeenCalled();
    });

    it('renaming or enabling is allowed even with numbers', async () => {
      numbers.countForAgent.mockResolvedValue(2);
      find(agentRow());
      prisma.agent.updateMany.mockResolvedValue({ count: 1 });
      prisma.agent.findFirstOrThrow.mockResolvedValue(agentRow({ name: 'Y' }));
      await expect(
        service.update('t1', 'a1', { name: 'Y' }, actor),
      ).resolves.toMatchObject({ name: 'Y' });
    });

    it('the default agent can be renamed and disabled', async () => {
      find(agentRow({ isDefault: true }));
      prisma.agent.updateMany.mockResolvedValue({ count: 1 });
      prisma.agent.findFirstOrThrow.mockResolvedValue(
        agentRow({ isDefault: true, status: 'disabled' }),
      );
      await expect(
        service.update('t1', 'a1', { status: 'disabled' }, actor),
      ).resolves.toMatchObject({ status: 'disabled' });
    });

    it('404 for an agent of another tenant, 409 AGENT_NAME_TAKEN on a clashing rename', async () => {
      find(null);
      expect(
        await codeOf(service.update('t1', 'a-of-t2', { name: 'Z' }, actor)),
      ).toEqual([404, 'AGENT_NOT_FOUND']);
      find(agentRow());
      prisma.agent.updateMany.mockRejectedValue(prismaError('P2002'));
      expect(
        await codeOf(service.update('t1', 'a1', { name: 'Z' }, actor)),
      ).toEqual([409, 'AGENT_NAME_TAKEN']);
    });

    it('404 when the agent disappears between the read and the write', async () => {
      find(agentRow());
      prisma.agent.updateMany.mockResolvedValue({ count: 0 });
      expect(
        await codeOf(service.update('t1', 'a1', { name: 'Z' }, actor)),
      ).toEqual([404, 'AGENT_NOT_FOUND']);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes a non-default agent scoped to the tenant and audits agent.deleted without settings', async () => {
      prisma.agent.findFirst.mockResolvedValue(agentRow());
      prisma.agent.deleteMany.mockResolvedValue({ count: 1 });
      const removed = await service.remove('t1', 'a1', actor);
      expect(prisma.agent.deleteMany).toHaveBeenCalledWith({
        where: { id: 'a1', tenantId: 't1', isDefault: false },
      });
      expect(removed.id).toBe('a1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'agent.deleted',
          targetId: 'a1',
          before: { name: 'Acme', status: 'active' },
        }),
        prisma,
      );
    });

    it('refuses the default agent (CANNOT_DELETE_DEFAULT_AGENT) before anything else', async () => {
      prisma.agent.findFirst.mockResolvedValue(agentRow({ isDefault: true }));
      expect(await codeOf(service.remove('t1', 'a1', actor))).toEqual([
        409,
        'CANNOT_DELETE_DEFAULT_AGENT',
      ]);
      expect(prisma.agent.deleteMany).not.toHaveBeenCalled();
      expect(numbers.countForAgent).not.toHaveBeenCalled();
    });

    it('refuses an agent that has phone numbers (AGENT_HAS_NUMBERS)', async () => {
      prisma.agent.findFirst.mockResolvedValue(agentRow());
      numbers.countForAgent.mockResolvedValue(1);
      expect(await codeOf(service.remove('t1', 'a1', actor))).toEqual([
        409,
        'AGENT_HAS_NUMBERS',
      ]);
      expect(prisma.agent.deleteMany).not.toHaveBeenCalled();
    });

    it('maps a foreign-key refusal (a number assigned at the same moment) to AGENT_HAS_NUMBERS', async () => {
      prisma.agent.findFirst.mockResolvedValue(agentRow());
      prisma.agent.deleteMany.mockRejectedValue(prismaError('P2003'));
      expect(await codeOf(service.remove('t1', 'a1', actor))).toEqual([
        409,
        'AGENT_HAS_NUMBERS',
      ]);
    });

    it('404 for an agent of another tenant', async () => {
      prisma.agent.findFirst.mockResolvedValue(null);
      expect(await codeOf(service.remove('t1', 'a-of-t2', actor))).toEqual([
        404,
        'AGENT_NOT_FOUND',
      ]);
      expect(prisma.agent.deleteMany).not.toHaveBeenCalled();
    });
  });
});

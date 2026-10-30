import { ApiException } from '../common/errors/api.exception';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import { buildDefaultSettings } from './agent-settings.defaults';
import { AgentSettingsService } from './agent-settings.service';
import {
  AgentSettingsValidator,
  StructuralAgentSettingsValidator,
} from './agent-settings.validator';

const actor = { userId: 'u1', tenantId: 't1', role: 'admin' } as never;
const doc = () =>
  buildDefaultSettings({
    tenantName: 'Acme',
    timezone: 'Asia/Karachi',
    defaultLocale: 'en',
  }) as unknown as Record<string, unknown>;

const row = (version: number, document = doc()) => ({
  id: `s${version}`,
  tenantId: 't1',
  agentId: 'a1',
  version,
  document,
  createdBy: version === 1 ? null : 'u1',
  createdAt: new Date('2026-10-28T00:00:00Z'),
});

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiException) {
      return {
        status: error.getStatus(),
        code: error.code,
        body: error.getResponse() as Record<string, unknown>,
      };
    }
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('AgentSettingsService', () => {
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let validator: AgentSettingsValidator;
  let service: AgentSettingsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    validator = new StructuralAgentSettingsValidator();
    service = new AgentSettingsService(
      prisma as never,
      audit as never,
      validator,
    );
    prisma.agent.findFirst.mockResolvedValue({ id: 'a1' });
  });

  describe('reading', () => {
    it('returns the highest version, looking the agent up by tenant first', async () => {
      prisma.agentSettings.findFirst.mockResolvedValue(row(3));
      const current = await service.getCurrent('t1', 'a1');
      expect(prisma.agent.findFirst).toHaveBeenCalledWith({
        where: { id: 'a1', tenantId: 't1' },
        select: { id: true },
      });
      expect(prisma.agentSettings.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 't1', agentId: 'a1' },
        orderBy: { version: 'desc' },
      });
      expect(current).toMatchObject({ agentId: 'a1', version: 3 });
      expect(current.document).toEqual(doc());
    });

    it('an agent of another tenant is AGENT_NOT_FOUND on every read, before settings are touched', async () => {
      prisma.agent.findFirst.mockResolvedValue(null);
      for (const read of [
        () => service.getCurrent('t1', 'a-of-t2'),
        () => service.getVersion('t1', 'a-of-t2', 1),
        () => service.listVersions('t1', 'a-of-t2', {}),
        () =>
          service.update(
            't1',
            'a-of-t2',
            { expectedVersion: 1, settings: { tone: 'friendly' } },
            actor,
          ),
      ]) {
        expect((await failure(read())).code).toBe('AGENT_NOT_FOUND');
      }
      expect(prisma.agentSettings.findFirst).not.toHaveBeenCalled();
      expect(prisma.agentSettings.findMany).not.toHaveBeenCalled();
      expect(prisma.agentSettings.create).not.toHaveBeenCalled();
    });

    it('lists versions newest first without the documents, in the page envelope', async () => {
      prisma.agentSettings.findMany.mockResolvedValue([
        { ...row(2), document: undefined },
        { ...row(1), document: undefined },
      ]);
      prisma.agentSettings.count.mockResolvedValue(2);
      const page = await service.listVersions('t1', 'a1', {});
      expect(prisma.agentSettings.findMany).toHaveBeenCalledWith({
        where: { tenantId: 't1', agentId: 'a1' },
        skip: 0,
        take: 20,
        orderBy: { version: 'desc' },
        omit: { document: true },
      });
      expect(page.total).toBe(2);
      expect(page.data.map((v) => v.version)).toEqual([2, 1]);
      expect(page.data[0]).not.toHaveProperty('document');
    });

    it('reads one past version, or 404 AGENT_SETTINGS_VERSION_NOT_FOUND', async () => {
      prisma.agentSettings.findFirst.mockResolvedValueOnce(row(1));
      await expect(service.getVersion('t1', 'a1', 1)).resolves.toMatchObject({
        version: 1,
      });
      expect(prisma.agentSettings.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 't1', agentId: 'a1', version: 1 },
      });
      prisma.agentSettings.findFirst.mockResolvedValueOnce(null);
      expect((await failure(service.getVersion('t1', 'a1', 9))).code).toBe(
        'AGENT_SETTINGS_VERSION_NOT_FOUND',
      );
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.agentSettings.findFirst.mockResolvedValue(row(1));
      prisma.agentSettings.create.mockImplementation(
        async ({ data }: { data: { version: number; document: object } }) => ({
          ...row(data.version),
          document: data.document,
        }),
      );
    });

    it('adds version n+1 with the keys sent merged over the current document, by the acting user, and audits version numbers only', async () => {
      const saved = await service.update(
        't1',
        'a1',
        {
          expectedVersion: 1,
          settings: {
            tone: 'friendly',
            escalation: {
              enabled: true,
              contacts: [
                {
                  id: 'c1',
                  role: 'Doctor',
                  name: 'Dr A',
                  phone: '+923001234567',
                },
              ],
              whenCallerAsks: true,
              afterMisses: 2,
              topics: [],
              outsideHours: 'callback',
            },
          },
        },
        actor,
      );
      expect(prisma.agentSettings.create).toHaveBeenCalledWith({
        data: {
          tenantId: 't1',
          agentId: 'a1',
          version: 2,
          document: expect.objectContaining({
            tone: 'friendly',
            businessName: 'Acme',
          }),
          createdBy: 'u1',
        },
      });
      expect(saved.version).toBe(2);
      const entry = audit.record.mock.calls[0][0];
      expect(entry).toEqual({
        tenantId: 't1',
        actor: { userId: 'u1', role: 'admin' },
        action: 'agent.settings_updated',
        targetType: 'agent',
        targetId: 'a1',
        before: { version: 1 },
        after: { version: 2 },
      });
      // no document content, no phone number, anywhere in the audit entry
      expect(JSON.stringify(entry)).not.toContain('923001234567');
      expect(JSON.stringify(entry)).not.toContain('friendly');
      expect(audit.record.mock.calls[0][1]).toBe(prisma);
    });

    it('never edits an older version: the only write is the insert of the next one', async () => {
      await service.update(
        't1',
        'a1',
        { expectedVersion: 1, settings: { purpose: 'Answer calls' } },
        actor,
      );
      expect(prisma.agentSettings.create).toHaveBeenCalledTimes(1);
      expect(Object.keys(prisma.agentSettings)).not.toContain('update');
    });

    it('409 AGENT_SETTINGS_VERSION_CONFLICT with currentVersion when expectedVersion is stale; nothing is written', async () => {
      prisma.agentSettings.findFirst.mockResolvedValue(row(4));
      const failed = await failure(
        service.update(
          't1',
          'a1',
          { expectedVersion: 3, settings: { tone: 'friendly' } },
          actor,
        ),
      );
      expect(failed).toMatchObject({
        status: 409,
        code: 'AGENT_SETTINGS_VERSION_CONFLICT',
      });
      expect(failed.body.currentVersion).toBe(4);
      expect(prisma.agentSettings.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('a lost race for the same version number (unique key) is the same conflict, with the real latest version', async () => {
      prisma.agentSettings.create.mockRejectedValue(prismaError('P2002'));
      prisma.agentSettings.findFirst
        .mockResolvedValueOnce(row(1))
        .mockResolvedValueOnce({ version: 2 });
      const failed = await failure(
        service.update(
          't1',
          'a1',
          { expectedVersion: 1, settings: { tone: 'concise' } },
          actor,
        ),
      );
      expect(failed).toMatchObject({
        status: 409,
        code: 'AGENT_SETTINGS_VERSION_CONFLICT',
      });
      expect(failed.body.currentVersion).toBe(2);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('400 AGENT_SETTINGS_INVALID with field-level details; nothing is written', async () => {
      const failed = await failure(
        service.update(
          't1',
          'a1',
          {
            expectedVersion: 1,
            settings: { tone: 'angry', timezone: 'Mars/Base' },
          },
          actor,
        ),
      );
      expect(failed).toMatchObject({
        status: 400,
        code: 'AGENT_SETTINGS_INVALID',
      });
      expect(failed.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'tone', code: 'not_allowed' }),
          { field: 'timezone', code: 'invalid_timezone' },
        ]),
      );
      expect(prisma.agentSettings.create).not.toHaveBeenCalled();
    });

    it('an unknown key is refused, not silently stored', async () => {
      const failed = await failure(
        service.update(
          't1',
          'a1',
          { expectedVersion: 1, settings: { greetingText: 'hi' } },
          actor,
        ),
      );
      expect(failed.body.details).toEqual([
        { field: 'greetingText', code: 'unknown_field' },
      ]);
    });

    it('a save that changes nothing adds no version and no audit entry', async () => {
      const same = await service.update(
        't1',
        'a1',
        { expectedVersion: 1, settings: { tone: 'professional' } },
        actor,
      );
      expect(same.version).toBe(1);
      expect(prisma.agentSettings.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('validates outside the transaction, so a validator that calls the engine never holds a database lock', async () => {
      const slow: AgentSettingsValidator = {
        validate: jest.fn(async (input: unknown) => {
          expect(prisma.$transaction).not.toHaveBeenCalled();
          return new StructuralAgentSettingsValidator().check(input);
        }),
      };
      const withSlow = new AgentSettingsService(
        prisma as never,
        audit as never,
        slow,
      );
      await withSlow.update(
        't1',
        'a1',
        { expectedVersion: 1, settings: { tone: 'formal' } },
        actor,
      );
      expect(slow.validate).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('404 when the agent is deleted between the read and the insert (foreign key)', async () => {
      prisma.agentSettings.create.mockRejectedValue(prismaError('P2003'));
      expect(
        (
          await failure(
            service.update(
              't1',
              'a1',
              { expectedVersion: 1, settings: { tone: 'formal' } },
              actor,
            ),
          )
        ).code,
      ).toBe('AGENT_NOT_FOUND');
    });
  });
});

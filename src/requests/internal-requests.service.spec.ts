import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
  prismaError,
} from '../../test/utils/prisma-mock';
import { ApiException } from '../common/errors/api.exception';
import { CreateRequestDto } from './dto/create-request.dto';
import { InternalRequestsService } from './internal-requests.service';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  agentId: 'ag1',
  reference: 'AP-4K7Q2',
  type: 'appointment',
  status: 'requested',
  cancelledBy: null,
  updatedAt: new Date('2026-10-29T10:00:00Z'),
  ...over,
});

const dto = (over: Record<string, unknown> = {}) =>
  ({
    reference: 'AP-4K7Q2',
    type: 'appointment',
    submissionKey: 'call-1',
    endCustomerId: 'ec1',
    summary: 'Ahmed wants a check-up',
    scheduledLocal: '2026-11-05 15:30',
    data: { service: 'check-up' },
    ...over,
  }) as CreateRequestDto;

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiException) return [error.getStatus(), error.code];
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('InternalRequestsService', () => {
  let prisma: PrismaMock;
  let notifications: {
    activeStaffIds: jest.Mock;
    create: jest.Mock;
    announce: jest.Mock;
  };
  let live: { created: jest.Mock; updated: jest.Mock };
  let service: InternalRequestsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    prisma.tenant.findUnique.mockResolvedValue({ id: 't1' });
    prisma.customerRequest.findFirst.mockResolvedValue(null);
    prisma.agent.findFirst.mockResolvedValue({ id: 'ag1', name: 'Front desk' });
    prisma.endCustomer.findFirst.mockResolvedValue({ id: 'ec1' });
    prisma.customerRequest.create.mockResolvedValue(row());
    notifications = {
      activeStaffIds: jest.fn().mockResolvedValue(['u1', 'u2']),
      create: jest.fn().mockResolvedValue([{ id: 'n1', userId: 'u1' }]),
      announce: jest.fn(),
    };
    live = { created: jest.fn(), updated: jest.fn() };
    service = new InternalRequestsService(
      prisma as never,
      notifications as never,
      live as never,
    );
  });

  describe('create', () => {
    it('looks up the repeat, the agent and the customer UNDER the tenant, then saves with the tenant and agent in the row', async () => {
      await expect(service.create('t1', dto())).resolves.toEqual({
        id: 'r1',
        agentId: 'ag1',
        reference: 'AP-4K7Q2',
        type: 'appointment',
        status: 'requested',
        created: true,
      });
      expect(prisma.customerRequest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 't1', submissionKey: 'call-1' },
        }),
      );
      expect(prisma.agent.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 't1', isDefault: true },
        select: { id: true, name: true },
      });
      expect(prisma.endCustomer.findFirst).toHaveBeenCalledWith({
        where: { id: 'ec1', tenantId: 't1' },
        select: { id: true },
      });
      expect(prisma.customerRequest.create.mock.calls[0][0].data).toMatchObject(
        {
          tenantId: 't1',
          agentId: 'ag1',
          endCustomerId: 'ec1',
          reference: 'AP-4K7Q2',
          source: 'call',
          channel: 'voice',
          details: { service: 'check-up' },
        },
      );
    });

    it('saves in ONE transaction with its notification, and announces only after the commit', async () => {
      const order: string[] = [];
      prisma.customerRequest.create.mockImplementation(() => {
        order.push('create');
        return Promise.resolve(row());
      });
      notifications.create.mockImplementation(() => {
        order.push('notify');
        return Promise.resolve([{ id: 'n1', userId: 'u1' }]);
      });
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const result = await fn(prisma);
        order.push('commit');
        return result;
      });
      notifications.announce.mockImplementation(() => order.push('announce'));
      live.created.mockImplementation(() => order.push('live'));
      await service.create('t1', dto());
      expect(order).toEqual(['create', 'notify', 'commit', 'announce', 'live']);
      expect(notifications.activeStaffIds).toHaveBeenCalledWith(
        't1',
        undefined,
        prisma,
      );
      expect(notifications.create.mock.calls[0][2]).toMatchObject({
        type: 'request.submitted',
        dedupeKey: 'request:r1:submitted',
        params: {
          requestId: 'r1',
          reference: 'AP-4K7Q2',
          requestType: 'appointment',
          agentId: 'ag1',
          agentName: 'Front desk',
        },
      });
    });

    it('a repeated submissionKey returns the stored request (created false) and touches nothing else', async () => {
      prisma.customerRequest.findFirst.mockResolvedValue(row());
      await expect(service.create('t1', dto())).resolves.toMatchObject({
        id: 'r1',
        created: false,
      });
      expect(prisma.customerRequest.create).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
      expect(live.created).not.toHaveBeenCalled();
      expect(prisma.agent.findFirst).not.toHaveBeenCalled();
    });

    it("two parallel saves of one call: the loser of the unique index gets the winner's request", async () => {
      prisma.customerRequest.findFirst
        .mockResolvedValueOnce(null) // the first look: not there yet
        .mockResolvedValue(row({ id: 'winner' })); // after the collision
      prisma.customerRequest.create.mockRejectedValue(prismaError('P2002'));
      await expect(service.create('t1', dto())).resolves.toMatchObject({
        id: 'winner',
        created: false,
      });
      expect(notifications.announce).not.toHaveBeenCalled();
    });

    it("a collision with another request's reference is 409 REQUEST_REFERENCE_TAKEN", async () => {
      prisma.customerRequest.create.mockRejectedValue(prismaError('P2002'));
      expect(await codeOf(service.create('t1', dto()))).toEqual([
        409,
        'REQUEST_REFERENCE_TAKEN',
      ]);
      expect(notifications.announce).not.toHaveBeenCalled();
      expect(live.created).not.toHaveBeenCalled();
    });

    it('an agent or customer deleted between the lookup and the insert (foreign key refusal) is a 404, not a 500', async () => {
      prisma.customerRequest.create.mockRejectedValue(prismaError('P2003'));
      prisma.agent.findFirst
        .mockResolvedValueOnce({ id: 'ag1', name: 'Front desk' }) // the lookup
        .mockResolvedValueOnce(null); // gone by the time of the refusal
      expect(await codeOf(service.create('t1', dto()))).toEqual([
        404,
        'AGENT_NOT_FOUND',
      ]);
      prisma.agent.findFirst
        .mockResolvedValueOnce({ id: 'ag1', name: 'Front desk' })
        .mockResolvedValueOnce({ id: 'ag1' }); // the agent is still there: the customer went
      expect(await codeOf(service.create('t1', dto()))).toEqual([
        404,
        'CUSTOMER_NOT_FOUND',
      ]);
      expect(notifications.announce).not.toHaveBeenCalled();
    });

    it('an agent of another tenant is AGENT_NOT_FOUND (the lookup carries the path tenant and the named id)', async () => {
      prisma.agent.findFirst.mockResolvedValue(null);
      expect(
        await codeOf(service.create('t1', dto({ agentId: 'ag-b' }))),
      ).toEqual([404, 'AGENT_NOT_FOUND']);
      expect(prisma.agent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'ag-b', tenantId: 't1' } }),
      );
      expect(prisma.customerRequest.create).not.toHaveBeenCalled();
    });

    it('a customer of another tenant is CUSTOMER_NOT_FOUND', async () => {
      prisma.endCustomer.findFirst.mockResolvedValue(null);
      expect(await codeOf(service.create('t1', dto()))).toEqual([
        404,
        'CUSTOMER_NOT_FOUND',
      ]);
      expect(prisma.customerRequest.create).not.toHaveBeenCalled();
    });

    it('an unknown tenant is TENANT_NOT_FOUND', async () => {
      prisma.tenant.findUnique.mockResolvedValue(null);
      expect(await codeOf(service.create('nope', dto()))).toEqual([
        404,
        'TENANT_NOT_FOUND',
      ]);
    });

    it('refuses a collected document over 16 KB before any query about the request', async () => {
      expect(
        await codeOf(
          service.create('t1', dto({ data: { x: 'y'.repeat(17_000) } })),
        ),
      ).toEqual([400, 'VALIDATION_ERROR']);
      expect(prisma.customerRequest.create).not.toHaveBeenCalled();
    });

    it('lets any other database error through (a 500, not a wrong answer)', async () => {
      prisma.customerRequest.create.mockRejectedValue(new Error('boom'));
      await expect(service.create('t1', dto())).rejects.toThrow('boom');
    });
  });

  describe('updateDetails: a conditional update on status = requested', () => {
    it('sends the tenant, the reference and the required status in the where, and only the fields given', async () => {
      prisma.customerRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.customerRequest.findFirst.mockResolvedValue(row());
      await service.updateDetails('t1', 'AP-4K7Q2', {
        summary: 'Friday',
        data: { service: 'cleaning' },
      });
      expect(prisma.customerRequest.updateMany).toHaveBeenCalledWith({
        where: { tenantId: 't1', reference: 'AP-4K7Q2', status: 'requested' },
        data: { summary: 'Friday', details: { service: 'cleaning' } },
      });
      expect(live.updated).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ id: 'r1' }),
      );
    });

    it('can clear the scheduled time with null', async () => {
      prisma.customerRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.customerRequest.findFirst.mockResolvedValue(row());
      await service.updateDetails('t1', 'AP-4K7Q2', { scheduledLocal: null });
      expect(prisma.customerRequest.updateMany.mock.calls[0][0].data).toEqual({
        scheduledLocal: null,
      });
    });

    it('matching nothing because a person acted is 409 REQUEST_LOCKED; because there is no such request, 404', async () => {
      prisma.customerRequest.updateMany.mockResolvedValue({ count: 0 });
      prisma.customerRequest.findFirst.mockResolvedValue(
        row({ status: 'confirmed' }),
      );
      expect(
        await codeOf(service.updateDetails('t1', 'AP-4K7Q2', { summary: 'x' })),
      ).toEqual([409, 'REQUEST_LOCKED']);
      prisma.customerRequest.findFirst.mockResolvedValue(null);
      expect(
        await codeOf(service.updateDetails('t1', 'AP-NOPE0', { summary: 'x' })),
      ).toEqual([404, 'REQUEST_NOT_FOUND']);
      expect(live.updated).not.toHaveBeenCalled();
    });

    it('an update with nothing in it is a 400 and touches nothing', async () => {
      expect(await codeOf(service.updateDetails('t1', 'AP-4K7Q2', {}))).toEqual(
        [400, 'VALIDATION_ERROR'],
      );
      expect(prisma.customerRequest.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('withdraw', () => {
    it('cancels a requested request for the caller, conditional on requested', async () => {
      prisma.customerRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.customerRequest.findFirst.mockResolvedValue(
        row({ status: 'cancelled', cancelledBy: 'caller' }),
      );
      await expect(
        service.withdraw('t1', 'AP-4K7Q2', { reason: 'changed their mind' }),
      ).resolves.toMatchObject({ status: 'cancelled', created: false });
      const call = prisma.customerRequest.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({
        tenantId: 't1',
        reference: 'AP-4K7Q2',
        status: 'requested',
      });
      expect(call.data).toMatchObject({
        status: 'cancelled',
        cancelledBy: 'caller',
        statusChangedBy: null,
        note: 'changed their mind',
      });
    });

    it('withdrawing twice is harmless, withdrawing what a person acted on is locked', async () => {
      prisma.customerRequest.updateMany.mockResolvedValue({ count: 0 });
      prisma.customerRequest.findFirst.mockResolvedValue(
        row({ status: 'cancelled', cancelledBy: 'caller' }),
      );
      await expect(
        service.withdraw('t1', 'AP-4K7Q2', {}),
      ).resolves.toMatchObject({
        status: 'cancelled',
      });
      prisma.customerRequest.findFirst.mockResolvedValue(
        row({ status: 'cancelled', cancelledBy: 'staff' }),
      );
      expect(await codeOf(service.withdraw('t1', 'AP-4K7Q2', {}))).toEqual([
        409,
        'REQUEST_LOCKED',
      ]);
      prisma.customerRequest.findFirst.mockResolvedValue(
        row({ status: 'confirmed' }),
      );
      expect(await codeOf(service.withdraw('t1', 'AP-4K7Q2', {}))).toEqual([
        409,
        'REQUEST_LOCKED',
      ]);
      prisma.customerRequest.findFirst.mockResolvedValue(null);
      expect(await codeOf(service.withdraw('t1', 'AP-NOPE0', {}))).toEqual([
        404,
        'REQUEST_NOT_FOUND',
      ]);
    });
  });
});

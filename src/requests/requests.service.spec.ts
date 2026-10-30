import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
} from '../../test/utils/prisma-mock';
import { ApiException } from '../common/errors/api.exception';
import { RequestsService } from './requests.service';

const actor = { userId: 'u1', tenantId: 't1', role: 'agent' } as never;

const detail = (over: Record<string, unknown> = {}) => ({
  id: 'q1',
  reference: 'AP-4K7Q2',
  type: 'appointment',
  status: 'confirmed',
  channel: 'voice',
  language: 'ur',
  summary: 'Ahmed wants a check-up',
  scheduledLocal: '2026-11-05 15:30',
  timezone: 'Asia/Karachi',
  configVersion: 3,
  conversationId: 'conv-1',
  note: null,
  cancelledBy: null,
  statusChangedAt: new Date('2026-10-29T10:00:00Z'),
  statusChangedBy: 'u1',
  createdAt: new Date('2026-10-29T09:00:00Z'),
  updatedAt: new Date('2026-10-29T10:00:00Z'),
  details: { service: 'check-up' },
  agent: { id: 'ag1', name: 'Front desk' },
  customer: {
    id: 'ec1',
    name: 'Ahmed',
    externalId: 'phone_+923001234567',
    locale: 'ur',
  },
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

describe('RequestsService (staff)', () => {
  let prisma: PrismaMock;
  let audit: { record: jest.Mock };
  let live: { updated: jest.Mock };
  let service: RequestsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    live = { updated: jest.fn() };
    service = new RequestsService(
      prisma as never,
      audit as never,
      live as never,
    );
  });

  describe('changeStatus', () => {
    const moveSetup = (from: string, after = detail()) => {
      prisma.customerRequest.findFirst.mockResolvedValue({ status: from });
      prisma.customerRequest.updateMany.mockResolvedValue({ count: 1 });
      prisma.customerRequest.findFirstOrThrow.mockResolvedValue(after);
    };

    it('is a conditional update on the status that was read, scoped to the tenant, with its audit entry in the same transaction', async () => {
      moveSetup('requested');
      const view = await service.changeStatus(
        't1',
        'q1',
        { status: 'confirmed', note: 'booked' },
        actor,
      );
      expect(prisma.customerRequest.findFirst).toHaveBeenCalledWith({
        where: { id: 'q1', tenantId: 't1' },
        select: { status: true },
      });
      expect(prisma.customerRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'q1', tenantId: 't1', status: 'requested' },
        data: expect.objectContaining({
          status: 'confirmed',
          statusChangedBy: 'u1',
          cancelledBy: null,
          note: 'booked',
        }),
      });
      expect(audit.record).toHaveBeenCalledWith(
        {
          tenantId: 't1',
          actor: { userId: 'u1', role: 'agent' },
          action: 'request.confirmed',
          targetType: 'request',
          targetId: 'q1',
          before: { status: 'requested' },
          after: { status: 'confirmed' },
        },
        prisma,
      );
      expect(view).toMatchObject({
        id: 'q1',
        status: 'confirmed',
        allowedStatuses: ['done', 'cancelled', 'requested'],
        customer: { phone: '+923001234567' },
      });
      expect(live.updated).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ id: 'q1' }),
      );
    });

    it.each([
      ['requested', 'confirmed', 'request.confirmed'],
      ['requested', 'cancelled', 'request.cancelled'],
      ['confirmed', 'done', 'request.done'],
      ['confirmed', 'requested', 'request.reopened'],
      ['cancelled', 'requested', 'request.reopened'],
      ['done', 'confirmed', 'request.confirmed'],
    ])('%s -> %s is audited as %s', async (from, to, action) => {
      moveSetup(from);
      await service.changeStatus('t1', 'q1', { status: to }, actor);
      expect(audit.record.mock.calls[0][0].action).toBe(action);
    });

    it('marks who cancelled it: staff when a person does', async () => {
      moveSetup('requested');
      await service.changeStatus('t1', 'q1', { status: 'cancelled' }, actor);
      expect(
        prisma.customerRequest.updateMany.mock.calls[0][0].data,
      ).toMatchObject({ cancelledBy: 'staff' });
    });

    it('a colleague who got in between makes the conditional update match nothing: 409 with the status it is now, no audit entry', async () => {
      prisma.customerRequest.findFirst
        .mockResolvedValueOnce({ status: 'requested' })
        .mockResolvedValueOnce({ status: 'cancelled' });
      prisma.customerRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.changeStatus('t1', 'q1', { status: 'confirmed' }, actor),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'REQUEST_STATUS_CONFLICT',
          details: { currentStatus: 'cancelled' },
        },
      });
      expect(audit.record).not.toHaveBeenCalled();
      expect(live.updated).not.toHaveBeenCalled();
    });

    it('the same status is a conflict, a move the workflow lacks is TRANSITION_NOT_ALLOWED; neither writes', async () => {
      prisma.customerRequest.findFirst.mockResolvedValue({
        status: 'confirmed',
      });
      expect(
        await codeOf(
          service.changeStatus('t1', 'q1', { status: 'confirmed' }, actor),
        ),
      ).toEqual([409, 'REQUEST_STATUS_CONFLICT']);
      prisma.customerRequest.findFirst.mockResolvedValue({
        status: 'requested',
      });
      expect(
        await codeOf(
          service.changeStatus('t1', 'q1', { status: 'done' }, actor),
        ),
      ).toEqual([409, 'REQUEST_TRANSITION_NOT_ALLOWED']);
      expect(prisma.customerRequest.updateMany).not.toHaveBeenCalled();
    });

    it('a stale expectedStatus is a conflict before anything is written', async () => {
      prisma.customerRequest.findFirst.mockResolvedValue({
        status: 'confirmed',
      });
      expect(
        await codeOf(
          service.changeStatus(
            't1',
            'q1',
            { status: 'cancelled', expectedStatus: 'requested' },
            actor,
          ),
        ),
      ).toEqual([409, 'REQUEST_STATUS_CONFLICT']);
      expect(prisma.customerRequest.updateMany).not.toHaveBeenCalled();
    });

    it('a request of another tenant is REQUEST_NOT_FOUND', async () => {
      prisma.customerRequest.findFirst.mockResolvedValue(null);
      expect(
        await codeOf(
          service.changeStatus('t1', 'q-of-t2', { status: 'confirmed' }, actor),
        ),
      ).toEqual([404, 'REQUEST_NOT_FOUND']);
    });

    it('keeps the note when none is sent and clears it on an empty one', async () => {
      moveSetup('requested');
      await service.changeStatus('t1', 'q1', { status: 'confirmed' }, actor);
      expect(
        prisma.customerRequest.updateMany.mock.calls[0][0].data,
      ).not.toHaveProperty('note');
      moveSetup('confirmed');
      await service.changeStatus(
        't1',
        'q1',
        { status: 'done', note: '' },
        actor,
      );
      expect(
        prisma.customerRequest.updateMany.mock.calls[1][0].data.note,
      ).toBeNull();
    });

    it("never puts the note or the caller's details in the audit entry", async () => {
      moveSetup('requested');
      await service.changeStatus(
        't1',
        'q1',
        { status: 'confirmed', note: 'call Ahmed on 0300' },
        actor,
      );
      const text = JSON.stringify(audit.record.mock.calls);
      expect(text).not.toContain('Ahmed');
      expect(text).not.toContain('0300');
      expect(text).not.toContain('check-up');
    });
  });

  describe('reading', () => {
    it('findOne is scoped to the tenant and shows the details; a miss is 404', async () => {
      prisma.customerRequest.findFirst.mockResolvedValue(detail());
      const view = await service.findOne('t1', 'q1');
      expect(prisma.customerRequest.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'q1', tenantId: 't1' } }),
      );
      expect(view.details).toEqual({ service: 'check-up' });
      prisma.customerRequest.findFirst.mockResolvedValue(null);
      expect(await codeOf(service.findOne('t1', 'x'))).toEqual([
        404,
        'REQUEST_NOT_FOUND',
      ]);
    });

    it('findAll leaves the details out of the list and filters under the tenant', async () => {
      const { details: _details, ...listRow } = detail();
      prisma.customerRequest.findMany.mockResolvedValue([listRow]);
      prisma.customerRequest.count.mockResolvedValue(1);
      const page = await service.findAll('t1', {
        status: 'confirmed',
        agentId: 'ag1',
        type: 'appointment',
        from: '2026-10-01T00:00:00Z',
        to: '2026-10-31T00:00:00Z',
        q: ' Ahmed ',
        skip: 5,
        take: 10,
      });
      const args = prisma.customerRequest.findMany.mock.calls[0][0];
      expect(args.where).toMatchObject({
        tenantId: 't1',
        status: 'confirmed',
        agentId: 'ag1',
        type: 'appointment',
        createdAt: {
          gte: new Date('2026-10-01T00:00:00Z'),
          lte: new Date('2026-10-31T00:00:00Z'),
        },
      });
      expect(args.select).not.toHaveProperty('details');
      expect(args).toMatchObject({ skip: 5, take: 10 });
      expect(page).toMatchObject({ total: 1, skip: 5, take: 10 });
      expect(page.data[0]).not.toHaveProperty('details');
      // the same tenant filter on the count
      expect(prisma.customerRequest.count.mock.calls[0][0].where.tenantId).toBe(
        't1',
      );
    });

    it('a phone search matches the digits only, and a short one never matches numbers', async () => {
      prisma.customerRequest.findMany.mockResolvedValue([]);
      prisma.customerRequest.count.mockResolvedValue(0);
      await service.findAll('t1', { q: '(300) 123-4567' });
      const phoneBranch = JSON.stringify(
        prisma.customerRequest.findMany.mock.calls[0][0].where.OR,
      );
      expect(phoneBranch).toContain('3001234567');
      await service.findAll('t1', { q: 'ab' });
      expect(
        JSON.stringify(
          prisma.customerRequest.findMany.mock.calls[1][0].where.OR,
        ),
      ).not.toContain('externalId');
    });

    it('counts per status for the tenant, zero for the missing ones', async () => {
      prisma.customerRequest.groupBy.mockResolvedValue([
        { status: 'requested', _count: { _all: 3 } },
        { status: 'done', _count: { _all: 2 } },
      ]);
      await expect(service.counts('t1', {})).resolves.toEqual({
        requested: 3,
        confirmed: 0,
        done: 2,
        cancelled: 0,
        total: 5,
      });
      expect(prisma.customerRequest.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 't1' } }),
      );
      await service.counts('t1', { agentId: 'ag1' });
      expect(prisma.customerRequest.groupBy.mock.calls[1][0].where).toEqual({
        tenantId: 't1',
        agentId: 'ag1',
      });
    });
  });
});

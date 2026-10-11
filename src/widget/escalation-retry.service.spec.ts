import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
} from '../../test/utils/prisma-mock';
import { FakeClock } from '../billing/clock';
import { EngineError } from '../engine/engine.types';
import {
  ESCALATION_MAX_ATTEMPTS,
  EscalationRetryService,
  backoffMs,
} from './escalation-retry.service';

const NOW = new Date('2026-10-10T10:00:00.000Z');

const row = (over: Record<string, unknown> = {}) => ({
  id: 'gc-1',
  tenantId: 'tenant-a',
  conversationId: 'conv-1',
  escalationReason: 'ai_unavailable',
  escalationPending: true,
  escalationAttempts: 0,
  escalationLastAttemptAt: null,
  closedAt: null,
  createdAt: new Date('2026-10-10T09:00:00.000Z'),
  ...over,
});

describe('backoffMs', () => {
  it('grows 30 s, 1 min, 2 min ... and stops at 30 minutes', () => {
    expect([0, 1, 2, 3].map(backoffMs)).toEqual([
      30_000, 60_000, 120_000, 240_000,
    ]);
    expect(backoffMs(10)).toBe(30 * 60_000);
    expect(backoffMs(40)).toBe(30 * 60_000);
  });
});

describe('EscalationRetryService', () => {
  let prisma: PrismaMock;
  let engine: { escalate: jest.Mock };
  let config: Record<string, unknown>;
  let service: EscalationRetryService;

  const make = () =>
    new EscalationRetryService(
      prisma as never,
      engine as never,
      { get: (k: string) => config[k] } as never,
      new FakeClock(NOW),
    );

  beforeEach(() => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
    prisma.gatewayConversation.findMany.mockResolvedValue([]);
    prisma.gatewayConversation.updateMany.mockResolvedValue({ count: 1 });
    engine = { escalate: jest.fn().mockResolvedValue({}) };
    config = { NODE_ENV: 'production' };
    service = make();
  });

  it('selects only open conversations with an undelivered escalation that still has attempts left', async () => {
    await service.run();
    expect(prisma.gatewayConversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          escalationPending: true,
          closedAt: null,
          escalationAttempts: { lt: ESCALATION_MAX_ATTEMPTS },
          escalationReason: { not: null },
        },
      }),
    );
  });

  it('tells the engine with the tenant of the stored row and the ORIGINAL idempotency key, then clears the flag', async () => {
    prisma.gatewayConversation.findMany.mockResolvedValue([row()]);
    await expect(service.run()).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
      skipped: false,
    });
    expect(engine.escalate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        idempotencyKey: 'escalate:conv-1:ai_unavailable',
      }),
      'conv-1',
      { reason: 'ai_unavailable' },
    );
    expect(prisma.gatewayConversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'gc-1', tenantId: 'tenant-a', escalationPending: true },
      data: {
        escalationPending: false,
        escalationAttempts: { increment: 1 },
        escalationLastAttemptAt: NOW,
      },
    });
  });

  it('keeps the flag, counts the attempt and moves on when the engine is still down', async () => {
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    engine.escalate.mockRejectedValue(new EngineError('unavailable', 'down'));
    prisma.gatewayConversation.findMany.mockResolvedValue([
      row(),
      row({ id: 'gc-2', conversationId: 'conv-2' }),
    ]);
    await expect(service.run()).resolves.toMatchObject({
      attempted: 2,
      delivered: 0,
      failed: 2,
    });
    expect(prisma.gatewayConversation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          escalationPending: true,
          escalationAttempts: { increment: 1 },
        }),
      }),
    );
  });

  it.each([
    ['not_found', new EngineError('not_found', 'gone', 404)],
    ['conflict', new EngineError('conflict', 'resolved', 409)],
  ])(
    'a conversation that is %s needs no escalation: the flag is cleared',
    async (_k, error) => {
      engine.escalate.mockRejectedValue(error);
      prisma.gatewayConversation.findMany.mockResolvedValue([row()]);
      await expect(service.run()).resolves.toMatchObject({
        delivered: 1,
        failed: 0,
      });
      expect(
        prisma.gatewayConversation.updateMany.mock.calls[0][0].data
          .escalationPending,
      ).toBe(false);
    },
  );

  it('waits out the back-off between attempts', async () => {
    prisma.gatewayConversation.findMany.mockResolvedValue([
      row({
        id: 'recent',
        escalationAttempts: 1,
        escalationLastAttemptAt: new Date(NOW.getTime() - 30_000),
      }),
      row({
        id: 'due',
        conversationId: 'conv-due',
        escalationAttempts: 1,
        escalationLastAttemptAt: new Date(NOW.getTime() - 61_000),
      }),
      row({ id: 'never', conversationId: 'conv-never', escalationAttempts: 0 }),
    ]);
    await service.run();
    expect(engine.escalate.mock.calls.map((c) => c[1])).toEqual([
      'conv-due',
      'conv-never',
    ]);
  });

  it('after the last attempt fails the flag STAYS set and a warning names the conversation, not any content', async () => {
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
    engine.escalate.mockRejectedValue(new EngineError('timeout', 'slow'));
    prisma.gatewayConversation.findMany.mockResolvedValue([
      row({
        escalationAttempts: ESCALATION_MAX_ATTEMPTS - 1,
        escalationLastAttemptAt: new Date(0),
      }),
    ]);
    await service.run();
    expect(
      prisma.gatewayConversation.updateMany.mock.calls[0][0].data
        .escalationPending,
    ).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        conversationId: 'conv-1',
      }),
    );
  });

  it('does nothing when another instance holds the lock', async () => {
    prisma.$queryRaw.mockResolvedValue([{ locked: false }]);
    await expect(service.run()).resolves.toEqual({
      attempted: 0,
      delivered: 0,
      failed: 0,
      skipped: true,
    });
    expect(prisma.gatewayConversation.findMany).not.toHaveBeenCalled();
  });

  describe('the timer', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('does not start in tests or when switched off', async () => {
      for (const env of [
        { NODE_ENV: 'test' },
        { ESCALATION_RETRY_JOB: 'off' },
      ]) {
        config = env;
        const s = make();
        s.onApplicationBootstrap();
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        expect(prisma.gatewayConversation.findMany).not.toHaveBeenCalled();
        s.onModuleDestroy();
      }
    });

    it('sweeps shortly after boot and then on the configured interval, and stops on destroy', async () => {
      config = {
        NODE_ENV: 'production',
        ESCALATION_RETRY_INTERVAL_SECONDS: 60,
      };
      const s = make();
      s.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(21_000);
      expect(prisma.gatewayConversation.findMany).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(prisma.gatewayConversation.findMany).toHaveBeenCalledTimes(2);
      s.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(prisma.gatewayConversation.findMany).toHaveBeenCalledTimes(2);
    });

    it('a failing sweep is logged, not thrown, and the next tick runs', async () => {
      config = {
        NODE_ENV: 'production',
        ESCALATION_RETRY_INTERVAL_SECONDS: 60,
      };
      const s = make();
      jest.spyOn(s['logger'], 'error').mockImplementation(() => undefined);
      prisma.gatewayConversation.findMany.mockRejectedValueOnce(
        new Error('db down'),
      );
      s.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(21_000 + 60_000);
      expect(prisma.gatewayConversation.findMany).toHaveBeenCalledTimes(2);
      s.onModuleDestroy();
    });
  });
});

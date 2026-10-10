import { Test } from '@nestjs/testing';
import {
  createPrismaMock,
  mockTransaction,
  PrismaMock,
} from '../../test/utils/prisma-mock';
import { Clock, FakeClock } from '../billing/clock';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService, utcDay } from './usage.service';

describe('UsageService (usage_daily, counted once)', () => {
  let service: UsageService;
  let prisma: PrismaMock;
  let clock: FakeClock;

  beforeEach(async () => {
    prisma = createPrismaMock();
    mockTransaction(prisma);
    clock = new FakeClock(new Date('2026-10-08T23:59:59.000Z'));
    prisma.usageEvent.createMany.mockResolvedValue({ count: 1 });
    prisma.$executeRaw.mockResolvedValue(1);
    const module = await Test.createTestingModule({
      providers: [
        UsageService,
        { provide: PrismaService, useValue: prisma },
        { provide: Clock, useValue: clock },
      ],
    }).compile();
    service = module.get(UsageService);
  });

  const rawValues = () => prisma.$executeRaw.mock.calls[0].slice(1);

  it('counts a new conversation: one ledger row, one increment, for the UTC day', async () => {
    await expect(
      service.recordConversation('tenant-a', 'conv-1'),
    ).resolves.toBe(true);
    expect(prisma.usageEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          tenantId: 'tenant-a',
          kind: 'conversation',
          refId: 'conv-1',
          day: utcDay(clock.now()),
        },
      ],
      skipDuplicates: true,
    });
    // tenant, date, conversations, messages, tokensIn, tokensOut
    expect(rawValues()).toEqual(['tenant-a', '2026-10-08', 1, 0, 0, 0]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('counting the same conversation again changes nothing (idempotent per conversation id)', async () => {
    prisma.usageEvent.createMany.mockResolvedValue({ count: 0 });
    await expect(
      service.recordConversation('tenant-a', 'conv-1'),
    ).resolves.toBe(false);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('counts a message with its tokens, once per message id', async () => {
    await service.recordMessage('tenant-a', {
      messageId: 'msg-1',
      tokensIn: 120,
      tokensOut: 30,
    });
    expect(prisma.usageEvent.createMany.mock.calls[0][0].data[0]).toMatchObject(
      { kind: 'message', refId: 'msg-1' },
    );
    expect(rawValues()).toEqual(['tenant-a', '2026-10-08', 0, 1, 120, 30]);

    prisma.$executeRaw.mockClear();
    prisma.usageEvent.createMany.mockResolvedValue({ count: 0 });
    await expect(
      service.recordMessage('tenant-a', { messageId: 'msg-1', tokensIn: 120 }),
    ).resolves.toBe(false);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('ignores nonsense token counts instead of corrupting the counters', async () => {
    await service.recordMessage('tenant-a', {
      messageId: 'msg-2',
      tokensIn: -5,
      tokensOut: Number.NaN,
    });
    expect(rawValues()).toEqual(['tenant-a', '2026-10-08', 0, 1, 0, 0]);
  });

  it('joins the callers transaction when given one (conversation row and count commit together)', async () => {
    const tx = createPrismaMock();
    tx.usageEvent.createMany.mockResolvedValue({ count: 1 });
    tx.$executeRaw.mockResolvedValue(1);
    await service.recordConversation('tenant-a', 'conv-9', tx as never);
    expect(tx.usageEvent.createMany).toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.usageEvent.createMany).not.toHaveBeenCalled();
  });

  it('uses the injected clock for the day, not the machine time', async () => {
    clock.set('2027-01-01T00:00:01.000Z');
    await service.recordConversation('tenant-a', 'conv-3');
    expect(rawValues()[1]).toBe('2027-01-01');
  });

  it('writes the counters with a single atomic upsert statement', async () => {
    await service.recordConversation('tenant-a', 'conv-4');
    const sql = (prisma.$executeRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('ON CONFLICT ("tenant_id", "day") DO UPDATE');
    expect(sql).toContain('"usage_daily"."conversations" + EXCLUDED');
  });
});

import { Test } from '@nestjs/testing';
import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { PrismaService } from '../prisma/prisma.service';
import { MailHealth } from '../mail/mail-health';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: PrismaMock;
  let mail: { snapshot: jest.Mock };
  const mailSnapshot = {
    provider: 'resend',
    status: 'ok',
    consecutiveFailures: 0,
    lastFailureReason: null,
    lastFailureAt: null,
  };

  beforeEach(async () => {
    prisma = createPrismaMock();
    mail = { snapshot: jest.fn().mockReturnValue(mailSnapshot) };
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: MailHealth, useValue: mail },
      ],
    }).compile();
    controller = module.get(HealthController);
  });

  it('liveness does not touch the database', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('readiness reports the database as up', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      database: 'up',
      mail: mailSnapshot,
    });
  });

  it('a degraded mail provider is a warning in the body: readiness stays up', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    mail.snapshot.mockReturnValue({
      ...mailSnapshot,
      status: 'degraded',
      consecutiveFailures: 4,
      lastFailureReason: 'quota_daily',
    });
    await expect(controller.ready()).resolves.toMatchObject({
      status: 'ok',
      mail: { status: 'degraded', lastFailureReason: 'quota_daily' },
    });
  });

  it('readiness answers 503 when the query fails', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('down'));
    await expect(controller.ready()).rejects.toMatchObject({
      status: 503,
      response: { code: 'SERVICE_UNAVAILABLE' },
    });
  });
});

import { Test } from '@nestjs/testing';
import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = createPrismaMock();
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: PrismaService, useValue: prisma }],
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

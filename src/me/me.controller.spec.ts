import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ROLES_KEY } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { MeController } from './me.controller';
import { MeService } from './me.service';

describe('MeController', () => {
  let controller: MeController;
  const service = { get: jest.fn(), update: jest.fn() };
  const actor: AuthUser = {
    userId: 'u1',
    tenantId: 'tenant-a',
    role: 'agent',
    emailVerified: true,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MeController],
      providers: [{ provide: MeService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(MeController);
  });

  it('is mounted at /me, guarded, and open to every role', () => {
    expect(Reflect.getMetadata('path', MeController)).toBe('me');
    expect(Reflect.getMetadata(GUARDS_METADATA, MeController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    for (const handler of ['get', 'update'] as const) {
      expect(
        Reflect.getMetadata(ROLES_KEY, MeController.prototype[handler]),
      ).toEqual(['owner', 'admin', 'agent']);
    }
  });

  it('works on the signed-in user, never on an id from the request', () => {
    void controller.get(actor);
    expect(service.get).toHaveBeenCalledWith(actor);
    void controller.update(actor, { name: 'x' });
    expect(service.update).toHaveBeenCalledWith(actor, { name: 'x' });
  });
});

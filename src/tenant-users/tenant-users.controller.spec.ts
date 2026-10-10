import { Test, TestingModule } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { TenantUsersController } from './tenant-users.controller';
import { TenantUsersService } from './tenant-users.service';

describe('TenantUsersController', () => {
  let controller: TenantUsersController;
  let service: Record<'findAll' | 'findOne' | 'update' | 'remove', jest.Mock>;
  const actor: AuthUser = {
    userId: 'u1',
    tenantId: 'tenant-a',
    role: 'admin',
    emailVerified: true,
  };

  beforeEach(async () => {
    service = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TenantUsersController],
      providers: [{ provide: TenantUsersService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(TenantUsersController);
  });

  it('passes (tenantId, id) in the order the service expects, plus the acting user', () => {
    void controller.remove('tenant-a', 'user-1', actor);
    expect(service.remove).toHaveBeenCalledWith('tenant-a', 'user-1', actor);

    void controller.update('tenant-a', 'user-1', { role: 'agent' }, actor);
    expect(service.update).toHaveBeenCalledWith(
      'tenant-a',
      'user-1',
      { role: 'agent' },
      actor,
    );

    void controller.findOne('tenant-a', 'user-1', actor);
    expect(service.findOne).toHaveBeenCalledWith('tenant-a', 'user-1', actor);
  });

  it('has no create route: people join by invite', () => {
    expect((controller as any).create).toBeUndefined();
  });

  it('forwards list with the tenant first', () => {
    void controller.findAll('tenant-a', { skip: 1, take: 2 }, actor);
    expect(service.findAll).toHaveBeenCalledWith(
      'tenant-a',
      { skip: 1, take: 2 },
      actor,
    );
  });
});

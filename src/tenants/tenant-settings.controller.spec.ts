import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ROLES_KEY } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { TenantSettingsController } from './tenant-settings.controller';
import { TenantSettingsService } from './tenant-settings.service';

describe('TenantSettingsController', () => {
  let controller: TenantSettingsController;
  const service = { get: jest.fn(), update: jest.fn() };
  const actor: AuthUser = {
    userId: 'u1',
    tenantId: 't1',
    role: 'owner',
    emailVerified: true,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TenantSettingsController],
      providers: [{ provide: TenantSettingsService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(TenantSettingsController);
  });

  it('is tenant-scoped and guarded by the staff JWT and the roles guard', () => {
    expect(Reflect.getMetadata('path', TenantSettingsController)).toBe(
      'tenants/:tenantId',
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, TenantSettingsController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it('every role reads, only the owner changes', () => {
    const roles = (method: 'get' | 'update') =>
      Reflect.getMetadata(
        ROLES_KEY,
        TenantSettingsController.prototype[method],
      );
    expect(roles('get')).toEqual(['owner', 'admin', 'agent']);
    expect(roles('update')).toEqual(['owner']);
  });

  it('passes the tenant of the verified token, not anything from the URL', () => {
    void controller.get(actor);
    expect(service.get).toHaveBeenCalledWith('t1');
    const dto = { name: 'Acme' };
    void controller.update(actor, dto);
    expect(service.update).toHaveBeenCalledWith(actor, dto);
  });
});

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ROLES_KEY } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { AuditLogsController } from './audit-logs.controller';
import { AuditService } from './audit.service';

describe('AuditLogsController', () => {
  let controller: AuditLogsController;
  const service = { findAll: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditLogsController],
      providers: [{ provide: AuditService, useValue: service }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(AuditLogsController);
  });

  it('is tenant-scoped, guarded and limited to owner and admin', () => {
    expect(Reflect.getMetadata('path', AuditLogsController)).toBe(
      'tenants/:tenantId/audit-logs',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, AuditLogsController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(
      Reflect.getMetadata(ROLES_KEY, AuditLogsController.prototype.findAll),
    ).toEqual(['owner', 'admin']);
  });

  it('passes the tenant first', () => {
    void controller.findAll('tenant-a', { action: 'user.deleted' });
    expect(service.findAll).toHaveBeenCalledWith('tenant-a', {
      action: 'user.deleted',
    });
  });
});

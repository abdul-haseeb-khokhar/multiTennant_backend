import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { AUDIT_KEY } from '../audit/audit.decorator';
import { AuditService } from '../audit/audit.service';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ROLES_KEY } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { InviteAcceptController } from './invite-accept.controller';
import { InvitesController } from './invites.controller';
import { InvitesService } from './invites.service';

describe('Invites controllers', () => {
  let controller: InvitesController;
  let accept: InviteAcceptController;
  const service = {
    create: jest.fn(),
    findAll: jest.fn(),
    revoke: jest.fn(),
    accept: jest.fn(),
  };
  const actor: AuthUser = {
    userId: 'u1',
    tenantId: 'tenant-a',
    role: 'admin',
    emailVerified: true,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [InvitesController, InviteAcceptController],
      providers: [
        { provide: InvitesService, useValue: service },
        { provide: AuditService, useValue: { record: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(EmailVerifiedGuard)
      .useValue({ canActivate: () => true })
      .compile();
    controller = module.get(InvitesController);
    accept = module.get(InviteAcceptController);
  });

  it('management routes are tenant-scoped, guarded, and limited to owner and admin', () => {
    expect(Reflect.getMetadata('path', InvitesController)).toBe(
      'tenants/:tenantId/invites',
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, InvitesController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    for (const handler of ['create', 'findAll', 'revoke'] as const) {
      expect(
        Reflect.getMetadata(ROLES_KEY, InvitesController.prototype[handler]),
      ).toEqual(['owner', 'admin']);
    }
  });

  it('creating an invite additionally requires a verified email (H4)', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, InvitesController.prototype.create),
    ).toEqual([EmailVerifiedGuard]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, InvitesController.prototype.findAll),
    ).toBeUndefined();
  });

  it('revoking is audited as invite.revoked', () => {
    expect(
      Reflect.getMetadata(AUDIT_KEY, InvitesController.prototype.revoke),
    ).toEqual({ action: 'invite.revoked', targetType: 'invite' });
  });

  it('passes the tenant first and the acting user last', () => {
    void controller.create('tenant-a', { email: 'a@b.co' }, actor);
    expect(service.create).toHaveBeenCalledWith(
      'tenant-a',
      { email: 'a@b.co' },
      actor,
    );
    void controller.findAll('tenant-a', { skip: 1 });
    expect(service.findAll).toHaveBeenCalledWith('tenant-a', { skip: 1 });
    void controller.revoke('tenant-a', 'inv-1', actor);
    expect(service.revoke).toHaveBeenCalledWith('tenant-a', 'inv-1', actor);
  });

  it('accepting is public, under /auth/invites/accept', () => {
    expect(Reflect.getMetadata('path', InviteAcceptController)).toBe(
      'auth/invites',
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, InviteAcceptController),
    ).toBeUndefined();
    const dto = { token: 't', password: 'password123' };
    void accept.accept(dto);
    expect(service.accept).toHaveBeenCalledWith(dto);
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SlugAvailabilityService } from './slug-availability.service';
import { WorkspaceLoginService } from './workspace-login.service';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformJwtAuthGuard } from './platform-jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { SessionAuthGuard } from './session-auth.guard';
import { PlatformAuthService } from './platform-auth.service';

describe('Auth controllers', () => {
  let auth: AuthController;
  let platform: PlatformAuthController;
  const authService = {
    login: jest.fn(),
    signup: jest.fn(),
    logout: jest.fn(),
  };
  const platformService = { login: jest.fn(), logout: jest.fn() };
  const workspaceLogin = {
    loginByEmail: jest.fn(),
    selectWorkspace: jest.fn(),
  };
  const slugAvailability = { check: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController, PlatformAuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: WorkspaceLoginService, useValue: workspaceLogin },
        { provide: SlugAvailabilityService, useValue: slugAvailability },
        { provide: PlatformAuthService, useValue: platformService },
      ],
    })
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PlatformJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    auth = module.get(AuthController);
    platform = module.get(PlatformAuthController);
  });

  it('delegates login and signup', () => {
    const login = { tenantSlug: 'acme', email: 'a@b.co', password: 'x' };
    void auth.login(login, '1.2.3.4');
    expect(authService.login).toHaveBeenCalledWith(login, '1.2.3.4');

    const signup = {
      tenantName: 'Acme',
      ownerEmail: 'a@b.co',
      ownerPassword: 'password123',
    };
    void auth.signup(signup);
    expect(authService.signup).toHaveBeenCalledWith(signup);
  });

  it('delegates the email-first login, the workspace selection and the slug check (with the caller IP)', () => {
    const body = { email: 'a@b.co', password: 'x' };
    void auth.loginByEmail(body, '1.2.3.4');
    expect(workspaceLogin.loginByEmail).toHaveBeenCalledWith(body, '1.2.3.4');

    const pick = { selectionToken: 't', tenantId: 'ten' };
    void auth.selectWorkspace(pick);
    expect(workspaceLogin.selectWorkspace).toHaveBeenCalledWith(pick);

    void auth.slugAvailable({ slug: 'acme' }, '1.2.3.4');
    expect(slugAvailability.check).toHaveBeenCalledWith('acme', '1.2.3.4');
  });

  it('delegates logout to the service with the caller', async () => {
    const actor = {
      userId: 'u1',
      tenantId: 't1',
      role: 'agent' as const,
      emailVerified: true,
    };
    await auth.logout(actor);
    expect(authService.logout).toHaveBeenCalledWith(actor);
    await platform.logout({ adminId: 'a1' });
    expect(platformService.logout).toHaveBeenCalledWith('a1');
  });

  it('delegates platform login, mounted under admin/auth', () => {
    void platform.login({ email: 'a@b.co', password: 'x' });
    expect(platformService.login).toHaveBeenCalledWith({
      email: 'a@b.co',
      password: 'x',
    });
    expect(Reflect.getMetadata('path', PlatformAuthController)).toBe(
      'admin/auth',
    );
  });
});

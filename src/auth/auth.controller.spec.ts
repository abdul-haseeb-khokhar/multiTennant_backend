import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';

describe('Auth controllers', () => {
  let auth: AuthController;
  let platform: PlatformAuthController;
  const authService = { login: jest.fn(), signup: jest.fn() };
  const platformService = { login: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController, PlatformAuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: PlatformAuthService, useValue: platformService },
      ],
    }).compile();
    auth = module.get(AuthController);
    platform = module.get(PlatformAuthController);
  });

  it('delegates login and signup', () => {
    const login = { tenantSlug: 'acme', email: 'a@b.co', password: 'x' };
    void auth.login(login);
    expect(authService.login).toHaveBeenCalledWith(login);

    const signup = {
      tenantName: 'Acme',
      ownerEmail: 'a@b.co',
      ownerPassword: 'password123',
    };
    void auth.signup(signup);
    expect(authService.signup).toHaveBeenCalledWith(signup);
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

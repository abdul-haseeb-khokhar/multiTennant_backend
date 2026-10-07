import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test, TestingModule } from '@nestjs/testing';
import { EmailVerificationController } from './email-verification.controller';
import { EmailVerificationService } from './email-verification.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';
import { RolesGuard } from './roles.guard';

describe('password reset and email verification controllers', () => {
  let reset: PasswordResetController;
  let verify: EmailVerificationController;
  const resetService = { request: jest.fn(), confirm: jest.fn() };
  const verifyService = { verify: jest.fn(), resend: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PasswordResetController, EmailVerificationController],
      providers: [
        { provide: PasswordResetService, useValue: resetService },
        { provide: EmailVerificationService, useValue: verifyService },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    reset = module.get(PasswordResetController);
    verify = module.get(EmailVerificationController);
  });

  it('password reset request answers 202 and passes the client IP for throttling', () => {
    const dto = { tenantSlug: 'acme', email: 'a@b.co' };
    void reset.request(dto, '1.2.3.4');
    expect(resetService.request).toHaveBeenCalledWith(dto, '1.2.3.4');
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        PasswordResetController.prototype.request,
      ),
    ).toBe(202);
    expect(Reflect.getMetadata('path', PasswordResetController)).toBe(
      'auth/password-reset',
    );
  });

  it('password reset confirm answers 204 and returns nothing', async () => {
    resetService.confirm.mockResolvedValue(undefined);
    await expect(
      reset.confirm({ token: 't', password: 'password123' }),
    ).resolves.toBeUndefined();
    expect(resetService.confirm).toHaveBeenCalledWith({
      token: 't',
      password: 'password123',
    });
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        PasswordResetController.prototype.confirm,
      ),
    ).toBe(204);
  });

  it('verify-email is public (204); resend needs a signed-in user (202)', async () => {
    verifyService.verify.mockResolvedValue(undefined);
    await verify.verify({ token: 't' });
    expect(verifyService.verify).toHaveBeenCalledWith('t');
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        EmailVerificationController.prototype.verify,
      ),
    ).toBe(204);
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        EmailVerificationController.prototype.verify,
      ),
    ).toBeUndefined();

    const actor = {
      userId: 'u1',
      tenantId: 't1',
      role: 'owner' as const,
      emailVerified: false,
    };
    void verify.resend(actor);
    expect(verifyService.resend).toHaveBeenCalledWith(actor);
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        EmailVerificationController.prototype.resend,
      ),
    ).toEqual([JwtAuthGuard, RolesGuard]);
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        EmailVerificationController.prototype.resend,
      ),
    ).toBe(202);
  });
});

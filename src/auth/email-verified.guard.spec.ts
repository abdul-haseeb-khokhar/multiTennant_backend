import { ExecutionContext } from '@nestjs/common';
import { EmailVerifiedGuard } from './email-verified.guard';

const contextFor = (user: unknown) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

describe('EmailVerifiedGuard', () => {
  const guard = new EmailVerifiedGuard();

  it('lets a verified user through', () => {
    expect(guard.canActivate(contextFor({ emailVerified: true }))).toBe(true);
  });

  it('refuses an unverified user with 403 EMAIL_NOT_VERIFIED', () => {
    expect(() =>
      guard.canActivate(contextFor({ emailVerified: false })),
    ).toThrow(
      expect.objectContaining({
        status: 403,
        response: expect.objectContaining({ code: 'EMAIL_NOT_VERIFIED' }),
      }),
    );
  });

  it('fails closed without a user', () => {
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(
      expect.objectContaining({ status: 403 }),
    );
  });
});

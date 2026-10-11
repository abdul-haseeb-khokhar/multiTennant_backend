import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { AcceptInviteDto } from '../../auth/dto/accept-invite.dto';
import { PasswordResetConfirmDto } from '../../auth/dto/password-reset.dto';
import { SignupDto } from '../../auth/dto/signup.dto';
import { BCRYPT_MAX_BYTES } from './password-length';

const signup = (ownerPassword: unknown) =>
  validateSync(
    plainToInstance(SignupDto, {
      tenantName: 'Acme',
      ownerEmail: 'o@acme.com',
      ownerPassword,
    }),
  );

describe('new passwords are limited to what bcrypt really hashes (G23.11)', () => {
  it('signup accepts 8 to 72 characters', () => {
    expect(signup('a'.repeat(8))).toHaveLength(0);
    expect(signup('a'.repeat(72))).toHaveLength(0);
  });

  it('signup refuses a short password and a 73-character one', () => {
    expect(signup('a'.repeat(7))).toHaveLength(1);
    expect(signup('a'.repeat(73))).toHaveLength(1);
    expect(signup('a'.repeat(100))).toHaveLength(1);
  });

  it('counts BYTES: 40 two-byte characters (80 bytes) are refused, 36 are accepted', () => {
    expect(signup('é'.repeat(36))).toHaveLength(0); // 72 bytes
    expect(signup('é'.repeat(37))).toHaveLength(1); // 74 bytes
    expect(signup('😀'.repeat(19))).toHaveLength(1); // 76 bytes, only 38 UTF-16 units
    expect(Buffer.byteLength('é'.repeat(36))).toBe(BCRYPT_MAX_BYTES);
  });

  it('the invite and the reset confirmation use the same rule', () => {
    const accept = (password: string) =>
      validateSync(plainToInstance(AcceptInviteDto, { token: 't', password }));
    const reset = (password: string) =>
      validateSync(
        plainToInstance(PasswordResetConfirmDto, { token: 't', password }),
      );
    for (const check of [accept, reset]) {
      expect(check('a'.repeat(72))).toHaveLength(0);
      expect(check('é'.repeat(37))).toHaveLength(1);
    }
  });
});

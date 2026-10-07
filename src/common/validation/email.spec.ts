import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { NormalizedEmail, normalizeEmail } from './email';

class Dto {
  @NormalizedEmail()
  email: string;
}

describe('email normalisation', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Agent@Acme.COM ')).toBe('agent@acme.com');
  });

  it('normalises before validating, so padded mixed-case input is accepted and stored lower-case', () => {
    const dto = plainToInstance(Dto, { email: '  Agent@Acme.COM ' });
    expect(dto.email).toBe('agent@acme.com');
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('still rejects things that are not emails, and non-strings', () => {
    expect(validateSync(plainToInstance(Dto, { email: 'nope' }))).toHaveLength(
      1,
    );
    expect(validateSync(plainToInstance(Dto, { email: 42 }))).toHaveLength(1);
    expect(validateSync(plainToInstance(Dto, {}))).toHaveLength(1);
  });
});

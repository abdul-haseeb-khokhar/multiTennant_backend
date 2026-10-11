import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SignupDto } from '../../auth/dto/signup.dto';
import { CreateEndCustomerDto } from '../../end-customers/dto/create-end-customer.dto';
import { UpdateMeDto } from '../../me/dto/update-me.dto';
import { UpdateTenantDto } from '../../tenants/dto/update-tenant.dto';
import { LOCALES, LocaleInfo } from '../../i18n/locales';

const errors = (cls: new () => object, body: object) =>
  validateSync(plainToInstance(cls, body)).flatMap((e) =>
    Object.values(e.constraints ?? {}),
  );

describe('locale fields follow the locale registry (G23.5)', () => {
  const base = {
    tenantName: 'Acme',
    ownerEmail: 'o@acme.com',
    ownerPassword: 'a-long-enough-password',
  };

  it.each([
    ['signup', SignupDto, (locale: unknown) => ({ ...base, locale })],
    ['update me', UpdateMeDto, (locale: unknown) => ({ locale })],
    [
      'create customer',
      CreateEndCustomerDto,
      (locale: unknown) => ({ externalId: 'x', locale }),
    ],
    [
      'update tenant',
      UpdateTenantDto,
      (locale: unknown) => ({ defaultLocale: locale }),
    ],
  ] as const)(
    '%s accepts every registry locale and nothing else',
    (_n, cls, body) => {
      for (const { code } of LOCALES) {
        expect(errors(cls, body(code))).toEqual([]);
      }
      for (const bad of ['fr', 'EN', 'en-US', '', 42, true]) {
        expect(errors(cls, body(bad)).join()).toContain(
          'supported locale code',
        );
      }
    },
  );

  it('an omitted locale is fine, and update-me can clear it with null', () => {
    expect(errors(SignupDto, base)).toEqual([]);
    expect(errors(UpdateMeDto, { locale: null })).toEqual([]);
  });

  it('a language added to the registry is accepted without touching a DTO', () => {
    (LOCALES as LocaleInfo[]).push({ code: 'xx', name: 'Test', dir: 'ltr' });
    try {
      expect(errors(SignupDto, { ...base, locale: 'xx' })).toEqual([]);
    } finally {
      (LOCALES as LocaleInfo[]).pop();
    }
  });
});

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { canonicalTimeZone, OptionalTimeZoneProperty } from './timezone';

class Dto {
  @OptionalTimeZoneProperty()
  timezone?: string;
}

describe('timezone', () => {
  describe('canonicalTimeZone', () => {
    it.each([
      ['Asia/Karachi', 'Asia/Karachi'],
      ['asia/karachi', 'Asia/Karachi'],
      ['  Europe/London ', 'Europe/London'],
      ['America/Argentina/Salta', 'America/Argentina/Salta'],
      ['UTC', 'UTC'],
    ])('%j -> %j', (input, expected) => {
      expect(canonicalTimeZone(input)).toBe(expected);
    });

    it.each([
      'Mars/Base',
      '',
      '+05:00',
      'GMT+5:30',
      'Asia/Karachi; DROP TABLE',
      '../etc/passwd',
      'a'.repeat(65),
      42,
      null,
      undefined,
    ])('rejects %j', (input) => {
      expect(canonicalTimeZone(input)).toBeNull();
    });
  });

  describe('OptionalTimeZoneProperty', () => {
    const check = async (value: unknown) => {
      const dto = plainToInstance(Dto, { timezone: value });
      return { dto, errors: await validate(dto) };
    };

    it('stores the canonical spelling', async () => {
      const { dto, errors } = await check('asia/karachi');
      expect(errors).toHaveLength(0);
      expect(dto.timezone).toBe('Asia/Karachi');
    });

    it('may be left out', async () => {
      const dto = plainToInstance(Dto, {});
      expect(await validate(dto)).toHaveLength(0);
    });

    it('refuses an unknown zone with a message that names the field', async () => {
      const { errors } = await check('Mars/Base');
      expect(errors).toHaveLength(1);
      expect(Object.values(errors[0].constraints!)[0]).toContain('IANA');
    });
  });
});

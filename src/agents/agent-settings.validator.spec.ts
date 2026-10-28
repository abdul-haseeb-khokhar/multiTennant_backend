import { buildDefaultSettings } from './agent-settings.defaults';
import {
  AGENT_SETTINGS_MAX_BYTES,
  SettingsProblem,
  StructuralAgentSettingsValidator,
  normalizePhone,
} from './agent-settings.validator';

const validator = new StructuralAgentSettingsValidator();
const base = () =>
  buildDefaultSettings({
    tenantName: 'Acme',
    timezone: 'Asia/Karachi',
    defaultLocale: 'en',
  }) as unknown as Record<string, unknown>;

const problemsOf = (doc: unknown): SettingsProblem[] => {
  const result = validator.check(doc);
  if (result.ok) throw new Error('expected problems');
  return result.problems;
};
const codesAt = (doc: unknown) =>
  problemsOf(doc).map((p) => `${p.field}:${p.code}`);
const withKey = (key: string, value: unknown) => ({ ...base(), [key]: value });
const withEscalation = (over: Record<string, unknown>) =>
  withKey('escalation', {
    ...(base().escalation as Record<string, unknown>),
    ...over,
  });
const contact = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  role: 'Senior doctor',
  name: 'Dr Ayesha',
  phone: '+923001234567',
  ...over,
});

describe('StructuralAgentSettingsValidator', () => {
  it('accepts the default document and returns it unchanged', () => {
    const result = validator.check(base());
    expect(result).toEqual({ ok: true, document: base() });
  });

  it('works through the abstract (async) interface the engine hook will replace', async () => {
    await expect(validator.validate(base())).resolves.toMatchObject({
      ok: true,
    });
  });

  describe('the document as a whole', () => {
    it.each([null, 'x', 5, [], undefined])('refuses %p', (input) => {
      expect(codesAt(input)).toEqual([':invalid_type']);
    });

    it('refuses an unknown top-level key, naming it', () => {
      expect(codesAt({ ...base(), greeting: 'hello' })).toEqual([
        'greeting:unknown_field',
      ]);
    });

    it.each([
      'businessName',
      'purpose',
      'tone',
      'timezone',
      'uiLocale',
      'replyLanguage',
      'hours',
      'escalation',
      'capabilities',
      'voices',
      'collect',
    ])('requires %s', (key) => {
      const doc = base();
      delete doc[key];
      expect(codesAt(doc)).toEqual([`${key}:required`]);
    });

    it('reports every problem at once, not only the first', () => {
      const codes = codesAt({
        ...base(),
        tone: 'angry',
        uiLocale: 'fr',
        timezone: 'Mars/Base',
      });
      expect(codes).toEqual(
        expect.arrayContaining([
          'tone:not_allowed',
          'uiLocale:not_allowed',
          'timezone:invalid_timezone',
        ]),
      );
    });

    it('refuses a document over 64 KB', () => {
      const doc = withKey('collect', { notes: 'x'.repeat(70_000) });
      expect(problemsOf(doc)).toEqual([
        {
          field: '',
          code: 'too_large',
          params: { max: AGENT_SETTINGS_MAX_BYTES },
        },
      ]);
    });
  });

  describe('text and choices', () => {
    it('trims the business name and bounds it', () => {
      const ok = validator.check(withKey('businessName', '  Acme  '));
      expect(ok).toMatchObject({
        ok: true,
        document: { businessName: 'Acme' },
      });
      expect(codesAt(withKey('businessName', '   '))).toEqual([
        'businessName:too_short',
      ]);
      expect(codesAt(withKey('businessName', 'x'.repeat(121)))).toEqual([
        'businessName:too_long',
      ]);
      expect(codesAt(withKey('businessName', 42))).toEqual([
        'businessName:invalid_type',
      ]);
    });

    it('bounds the purpose at 2,000 characters but allows it to be empty', () => {
      expect(validator.check(withKey('purpose', ''))).toMatchObject({
        ok: true,
      });
      expect(codesAt(withKey('purpose', 'p'.repeat(2001)))).toEqual([
        'purpose:too_long',
      ]);
    });

    it.each(['professional', 'friendly', 'concise', 'formal'])(
      'accepts the tone %s',
      (tone) => {
        expect(validator.check(withKey('tone', tone))).toMatchObject({
          ok: true,
        });
      },
    );

    it('lists the allowed values when a choice is wrong', () => {
      expect(problemsOf(withKey('tone', 'rude'))[0]).toEqual({
        field: 'tone',
        code: 'not_allowed',
        params: { allowed: 'professional, friendly, concise, formal' },
      });
      expect(codesAt(withKey('replyLanguage', 'auto'))).toEqual([
        'replyLanguage:not_allowed',
      ]);
    });

    it('stores the canonical spelling of a time zone and refuses offsets and unknown names', () => {
      expect(
        validator.check(withKey('timezone', 'asia/karachi')),
      ).toMatchObject({ ok: true, document: { timezone: 'Asia/Karachi' } });
      expect(codesAt(withKey('timezone', '+05:00'))).toEqual([
        'timezone:invalid_timezone',
      ]);
      expect(codesAt(withKey('timezone', 5))).toEqual([
        'timezone:invalid_timezone',
      ]);
    });
  });

  describe('hours', () => {
    const hours = (value: unknown) => withKey('hours', value);

    it('accepts null (no hours), empty days and several ranges, which it sorts', () => {
      expect(validator.check(hours(null))).toMatchObject({ ok: true });
      expect(validator.check(hours({}))).toMatchObject({ ok: true });
      expect(
        validator.check(
          hours({
            mon: [
              ['13:00', '17:00'],
              ['09:00', '12:00'],
            ],
            tue: [],
          }),
        ),
      ).toMatchObject({
        ok: true,
        document: {
          hours: {
            mon: [
              ['09:00', '12:00'],
              ['13:00', '17:00'],
            ],
            tue: [],
          },
        },
      });
    });

    it.each([
      [{ monday: [] }, 'hours.monday:unknown_field'],
      [{ mon: '09:00' }, 'hours.mon:invalid_type'],
      [{ mon: [['9:00', '17:00']] }, 'hours.mon[0]:invalid_time'],
      [{ mon: [['09:00', '24:00']] }, 'hours.mon[0]:invalid_time'],
      [{ mon: [['17:00', '09:00']] }, 'hours.mon[0]:end_before_start'],
      [{ mon: [['09:00', '09:00']] }, 'hours.mon[0]:end_before_start'],
      [{ mon: [['09:00']] }, 'hours.mon[0]:invalid_type'],
      [
        {
          mon: [
            ['09:00', '12:00'],
            ['11:00', '13:00'],
          ],
        },
        'hours.mon:overlapping_ranges',
      ],
      [{ mon: Array(6).fill(['09:00', '10:00']) }, 'hours.mon:too_many'],
    ])('refuses %j', (value, expected) => {
      expect(codesAt(hours(value))).toContain(expected);
    });

    it('refuses hours that are not an object', () => {
      expect(codesAt(hours([]))).toEqual(['hours:invalid_type']);
    });
  });

  describe('escalation (call forwarding)', () => {
    it('accepts a full setup and normalises the phone numbers', () => {
      const result = validator.check(
        withEscalation({
          enabled: true,
          contacts: [contact({ phone: '+92 300-123 4567' })],
          afterMisses: 3,
          topics: ['refund', ' complaint '],
          outsideHours: 'forward',
        }),
      );
      expect(result).toMatchObject({
        ok: true,
        document: {
          escalation: {
            enabled: true,
            contacts: [{ phone: '+923001234567' }],
            afterMisses: 3,
            topics: ['refund', 'complaint'],
            outsideHours: 'forward',
          },
        },
      });
    });

    it('may not be switched on without a contact', () => {
      expect(codesAt(withEscalation({ enabled: true, contacts: [] }))).toEqual([
        'escalation.contacts:enabled_needs_contact',
      ]);
    });

    it.each([
      [{ afterMisses: 0 }, 'escalation.afterMisses:out_of_range'],
      [{ afterMisses: 5 }, 'escalation.afterMisses:out_of_range'],
      [{ afterMisses: 2.5 }, 'escalation.afterMisses:out_of_range'],
      [{ outsideHours: 'ignore' }, 'escalation.outsideHours:not_allowed'],
      [{ enabled: 'yes' }, 'escalation.enabled:invalid_type'],
      [{ topics: 'refund' }, 'escalation.topics:invalid_type'],
      [{ topics: Array(11).fill('a') }, 'escalation.topics:too_many'],
      [{ topics: ['x'.repeat(41)] }, 'escalation.topics[0]:too_long'],
      [{ contacts: 'x' }, 'escalation.contacts:invalid_type'],
      [{ extra: true }, 'escalation.extra:unknown_field'],
    ])('refuses %j', (over, expected) => {
      expect(codesAt(withEscalation(over))).toContain(expected);
    });

    it('allows at most five contacts', () => {
      const contacts = Array.from({ length: 6 }, (_, i) =>
        contact({ id: `c${i}`, phone: `+92300123456${i}` }),
      );
      expect(codesAt(withEscalation({ contacts }))).toEqual([
        'escalation.contacts:too_many',
      ]);
      expect(
        validator.check(withEscalation({ contacts: contacts.slice(0, 5) })),
      ).toMatchObject({ ok: true });
    });

    it.each([
      [contact({ phone: '03001234567' }), 'invalid_phone'],
      [contact({ phone: '+0123456789' }), 'invalid_phone'],
      [contact({ phone: '+1234' }), 'invalid_phone'],
      [contact({ phone: '+1234567890123456' }), 'invalid_phone'],
      [contact({ phone: '+92abc' }), 'invalid_phone'],
      [contact({ phone: undefined }), 'invalid_phone'],
      [contact({ phone: 923001234567 }), 'invalid_phone'],
    ])('refuses the contact %j', (entry, code) => {
      expect(codesAt(withEscalation({ contacts: [entry] }))).toEqual([
        `escalation.contacts[0].phone:${code}`,
      ]);
    });

    it('wants a name or a role, refuses a repeated number and unknown contact keys', () => {
      expect(
        codesAt(
          withEscalation({ contacts: [contact({ role: '', name: '' })] }),
        ),
      ).toEqual(['escalation.contacts[0]:contact_incomplete']);
      expect(
        codesAt(
          withEscalation({
            contacts: [contact(), contact({ id: 'c2', name: 'Other' })],
          }),
        ),
      ).toEqual(['escalation.contacts[1].phone:duplicate_phone']);
      expect(
        codesAt(withEscalation({ contacts: [contact({ email: 'a@b.c' })] })),
      ).toEqual(['escalation.contacts[0].email:unknown_field']);
      expect(
        codesAt(
          withEscalation({ contacts: [contact({ name: 'n'.repeat(61) })] }),
        ),
      ).toEqual(['escalation.contacts[0].name:too_long']);
    });

    it('fills in a missing or repeated contact id', () => {
      const result = validator.check(
        withEscalation({
          contacts: [
            contact({ id: undefined }),
            contact({ id: 'c1', name: 'B', phone: '+923001234568' }),
          ],
        }),
      );
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      const ids = result.document.escalation.contacts.map((c) => c.id);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe('the parts the engine owns in depth', () => {
    it('stores `collect` as it is (any JSON object) and accepts null', () => {
      const collect = {
        enabled: true,
        industry: 'dental',
        services: [{ id: 'cleaning', label: { en: 'Cleaning' } }],
        anything: { the: ['engine', 'wants'] },
      };
      expect(validator.check(withKey('collect', collect))).toMatchObject({
        ok: true,
        document: { collect },
      });
      expect(validator.check(withKey('collect', null))).toMatchObject({
        ok: true,
      });
    });

    it.each([[[]], ['x'], [5]])('refuses collect = %p', (value) => {
      expect(codesAt(withKey('collect', value))).toEqual([
        'collect:invalid_type',
      ]);
    });

    it('refuses an absurdly deep or wide opaque document without overflowing the stack', () => {
      let deep: unknown = 'leaf';
      for (let i = 0; i < 5000; i++) deep = [deep];
      expect(codesAt(withKey('collect', { deep }))).toEqual([
        'collect:too_complex',
      ]);
      const wide = { list: Array.from({ length: 25_000 }, () => 1) };
      expect(codesAt(withKey('collect', wide))).toEqual([
        'collect:too_complex',
      ]);
    });

    it('checks the shape of capabilities and voices only', () => {
      expect(
        validator.check(
          withKey('capabilities', {
            book: { enabled: true, channels: ['voice'] },
          }),
        ),
      ).toMatchObject({ ok: true });
      expect(codesAt(withKey('capabilities', { book: true }))).toEqual([
        'capabilities.book:invalid_type',
      ]);
      expect(codesAt(withKey('capabilities', []))).toEqual([
        'capabilities:invalid_type',
      ]);
      expect(
        validator.check(
          withKey('voices', { en: ' kokoro:af_heart ', ur: 'v2' }),
        ),
      ).toMatchObject({
        ok: true,
        document: { voices: { en: 'kokoro:af_heart', ur: 'v2' } },
      });
      expect(codesAt(withKey('voices', { english: 'x' }))).toEqual([
        'voices.english:unknown_field',
      ]);
      expect(codesAt(withKey('voices', { en: 5 }))).toEqual([
        'voices.en:invalid_type',
      ]);
      expect(codesAt(withKey('voices', { en: '' }))).toEqual([
        'voices.en:too_short',
      ]);
    });
  });

  it('a hostile key such as __proto__ is an unknown field, never merged', () => {
    const doc = JSON.parse(
      '{"__proto__": {"polluted": true}, "businessName": "A"}',
    ) as Record<string, unknown>;
    const codes = codesAt({ ...base(), ...doc });
    expect(codes).toContain('__proto__:unknown_field');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('normalizePhone', () => {
  it.each([
    ['+923001234567', '+923001234567'],
    [' +92 (300) 123-4567 ', '+923001234567'],
    ['00923001234567', '+923001234567'],
    ['+1.202.555.0100', '+12025550100'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['03001234567', '+0', '+12', '', '+', null, undefined, 5])(
    'refuses %p',
    (input) => {
      expect(normalizePhone(input)).toBeNull();
    },
  );
});

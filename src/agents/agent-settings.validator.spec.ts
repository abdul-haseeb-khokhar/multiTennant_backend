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
const source = (over: Record<string, unknown> = {}) => ({
  id: 'doc-1',
  title: 'About us',
  hash: 'a1b2c3d4',
  ...over,
});

/**
 * A document with every field of the engine hand-off table (docs/handoff-to-backend.md B2, read on
 * 2026-10-29, plus `collectVersion` and a `collect` document of B3), as the engine would write it.
 */
const engineDocument = (): Record<string, unknown> => ({
  businessName: 'Acme Dental',
  purpose: 'Answers calls and takes appointment requests.',
  tone: 'friendly',
  timezone: 'Asia/Karachi',
  uiLocale: 'ur',
  replyLanguage: 'ur',
  hours: {
    mon: [['09:00', '17:00']],
    tue: [['09:00', '17:00']],
    wed: [['09:00', '17:00']],
    thu: [['09:00', '17:00']],
    fri: [['09:00', '17:00']],
    sat: [],
    sun: [],
  },
  escalation: {
    enabled: true,
    contacts: [
      {
        id: 'c1',
        role: 'Senior doctor',
        name: 'Dr Ayesha',
        phone: '+923001234567',
      },
    ],
    whenCallerAsks: true,
    afterMisses: 2,
    topics: ['complaint', 'refund', 'emergency'],
    outsideHours: 'callback',
    announce: {
      en: "I'm connecting you to {name}, our {role}.",
      ur: 'Urdu announce line with {name}',
    },
  },
  capabilities: { book_appointment: { enabled: true, channels: ['voice'] } },
  voices: { en: 'kokoro:af_heart', ur: 'kokoro:hf_alpha' },
  greeting: {
    en: 'Hello, thanks for calling {business}. How can I help?',
    ur: 'Urdu greeting for {business}',
  },
  recordCalls: false,
  autoEndCalls: true,
  endCallDelaySeconds: 3,
  profileSummary: 'A dental clinic in Lahore open on weekdays.',
  profileSummarySources: [
    { id: 'ks_1', title: 'About us', hash: '9f86d081884c7d65' },
  ],
  collect: {
    enabled: true,
    industry: 'dental',
    services: [
      { id: 'root_canal', label: { en: 'Root canal', ur: 'Root canal' } },
    ],
    staff: [],
    menu: [],
    customFields: [],
    recordTypes: {
      appointment: {
        enabled: true,
        fields: [
          { id: 'name', required: true },
          { id: 'phone', required: true },
          { id: 'service', required: true },
          { id: 'datetime', required: true },
          { id: 'notes', required: false },
        ],
      },
      callback: { enabled: true, fields: [{ id: 'name', required: true }] },
      order: {
        enabled: false,
        fields: [
          { id: 'order_items', required: true },
          { id: 'order_type', required: true },
          {
            id: 'address',
            required: true,
            when: { field: 'order_type', equals: 'delivery' },
          },
        ],
      },
    },
  },
  collectVersion: 4,
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

    it('keeps an unknown top-level key exactly as sent instead of refusing it (the engine owns the field list)', () => {
      const result = validator.check({
        ...base(),
        collectVersion: 7,
        somethingNew: { nested: [1, 2, { deep: true }] },
      });
      expect(result).toMatchObject({
        ok: true,
        document: {
          collectVersion: 7,
          somethingNew: { nested: [1, 2, { deep: true }] },
        },
      });
    });

    it('still bounds an unknown key: too deep, too wide or past the byte cap', () => {
      let deep: unknown = 'leaf';
      for (let i = 0; i < 5000; i++) deep = [deep];
      expect(codesAt({ ...base(), future: deep })).toEqual([
        'future:too_complex',
      ]);
      expect(
        codesAt({ ...base(), future: 'x'.repeat(AGENT_SETTINGS_MAX_BYTES) }),
      ).toEqual([':too_large']);
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
      [{ announce: 'hello' }, 'escalation.announce:invalid_type'],
      [{ announce: { fr: 'x' } }, 'escalation.announce.fr:unknown_field'],
      [{ announce: { en: 5 } }, 'escalation.announce.en:invalid_type'],
      [
        { announce: { ur: 'x'.repeat(201) } },
        'escalation.announce.ur:too_long',
      ],
    ])('refuses %j', (over, expected) => {
      expect(codesAt(withEscalation(over))).toContain(expected);
    });

    it('keeps an unknown key inside escalation and stores the announce line trimmed', () => {
      const result = validator.check(
        withEscalation({
          extra: { rule: 'later' },
          announce: { en: '  Connecting you to {name}.  ', ur: '' },
        }),
      );
      expect(result).toMatchObject({
        ok: true,
        document: {
          escalation: {
            extra: { rule: 'later' },
            announce: { en: 'Connecting you to {name}.' },
          },
        },
      });
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

  describe('the fields the engine added (Phase 5B-3)', () => {
    it('leaves them out of the document when they are not sent', () => {
      const result = validator.check(base());
      expect(result.ok && Object.keys(result.document).sort()).toEqual(
        Object.keys(base()).sort(),
      );
    });

    it('accepts a document written exactly as the engine hand-off table shows it', () => {
      const result = validator.check(engineDocument());
      expect(result).toEqual({ ok: true, document: engineDocument() });
    });

    it("accepts the engine's own default document (an agent nobody has set up yet): placeholder name, UTC, no hours, empty lists", () => {
      const defaults = {
        businessName: 'this business',
        purpose: '',
        tone: 'professional',
        timezone: 'UTC',
        uiLocale: 'en',
        replyLanguage: 'en',
        hours: null,
        escalation: {
          enabled: false,
          contacts: [],
          whenCallerAsks: true,
          afterMisses: 2,
          topics: [],
          outsideHours: 'callback',
          announce: {},
        },
        capabilities: {},
        voices: {},
        greeting: {},
        recordCalls: false,
        autoEndCalls: true,
        endCallDelaySeconds: 3,
        profileSummary: null,
        profileSummarySources: [],
        collect: { enabled: false, recordTypes: {} },
        collectVersion: 0,
      };
      expect(validator.check(defaults)).toEqual({
        ok: true,
        document: defaults,
      });
    });

    it('trims the greeting and drops an empty or null language (the built-in wording then applies)', () => {
      expect(
        validator.check(
          withKey('greeting', { en: '  Hello from {business}.  ', ur: '  ' }),
        ),
      ).toMatchObject({
        ok: true,
        document: { greeting: { en: 'Hello from {business}.' } },
      });
      expect(
        validator.check(withKey('greeting', { en: null, ur: undefined })),
      ).toMatchObject({ ok: true, document: { greeting: {} } });
    });

    it.each([
      [{ greeting: 'hello' }, 'greeting:invalid_type'],
      [{ greeting: null }, 'greeting:invalid_type'],
      [{ greeting: { fr: 'x' } }, 'greeting.fr:unknown_field'],
      [{ greeting: { en: 7 } }, 'greeting.en:invalid_type'],
      [{ greeting: { en: 'x'.repeat(401) } }, 'greeting.en:too_long'],
      [{ recordCalls: 'yes' }, 'recordCalls:invalid_type'],
      [{ autoEndCalls: 1 }, 'autoEndCalls:invalid_type'],
      [{ endCallDelaySeconds: '3' }, 'endCallDelaySeconds:invalid_type'],
      [{ endCallDelaySeconds: 1 }, 'endCallDelaySeconds:out_of_range'],
      [{ endCallDelaySeconds: 11 }, 'endCallDelaySeconds:out_of_range'],
      [{ endCallDelaySeconds: 2.5 }, 'endCallDelaySeconds:out_of_range'],
      [{ profileSummary: 5 }, 'profileSummary:invalid_type'],
      [{ profileSummary: 'x'.repeat(1201) }, 'profileSummary:too_long'],
      [{ profileSummarySources: {} }, 'profileSummarySources:invalid_type'],
      [
        { profileSummarySources: Array(11).fill(source()) },
        'profileSummarySources:too_many',
      ],
      [
        { profileSummarySources: ['x'] },
        'profileSummarySources[0]:invalid_type',
      ],
      [
        { profileSummarySources: [{ id: 'd1', title: 'T' }] },
        'profileSummarySources[0].hash:required',
      ],
      [
        { profileSummarySources: [source({ title: 5 })] },
        'profileSummarySources[0].title:invalid_type',
      ],
      [
        { profileSummarySources: [source({ title: 'x'.repeat(301) })] },
        'profileSummarySources[0].title:too_long',
      ],
    ])('refuses %j', (over, expected) => {
      expect(codesAt({ ...base(), ...over })).toEqual([expected]);
    });

    it.each([2, 3, 10])(
      'accepts %i seconds before the call ends',
      (seconds) => {
        expect(
          validator.check(withKey('endCallDelaySeconds', seconds)),
        ).toMatchObject({
          ok: true,
          document: { endCallDelaySeconds: seconds },
        });
      },
    );

    it('stores an empty summary as null, like the engine', () => {
      expect(validator.check(withKey('profileSummary', '  '))).toMatchObject({
        ok: true,
        document: { profileSummary: null },
      });
      expect(validator.check(withKey('profileSummary', null))).toMatchObject({
        ok: true,
        document: { profileSummary: null },
      });
    });
  });

  it('a hostile key such as __proto__ is kept as plain data and never merged into anything', () => {
    const doc = JSON.parse(
      '{"__proto__": {"polluted": true}, "businessName": "A"}',
    ) as Record<string, unknown>;
    const result = validator.check({ ...base(), ...doc });
    expect(result.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const kept = result.ok ? result.document : {};
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
    expect(Object.keys(kept)).toContain('__proto__');
    expect(JSON.parse(JSON.stringify(kept)).__proto__).toEqual({
      polluted: true,
    });
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

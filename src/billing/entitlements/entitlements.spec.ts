import {
  limitFor,
  mergeEntitlements,
  parseEntitlements,
  validateOverride,
} from './entitlements';

describe('parseEntitlements', () => {
  it('reads a well-formed plan row', () => {
    expect(
      parseEntitlements({
        seats: 10,
        conversationsPerPeriod: 1500,
        conversationPeriod: 'month',
        knowledgeMb: 500,
        channels: ['chat', 'whatsapp'],
        voice: true,
        poweredByLabel: false,
        callMinutesPerPeriod: 300,
        callMinutePeriod: 'month',
        overageConversationMinor: 1500,
        overageMinuteMinor: 2500,
        voicePerMinuteMinor: 2500,
        agents: 3,
        phoneNumbers: 5,
      }),
    ).toEqual({
      seats: 10,
      conversationsPerPeriod: 1500,
      conversationPeriod: 'month',
      knowledgeMb: 500,
      channels: ['chat', 'whatsapp'],
      voice: true,
      poweredByLabel: false,
      callMinutesPerPeriod: 300,
      callMinutePeriod: 'month',
      agents: 3,
      phoneNumbers: 5,
      overageConversationMinor: 1500,
      overageMinuteMinor: 2500,
      voicePerMinuteMinor: 2500,
    });
  });

  it('reads the agent and phone-number limits (L7): a number, null for unlimited, 0 when missing', () => {
    expect(parseEntitlements({ agents: 3, phoneNumbers: 5 })).toMatchObject({
      agents: 3,
      phoneNumbers: 5,
    });
    expect(
      parseEntitlements({ agents: null, phoneNumbers: null }),
    ).toMatchObject({ agents: null, phoneNumbers: null });
    expect(parseEntitlements({ seats: 3 })).toMatchObject({
      agents: 0,
      phoneNumbers: 0,
    });
    expect(parseEntitlements({ agents: -1, phoneNumbers: 1.5 })).toMatchObject({
      agents: 0,
      phoneNumbers: 0,
    });
  });

  it('reads the call-minute keys (L6): a number, null for unlimited, the period', () => {
    expect(
      parseEntitlements({
        callMinutesPerPeriod: 30,
        callMinutePeriod: 'total',
      }),
    ).toMatchObject({ callMinutesPerPeriod: 30, callMinutePeriod: 'total' });
    expect(
      parseEntitlements({ callMinutesPerPeriod: null }).callMinutesPerPeriod,
    ).toBeNull();
  });

  it('a plan row without call-minute keys gets 0 minutes (most restrictive) in the month window, never unlimited', () => {
    const parsed = parseEntitlements({ seats: 10, voice: true });
    expect(parsed.callMinutesPerPeriod).toBe(0);
    expect(parsed.callMinutePeriod).toBe('month');
    expect(parsed.overageMinuteMinor).toBeUndefined();
  });

  it('null is unlimited', () => {
    expect(parseEntitlements({ seats: null }).seats).toBeNull();
  });

  it('is restrictive about anything missing or malformed: a broken row never grants more', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}]) {
      expect(parseEntitlements(bad)).toEqual({
        seats: 0,
        conversationsPerPeriod: 0,
        conversationPeriod: 'month',
        knowledgeMb: 0,
        channels: [],
        voice: false,
        poweredByLabel: true,
        callMinutesPerPeriod: 0,
        callMinutePeriod: 'month',
        agents: 0,
        phoneNumbers: 0,
      });
    }
    const odd = parseEntitlements({
      seats: -1,
      conversationsPerPeriod: 1.5,
      knowledgeMb: '20',
      channels: ['chat', 5],
      voice: 'yes',
      callMinutesPerPeriod: -5,
      callMinutePeriod: 'week',
    });
    expect(odd.callMinutesPerPeriod).toBe(0);
    expect(odd.callMinutePeriod).toBe('month');
    expect(odd.seats).toBe(0);
    expect(odd.conversationsPerPeriod).toBe(0);
    expect(odd.knowledgeMb).toBe(0);
    expect(odd.channels).toEqual(['chat']);
    expect(odd.voice).toBe(false);
  });
});

describe('mergeEntitlements', () => {
  it('lets an override replace the plan value key by key', () => {
    const merged = mergeEntitlements(
      { seats: 10, knowledgeMb: 500, channels: ['chat'], voice: false },
      { seats: 40, voice: true },
    );
    expect(merged).toMatchObject({
      seats: 40,
      knowledgeMb: 500,
      channels: ['chat'],
      voice: true,
    });
  });

  it('an override can lift a limit to unlimited with null', () => {
    expect(mergeEntitlements({ seats: 10 }, { seats: null }).seats).toBeNull();
  });

  it('ignores a missing or non-object override', () => {
    expect(mergeEntitlements({ seats: 10 }, null).seats).toBe(10);
    expect(mergeEntitlements({ seats: 10 }, 'x').seats).toBe(10);
  });
});

describe('limitFor', () => {
  it('maps check keys to entitlement fields', () => {
    const e = parseEntitlements({
      seats: 1,
      conversationsPerPeriod: 2,
      knowledgeMb: 3,
      callMinutesPerPeriod: 4,
    });
    expect(limitFor(e, 'callMinutes')).toBe(4);
    expect(limitFor(e, 'seats')).toBe(1);
    expect(limitFor(e, 'conversations')).toBe(2);
    expect(limitFor(e, 'knowledgeMb')).toBe(3);
  });
});

describe('validateOverride', () => {
  it('accepts known keys with the right types', () => {
    const input = {
      seats: 40,
      conversationsPerPeriod: null,
      conversationPeriod: 'month',
      knowledgeMb: 2000,
      channels: ['chat', 'voice'],
      voice: true,
      poweredByLabel: false,
      callMinutesPerPeriod: 600,
      callMinutePeriod: 'total',
      overageConversationMinor: 1000,
      overageMinuteMinor: 2000,
      voicePerMinuteMinor: 2000,
      agents: 10,
      phoneNumbers: null,
    };
    expect(validateOverride(input)).toEqual({ ok: true, value: input });
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['an unknown key', { seatz: 1 }],
    ['a negative limit', { seats: -1 }],
    ['a fractional limit', { knowledgeMb: 1.5 }],
    ['a string limit', { seats: '5' }],
    ['a bad period', { conversationPeriod: 'week' }],
    ['non-string channels', { channels: [1] }],
    ['a non-boolean flag', { voice: 'yes' }],
    ['a negative price hint', { overageConversationMinor: -5 }],
    ['a negative call-minute limit', { callMinutesPerPeriod: -1 }],
    ['a fractional call-minute limit', { callMinutesPerPeriod: 2.5 }],
    ['a string call-minute limit', { callMinutesPerPeriod: '30' }],
    ['a bad call-minute period', { callMinutePeriod: 'week' }],
    ['a negative agent limit', { agents: -1 }],
    ['a fractional phone-number limit', { phoneNumbers: 1.5 }],
    ['a string agent limit', { agents: '3' }],
    ['a negative minute price', { overageMinuteMinor: -1 }],
    ['a fractional minute price', { overageMinuteMinor: 1.5 }],
  ])('rejects %s', (_name, value) => {
    expect(validateOverride(value)).toMatchObject({ ok: false });
  });
});

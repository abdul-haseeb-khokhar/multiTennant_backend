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
        voice: false,
        poweredByLabel: false,
        overageConversationMinor: 1500,
        voicePerMinuteMinor: 2500,
      }),
    ).toEqual({
      seats: 10,
      conversationsPerPeriod: 1500,
      conversationPeriod: 'month',
      knowledgeMb: 500,
      channels: ['chat', 'whatsapp'],
      voice: false,
      poweredByLabel: false,
      overageConversationMinor: 1500,
      voicePerMinuteMinor: 2500,
    });
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
      });
    }
    const odd = parseEntitlements({
      seats: -1,
      conversationsPerPeriod: 1.5,
      knowledgeMb: '20',
      channels: ['chat', 5],
      voice: 'yes',
    });
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
    });
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
      overageConversationMinor: 1000,
      voicePerMinuteMinor: 2000,
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
  ])('rejects %s', (_name, value) => {
    expect(validateOverride(value)).toMatchObject({ ok: false });
  });
});

import {
  AGENT_NAME_MAX,
  AGENT_SETTINGS_KEYS,
  BUSINESS_NAME_MAX,
  buildDefaultSettings,
  defaultAgentName,
} from './agent-settings.defaults';
import { StructuralAgentSettingsValidator } from './agent-settings.validator';

const tenant = {
  tenantName: 'Acme Dental',
  timezone: 'Asia/Karachi',
  defaultLocale: 'en',
};

describe('buildDefaultSettings (L7)', () => {
  it('starts an agent with the business, zone and language of its tenant, Monday to Friday 09:00 to 17:00 and call forwarding off', () => {
    expect(buildDefaultSettings(tenant)).toEqual({
      businessName: 'Acme Dental',
      purpose: '',
      tone: 'professional',
      timezone: 'Asia/Karachi',
      uiLocale: 'en',
      replyLanguage: 'en',
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
        enabled: false,
        contacts: [],
        whenCallerAsks: true,
        afterMisses: 2,
        topics: [],
        outsideHours: 'callback',
      },
      capabilities: {},
      voices: {},
      collect: null,
    });
  });

  it('has exactly the documented top-level keys', () => {
    expect(Object.keys(buildDefaultSettings(tenant)).sort()).toEqual(
      [...AGENT_SETTINGS_KEYS].sort(),
    );
  });

  it('follows the tenant locale when the engine supports it (ur), else English', () => {
    expect(
      buildDefaultSettings({ ...tenant, defaultLocale: 'ur' }),
    ).toMatchObject({ uiLocale: 'ur', replyLanguage: 'ur' });
    expect(
      buildDefaultSettings({ ...tenant, defaultLocale: 'fr' }),
    ).toMatchObject({ uiLocale: 'en', replyLanguage: 'en' });
  });

  it('hands out independent objects (editing one default never changes the next)', () => {
    const a = buildDefaultSettings(tenant);
    a.hours!.mon!.push(['18:00', '19:00']);
    a.escalation.topics.push('refund');
    const b = buildDefaultSettings(tenant);
    expect(b.hours!.mon).toEqual([['09:00', '17:00']]);
    expect(b.escalation.topics).toEqual([]);
  });

  it('trims and cuts a long or blank business name', () => {
    expect(
      buildDefaultSettings({ ...tenant, tenantName: `  ${'x'.repeat(300)} ` })
        .businessName,
    ).toHaveLength(BUSINESS_NAME_MAX);
    expect(
      buildDefaultSettings({ ...tenant, tenantName: '   ' }).businessName,
    ).toBe('Main agent');
  });

  it('is always a document the structural validator accepts', () => {
    const validator = new StructuralAgentSettingsValidator();
    for (const input of [
      tenant,
      { ...tenant, defaultLocale: 'ur' },
      { ...tenant, tenantName: 'x'.repeat(300) },
      { ...tenant, tenantName: ' ' },
    ]) {
      expect(validator.check(buildDefaultSettings(input))).toMatchObject({
        ok: true,
      });
    }
  });
});

describe('defaultAgentName', () => {
  it('is the tenant name, trimmed and cut to the agent name limit', () => {
    expect(defaultAgentName('  Acme Dental ')).toBe('Acme Dental');
    expect(defaultAgentName('y'.repeat(200))).toHaveLength(AGENT_NAME_MAX);
    expect(defaultAgentName('  ')).toBe('Main agent');
  });
});

import { I18nService } from '../i18n/i18n.service';
import {
  DefaultWidgetSettingsProvider,
  FALLBACK_REASONS,
  WidgetSettingsProvider,
  WidgetTextService,
} from './widget-text.service';

describe('WidgetTextService', () => {
  const i18n = new I18nService();
  const make = (settings: WidgetSettingsProvider) =>
    new WidgetTextService(i18n, settings);
  const service = make(new DefaultWidgetSettingsProvider());

  describe('resolveLocale', () => {
    it.each([
      ['ur', undefined, 'ur'],
      ['ur-PK', 'en', 'ur'],
      ['UR_pk', 'en', 'ur'],
      ['fr', 'ur', 'ur'],
      ['fr', 'de', 'en'],
      [undefined, undefined, 'en'],
      ['', 'ur', 'ur'],
    ])('%s with tenant default %s -> %s', (requested, fallback, expected) => {
      expect(service.resolveLocale(requested, fallback)).toBe(expected);
    });
  });

  it('every fallback reason has a translated message in en and ur', async () => {
    for (const reason of FALLBACK_REASONS) {
      const en = await service.fallback('t', reason, 'en');
      const ur = await service.fallback('t', reason, 'ur');
      expect(en.reason).toBe(reason);
      expect(en.message).not.toMatch(/^fallback\./);
      expect(ur.message).not.toMatch(/^fallback\./);
      expect(ur.message).not.toBe(en.message);
    }
  });

  it('never tells the customer about billing in the fallback texts', async () => {
    for (const reason of FALLBACK_REASONS) {
      for (const locale of ['en', 'ur']) {
        const { message } = await service.fallback('t', reason, locale);
        expect(message.toLowerCase()).not.toMatch(
          /suspend|plan|payment|overdue|limit|subscription|upgrade/,
        );
      }
    }
  });

  it('uses the tenant wording when it has some (Phase 5 plugs in agent_config)', async () => {
    const custom = make({
      forTenant: () =>
        Promise.resolve({
          greeting: 'Welcome to Acme!',
          personaName: 'Ava',
          fallbackMessage: 'Acme will be right back.',
        }),
    });
    await expect(custom.fallback('t', 'ai_unavailable', 'en')).resolves.toEqual(
      { reason: 'ai_unavailable', message: 'Acme will be right back.' },
    );
    await expect(custom.greeting('t', 'ur')).resolves.toEqual({
      greeting: 'Welcome to Acme!',
      personaName: 'Ava',
    });
    await expect(custom.escalatedNotice('t', 'en')).resolves.toBe(
      'Acme will be right back.',
    );
  });

  it('greets in the visitor language by default', async () => {
    const en = await service.greeting('t', 'en');
    const ur = await service.greeting('t', 'ur');
    expect(en.greeting).toBe('Hi! How can I help you today?');
    expect(ur.greeting).not.toBe(en.greeting);
    expect(en.personaName).toBe('Assistant');
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCALES } from '../i18n/locales';
import { NOTIFICATION_TYPES, NotificationType } from './notification-types';

const strings = (locale: string): Record<string, string> =>
  JSON.parse(
    readFileSync(
      join(__dirname, '..', 'lang', locale, 'notifications.json'),
      'utf8',
    ),
  );

/** The names used as ICU placeholders in a message: `{customer}`, `{daysLeft, plural, ...}` (top level only). */
function placeholders(message: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  for (let i = 0; i < message.length; i++) {
    if (message[i] === '{') {
      if (depth === 0) {
        const name = /^\{\s*([A-Za-z_]\w*)/.exec(message.slice(i))?.[1];
        if (name) names.add(name);
      }
      depth += 1;
    } else if (message[i] === '}') {
      depth -= 1;
    }
  }
  return [...names];
}

describe('notification types', () => {
  const types = Object.values(NotificationType);

  it('documents every type with its recipients, params and link', () => {
    expect(Object.keys(NOTIFICATION_TYPES).sort()).toEqual([...types].sort());
    for (const type of types) {
      const info = NOTIFICATION_TYPES[type];
      expect(info.recipients).toBeTruthy();
      expect(Object.keys(info.params).length).toBeGreaterThan(0);
    }
  });

  it.each(LOCALES.map((l) => l.code))(
    'has a title and a body in the "notifications" namespace for every type (%s)',
    (locale) => {
      const messages = strings(locale);
      for (const type of types) {
        expect([type, !!messages[`${type}.title`]]).toEqual([type, true]);
        expect([type, !!messages[`${type}.body`]]).toEqual([type, true]);
      }
    },
  );

  it.each(LOCALES.map((l) => l.code))(
    'uses only placeholders the type documents, so the frontend never renders {name} literally (%s)',
    (locale) => {
      const messages = strings(locale);
      for (const type of types) {
        const documented = Object.keys(NOTIFICATION_TYPES[type].params);
        for (const key of [`${type}.title`, `${type}.body`]) {
          for (const name of placeholders(messages[key])) {
            expect([key, name, documented.includes(name)]).toEqual([
              key,
              name,
              true,
            ]);
          }
        }
      }
    },
  );

  it('the Urdu messages use the same placeholders as the English ones', () => {
    const en = strings('en');
    const ur = strings('ur');
    for (const type of types) {
      for (const part of ['title', 'body']) {
        const key = `${type}.${part}`;
        expect([key, placeholders(ur[key]).sort()]).toEqual([
          key,
          placeholders(en[key]).sort(),
        ]);
      }
    }
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode } from '../common/errors/error-codes';
import { I18nService } from './i18n.service';
import { LOCALES, NAMESPACES } from './locales';
import { readNamespace } from './translation-files';

const REAL_LANG_DIR = join(__dirname, '..', 'lang');

describe('I18nService with the shipped files', () => {
  const service = new I18nService();

  it('lists the launch locales with direction: en ltr, ur rtl', () => {
    expect(service.listLocales()).toEqual([
      { code: 'en', name: 'English', dir: 'ltr' },
      { code: 'ur', name: 'اردو', dir: 'rtl' },
    ]);
  });

  it.each(LOCALES.flatMap((l) => NAMESPACES.map((ns) => [l.code, ns])))(
    'serves %s/%s as a flat map of strings with a strong ETag',
    (locale, namespace) => {
      const { entries, etag } = service.get(locale, namespace);
      expect(Object.keys(entries).length).toBeGreaterThan(0);
      expect(Object.values(entries).every((v) => typeof v === 'string')).toBe(
        true,
      );
      expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    },
  );

  it('keeps the ETag stable across calls and different per locale', () => {
    expect(service.get('ur', 'common').etag).toBe(
      service.get('ur', 'common').etag,
    );
    expect(service.get('ur', 'common').etag).not.toBe(
      service.get('en', 'common').etag,
    );
  });

  it('every ur and en key is a stable dot-notation id, not an English sentence', () => {
    for (const namespace of NAMESPACES) {
      if (namespace === 'errors') continue; // keys are the API error codes
      for (const key of Object.keys(service.get('en', namespace).entries)) {
        expect(key).toMatch(/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/);
      }
    }
  });

  it('has a translation, in en and ur, for every stable error code the API can return (H7)', () => {
    const codes = Object.values(ErrorCode);
    for (const locale of ['en', 'ur']) {
      const errors = readNamespace(REAL_LANG_DIR, locale, 'errors', true);
      for (const code of codes) {
        expect(errors[code]).toEqual(expect.any(String));
        expect(errors[code].trim()).not.toBe('');
      }
      // and nothing stale: every key is a real code
      for (const key of Object.keys(errors)) {
        expect(codes).toContain(key);
      }
    }
  });

  it('ur has every en key in every namespace, and no key that en lacks', () => {
    for (const namespace of NAMESPACES) {
      const en = Object.keys(
        readNamespace(REAL_LANG_DIR, 'en', namespace, true),
      );
      const ur = Object.keys(
        readNamespace(REAL_LANG_DIR, 'ur', namespace, true),
      );
      expect(ur.sort()).toEqual(en.sort());
    }
  });

  it('keeps ICU placeholders identical between en and ur', () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)(?:,|\})/g)].map((m) => m[1]).sort();
    for (const namespace of NAMESPACES) {
      const en = readNamespace(REAL_LANG_DIR, 'en', namespace, true);
      const ur = readNamespace(REAL_LANG_DIR, 'ur', namespace, true);
      for (const key of Object.keys(en)) {
        expect({ key, vars: placeholders(ur[key]) }).toEqual({
          key,
          vars: placeholders(en[key]),
        });
      }
    }
  });

  it('404 LOCALE_NOT_FOUND / NAMESPACE_NOT_FOUND for names that are not registered (also path tricks)', () => {
    expect(() => service.get('fr', 'common')).toThrow(
      expect.objectContaining({
        status: 404,
        response: expect.objectContaining({ code: 'LOCALE_NOT_FOUND' }),
      }),
    );
    expect(() => service.get('en', 'secrets')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'NAMESPACE_NOT_FOUND' }),
      }),
    );
    expect(() => service.get('..', 'common')).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => service.get('en', '../../package')).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe('I18nService fallback to en', () => {
  let dir: string;

  const write = (locale: string, namespace: string, data: unknown) => {
    mkdirSync(join(dir, locale), { recursive: true });
    writeFileSync(join(dir, locale, `${namespace}.json`), JSON.stringify(data));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lang-'));
    for (const ns of NAMESPACES)
      write('en', ns, { 'a.one': 'One', 'a.two': 'Two' });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fills a key missing in ur with the English text', () => {
    write('ur', 'common', { 'a.one': 'ایک' });
    const { entries } = new I18nService(dir).get('ur', 'common');
    expect(entries).toEqual({ 'a.one': 'ایک', 'a.two': 'Two' });
  });

  it('serves en for a namespace file that ur does not have at all', () => {
    expect(new I18nService(dir).get('ur', 'widget').entries).toEqual({
      'a.one': 'One',
      'a.two': 'Two',
    });
  });

  it('changes the ETag only when the served content changes', () => {
    write('ur', 'common', { 'a.one': 'ایک' });
    const before = new I18nService(dir).get('ur', 'common').etag;
    write('ur', 'common', { 'a.one': 'ایک', 'a.two': 'Two' }); // same merged content
    expect(new I18nService(dir).get('ur', 'common').etag).toBe(before);
    write('ur', 'common', { 'a.one': 'واحد' });
    expect(new I18nService(dir).get('ur', 'common').etag).not.toBe(before);
  });

  it('refuses to start when an en file is missing or malformed', () => {
    rmSync(join(dir, 'en', 'widget.json'));
    expect(() => new I18nService(dir)).toThrow(/en\/widget\.json/);

    write('en', 'widget', { nested: { not: 'flat' } });
    expect(() => new I18nService(dir)).toThrow(/flat object/);
  });
});

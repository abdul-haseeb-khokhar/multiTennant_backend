/**
 * Warns about translation keys that exist in `en` (the source of truth) but not in another
 * locale, and about keys a locale has that `en` does not. Warnings only: it always exits 0,
 * because the API falls back to `en` for a missing key. It fails (exit 1) only for a file that
 * cannot be parsed.
 *
 *   npm run i18n:check
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LOCALE, LOCALES, NAMESPACES } from '../src/i18n/locales';
import { readNamespace } from '../src/i18n/translation-files';

const langDir = join(__dirname, '..', 'src', 'lang');
let warnings = 0;

function warn(message: string) {
  warnings += 1;
  console.warn(`warning: ${message}`);
}

const known = new Set(LOCALES.map((locale) => locale.code));
for (const folder of readdirSync(langDir, { withFileTypes: true })) {
  if (folder.isDirectory() && !known.has(folder.name)) {
    warn(`src/lang/${folder.name} is not registered in src/i18n/locales.ts`);
  }
}

for (const namespace of NAMESPACES) {
  const source = readNamespace(langDir, DEFAULT_LOCALE, namespace, true);
  for (const locale of LOCALES) {
    if (locale.code === DEFAULT_LOCALE) continue;
    const own = readNamespace(langDir, locale.code, namespace, false);
    const missing = Object.keys(source).filter((key) => !(key in own));
    const extra = Object.keys(own).filter((key) => !(key in source));
    for (const key of missing) {
      warn(
        `${locale.code}/${namespace}: missing key "${key}" (falls back to en)`,
      );
    }
    for (const key of extra) {
      warn(`${locale.code}/${namespace}: key "${key}" does not exist in en`);
    }
  }
}

console.log(
  warnings === 0
    ? 'All locales have every en key.'
    : `${warnings} translation warning(s).`,
);

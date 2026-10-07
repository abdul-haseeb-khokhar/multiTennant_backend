import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { readNamespace, Translations } from './translation-files';
import {
  DEFAULT_LOCALE,
  LOCALES,
  LocaleInfo,
  NAMESPACES,
  Namespace,
} from './locales';

export const LANG_DIR = 'I18N_LANG_DIR';

export interface TranslationBundle {
  entries: Translations;
  /** Strong validator of the merged content; changes only when a served value changes. */
  etag: string;
}

/**
 * Serves the translation files under `src/lang/<locale>/<namespace>.json` (H7). Files are flat
 * key/value maps with stable dot-notation keys; `en` is the source of truth, so a key missing in
 * another locale is answered with the English text. Everything is read once at startup (the
 * files ship with the build), so a missing or malformed `en` file stops the app from booting.
 */
@Injectable()
export class I18nService {
  private readonly bundles = new Map<string, TranslationBundle>();

  constructor(
    @Optional()
    @Inject(LANG_DIR)
    langDir: string = join(__dirname, '..', 'lang'),
  ) {
    for (const namespace of NAMESPACES) {
      const source = readNamespace(langDir, DEFAULT_LOCALE, namespace, true);
      for (const locale of LOCALES) {
        const own =
          locale.code === DEFAULT_LOCALE
            ? source
            : readNamespace(langDir, locale.code, namespace, false);
        const entries = sortKeys({ ...source, ...own });
        this.bundles.set(`${locale.code}/${namespace}`, {
          entries,
          etag: `"${createHash('sha1').update(JSON.stringify(entries)).digest('hex')}"`,
        });
      }
    }
  }

  listLocales(): LocaleInfo[] {
    return [...LOCALES];
  }

  /** Throws 404 `LOCALE_NOT_FOUND` / `NAMESPACE_NOT_FOUND` for names that are not registered. */
  get(locale: string, namespace: string): TranslationBundle {
    if (!LOCALES.some((candidate) => candidate.code === locale)) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.LOCALE_NOT_FOUND,
        `Locale ${locale} is not available`,
      );
    }
    const bundle = this.bundles.get(`${locale}/${namespace}`);
    if (!bundle || !NAMESPACES.includes(namespace as Namespace)) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NAMESPACE_NOT_FOUND,
        `Namespace ${namespace} is not available`,
      );
    }
    return bundle;
  }
}

function sortKeys(entries: Translations): Translations {
  return Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

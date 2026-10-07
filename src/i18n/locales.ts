export interface LocaleInfo {
  /** BCP-47 code, also the folder name under `src/lang`. */
  code: string;
  /** The language's own name, shown in a language picker. */
  name: string;
  dir: 'ltr' | 'rtl';
}

/** Launch locales (H7). To add one: add it here and create `src/lang/<code>/<namespace>.json`. */
export const LOCALES: readonly LocaleInfo[] = [
  { code: 'en', name: 'English', dir: 'ltr' },
  { code: 'ur', name: 'اردو', dir: 'rtl' },
];

export const NAMESPACES = [
  'common',
  'errors',
  'notifications',
  'widget',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** `en` is the source of truth: every key exists there, and other locales fall back to it. */
export const DEFAULT_LOCALE = 'en';

export const LOCALE_CODES = LOCALES.map((locale) => locale.code);

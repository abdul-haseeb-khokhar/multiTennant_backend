import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Translations = Record<string, string>;

/** Reads one translation file. Only the source locale is required to exist. */
export function readNamespace(
  langDir: string,
  locale: string,
  namespace: string,
  required: boolean,
): Translations {
  const file = join(langDir, locale, `${namespace}.json`);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(`Cannot read translation file ${locale}/${namespace}.json`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== 'string')
  ) {
    throw new Error(
      `${locale}/${namespace}.json must be a flat object of string values`,
    );
  }
  return parsed as Translations;
}

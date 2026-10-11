export type FormatParams = Record<string, string | number>;

/**
 * A small subset of ICU message syntax, enough for the email texts: `{name}` placeholders and
 * `{n, plural, one {# day} other {# days}}` (also `=0 {...}`; `#` is the number). The frontend
 * renders the same strings with a full ICU library; the backend only needs this for emails.
 * A placeholder without a value renders as an empty string.
 */
export function formatMessage(
  template: string,
  params: FormatParams,
  locale: string,
): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const char = template[i];
    if (char !== '{') {
      out += char;
      i += 1;
      continue;
    }
    const end = matchingBrace(template, i);
    if (end === -1) {
      out += template.slice(i);
      break;
    }
    out += formatArgument(template.slice(i + 1, end), params, locale);
    i = end + 1;
  }
  return out;
}

function formatArgument(
  inner: string,
  params: FormatParams,
  locale: string,
): string {
  const comma = inner.indexOf(',');
  if (comma === -1) {
    return String(params[inner.trim()] ?? '');
  }
  const name = inner.slice(0, comma).trim();
  const rest = inner.slice(comma + 1);
  const second = rest.indexOf(',');
  if (second === -1 || rest.slice(0, second).trim() !== 'plural') {
    return String(params[name] ?? '');
  }
  const value = Number(params[name] ?? 0);
  const options = parseOptions(rest.slice(second + 1));
  const category = new Intl.PluralRules(locale).select(value);
  const chosen =
    options.get(`=${value}`) ?? options.get(category) ?? options.get('other');
  return formatMessage(
    (chosen ?? '').replace(/#/g, String(value)),
    params,
    locale,
  );
}

/** `one {# day} other {# days}` into a map of selector to text. */
function parseOptions(source: string): Map<string, string> {
  const options = new Map<string, string>();
  let i = 0;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i += 1;
    let selector = '';
    while (i < source.length && !/[\s{]/.test(source[i])) {
      selector += source[i];
      i += 1;
    }
    while (i < source.length && /\s/.test(source[i])) i += 1;
    if (source[i] !== '{' || !selector) break;
    const end = matchingBrace(source, i);
    if (end === -1) break;
    options.set(selector, source.slice(i + 1, end));
    i = end + 1;
  }
  return options;
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

import { Injectable } from '@nestjs/common';
import { I18nService } from '../i18n/i18n.service';
import { DEFAULT_LOCALE, LOCALES, isSupportedLocale } from '../i18n/locales';
import { MailMessage } from './mailer';
import { formatMessage } from './message-format';

export interface RenderOptions {
  /** The product name shown in the footer (`MAIL_FROM_NAME`). */
  product: string;
  /** Test-mode redirect (`MAIL_REDIRECT_TO`): the person the message was really meant for. */
  redirectedFrom?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  /** Locale actually used (an unsupported one falls back to English). */
  lang: string;
  dir: 'ltr' | 'rtl';
}

const URDU_FONTS =
  "'Noto Nastaliq Urdu','Jameel Noori Nastaleeq','Noto Naskh Arabic',Tahoma,Arial,sans-serif";
const LATIN_FONTS =
  "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Turns a `MailMessage` into subject, HTML and plain text from the `email.<template>.*` and
 * `email.layout.*` keys of the `notifications` namespace, in the recipient's language (`ur` is
 * right-to-left: `dir` and `lang` are set on the document). Every interpolated value (the link, the
 * names, the redirected recipient) is HTML-escaped; there are no images, scripts or tracking
 * pixels, and a link must be http(s).
 */
@Injectable()
export class MailRenderer {
  constructor(private readonly i18n: I18nService) {}

  render(message: MailMessage, options: RenderOptions): RenderedEmail {
    const lang = isSupportedLocale(message.locale)
      ? message.locale
      : DEFAULT_LOCALE;
    const dir = LOCALES.find((l) => l.code === lang)?.dir ?? 'ltr';
    const entries = this.i18n.get(lang, 'notifications').entries;
    const params = { ...message.params, product: options.product };
    const t = (key: string, extra: Record<string, string | number> = {}) =>
      formatMessage(entries[key] ?? '', { ...params, ...extra }, lang);
    const key = (part: string) => `email.${message.template}.${part}`;

    if (!/^https?:\/\//i.test(message.link)) {
      throw new Error('An email link must start with http:// or https://');
    }
    const redirectNotice = options.redirectedFrom
      ? t('email.layout.test_notice', { recipient: options.redirectedFrom })
      : null;
    const subject = `${options.redirectedFrom ? `[TEST for ${singleLine(options.redirectedFrom)}] ` : ''}${singleLine(t(key('subject')))}`;
    const body = t(key('body'));
    const cta = t(key('cta'));
    const fallback = t('email.layout.link_fallback');
    const footer = t('email.layout.footer');

    const text = [
      redirectNotice,
      body,
      `${cta}: ${message.link}`,
      '',
      fallback,
      message.link,
      '',
      footer,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');

    const align = dir === 'rtl' ? 'right' : 'left';
    const fonts = dir === 'rtl' ? URDU_FONTS : LATIN_FONTS;
    const href = escapeHtml(message.link);
    const html = `<!doctype html>
<html lang="${lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;">
<tr><td dir="${dir}" style="padding:28px 28px 8px 28px;font-family:${fonts};font-size:16px;line-height:1.7;color:#1f2933;text-align:${align};">
${redirectNotice ? `<p style="margin:0 0 16px 0;padding:10px 12px;background:#fff4e5;border:1px solid #f0b429;border-radius:6px;font-size:14px;">${escapeHtml(redirectNotice)}</p>\n` : ''}<p style="margin:0 0 24px 0;">${escapeHtml(body)}</p>
<p style="margin:0 0 24px 0;"><a href="${href}" style="display:inline-block;padding:12px 22px;background:#1d4ed8;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">${escapeHtml(cta)}</a></p>
<p style="margin:0 0 8px 0;font-size:13px;color:#52606d;">${escapeHtml(fallback)}</p>
<p style="margin:0 0 24px 0;font-size:13px;word-break:break-all;direction:ltr;text-align:${align};"><a href="${href}" style="color:#1d4ed8;">${href}</a></p>
</td></tr>
<tr><td dir="${dir}" style="padding:0 28px 24px 28px;font-family:${fonts};font-size:12px;line-height:1.6;color:#7b8794;text-align:${align};">${escapeHtml(footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
    return { subject, html, text, lang, dir };
  }
}

/** A subject must stay on one line: header injection and odd rendering both start with a newline. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

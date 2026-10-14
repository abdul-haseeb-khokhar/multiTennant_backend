import { I18nService } from '../i18n/i18n.service';
import { MailRenderer, escapeHtml } from './mail-renderer';
import { MailMessage, MailTemplate } from './mailer';

const LINK = 'https://app.example.com/accept-invite?token=abc%20def&x=1';
const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  to: 'agent@acme.com',
  template: 'staff-invite',
  locale: 'en',
  link: LINK,
  ...over,
});

describe('MailRenderer', () => {
  // the real translation files, as the app serves them
  const renderer = new MailRenderer(new I18nService());
  const render = (m: MailMessage, options = { product: 'SupportDesk AI' }) =>
    renderer.render(m, options);

  describe('the three link emails, in both languages', () => {
    it.each([
      ['staff-invite', 'en', 'You are invited to join the team'],
      ['password-reset', 'en', 'Reset your password'],
      ['email-verification', 'en', 'Verify your email address'],
    ] as const)(
      '%s in %s has the subject, the button text and the link',
      (template, locale, subject) => {
        const out = render(message({ template, locale }));
        expect(out.subject).toBe(subject);
        expect(out.html).toContain('<html lang="en" dir="ltr">');
        expect(out.html).toContain(`href="${escapeHtml(LINK)}"`);
        expect(out.text).toContain(LINK);
        expect(out.html).toContain('SupportDesk AI');
      },
    );

    it.each(['staff-invite', 'password-reset', 'email-verification'] as const)(
      '%s in Urdu is right-to-left with lang and dir on the document, and is not the English text',
      (template) => {
        const en = render(message({ template, locale: 'en' }));
        const ur = render(message({ template, locale: 'ur' }));
        expect(ur.html).toContain('<html lang="ur" dir="rtl">');
        expect(ur.html).toContain('text-align:right');
        expect(ur.dir).toBe('rtl');
        expect(ur.subject).not.toBe(en.subject);
        expect(ur.subject).toMatch(/[؀-ۿ]/);
        expect(ur.text).toContain(LINK);
        // the address stays left-to-right inside the right-to-left page
        expect(ur.html).toContain('direction:ltr');
      },
    );

    it('states the expiry in the body (an hour for a reset, 7 days for an invite)', () => {
      expect(render(message({ template: 'password-reset' })).text).toMatch(
        /one hour/,
      );
      expect(render(message({ template: 'staff-invite' })).text).toMatch(
        /7 days/,
      );
    });

    it('falls back to English for a locale it does not have', () => {
      const out = render(message({ locale: 'fr' }));
      expect(out.lang).toBe('en');
      expect(out.html).toContain('<html lang="en" dir="ltr">');
    });
  });

  describe('billing reminder templates', () => {
    const billingLink = 'https://app.example.com/billing';

    it('period ending: plural days and the plan name, in English and Urdu', () => {
      const params = { plan: 'Pro', daysLeft: 1 };
      const one = render(
        message({
          template: 'billing-period-ending',
          link: billingLink,
          params,
        }),
      );
      expect(one.subject).toBe('Your Pro plan ends in 1 day');
      const three = render(
        message({
          template: 'billing-period-ending',
          link: billingLink,
          params: { plan: 'Pro', daysLeft: 3 },
        }),
      );
      expect(three.subject).toBe('Your Pro plan ends in 3 days');
      const ur = render(
        message({
          template: 'billing-period-ending',
          link: billingLink,
          locale: 'ur',
          params: { plan: 'Pro', daysLeft: 3 },
        }),
      );
      expect(ur.html).toContain('dir="rtl"');
      expect(ur.subject).toContain('Pro');
      expect(ur.subject).toContain('3');
    });

    it('grace started and downgraded carry their params', () => {
      const grace = render(
        message({
          template: 'billing-grace-started',
          link: billingLink,
          params: { plan: 'Pro', graceDaysLeft: 7 },
        }),
      );
      expect(grace.text).toContain('7 more days');
      const down = render(
        message({
          template: 'billing-downgraded',
          link: billingLink,
          params: { fromPlan: 'Pro', toPlan: 'Free' },
        }),
      );
      expect(down.text).toContain('Your Pro plan has ended');
      expect(down.text).toContain('Free plan');
      expect(down.html).toContain(`href="${billingLink}"`);
    });
  });

  describe('upgrade request (J5), sent to the platform admins', () => {
    const adminLink = 'https://app.example.com/admin/upgrade-requests';
    const params = {
      tenantName: 'Acme Support',
      currentPlan: 'Starter',
      requestedPlan: 'Pro',
      note: 'we need more seats',
    };

    it('names the workspace, both plans and the owner note, in English and Urdu (right to left)', () => {
      const en = render(
        message({ template: 'upgrade-request', link: adminLink, params }),
      );
      expect(en.subject).toBe('Upgrade request: Acme Support wants Pro');
      for (const part of [
        'Acme Support',
        'Starter',
        'Pro',
        'we need more seats',
      ]) {
        expect(en.text).toContain(part);
      }
      expect(en.html).toContain(`href="${adminLink}"`);

      const ur = render(
        message({
          template: 'upgrade-request',
          locale: 'ur',
          link: adminLink,
          params,
        }),
      );
      expect(ur.dir).toBe('rtl');
      expect(ur.html).toContain('dir="rtl"');
      for (const part of [
        'Acme Support',
        'Starter',
        'Pro',
        'we need more seats',
      ]) {
        expect(ur.text).toContain(part);
      }
    });

    it('escapes what the owner typed: the workspace name and the note cannot inject markup or extra subject lines', () => {
      const out = render(
        message({
          template: 'upgrade-request',
          link: adminLink,
          params: {
            ...params,
            tenantName: '<script>alert(1)</script>\r\nBcc: evil@example.com',
            note: '"><img src=x onerror=alert(1)>',
          },
        }),
      );
      expect(out.html).not.toContain('<script>');
      expect(out.html).not.toContain('<img');
      expect(out.html).toContain('&lt;script&gt;');
      expect(out.subject).not.toMatch(/[\r\n]/);
    });
  });

  describe('every template has every key in both languages', () => {
    const templates: MailTemplate[] = [
      'staff-invite',
      'password-reset',
      'email-verification',
      'billing-period-ending',
      'billing-grace-started',
      'billing-downgraded',
      'upgrade-request',
    ];
    it.each(templates)(
      '%s renders without empty parts in en and ur',
      (template) => {
        for (const locale of ['en', 'ur']) {
          const out = render(
            message({
              template,
              locale,
              params: {
                plan: 'Pro',
                daysLeft: 2,
                graceDaysLeft: 5,
                fromPlan: 'Pro',
                toPlan: 'Free',
                tenantName: 'Acme',
                currentPlan: 'Starter',
                requestedPlan: 'Pro',
                note: 'more seats',
              },
            }),
          );
          expect(out.subject.length).toBeGreaterThan(3);
          expect(out.text.split('\n')[0].length).toBeGreaterThan(3);
          expect(out.html).not.toMatch(/>\s*<\/a>/); // a button with no text
          expect(out.html).not.toMatch(/undefined|\{\w+\}/);
        }
      },
    );
  });

  describe('escaping', () => {
    it('escapes the link, the product name and parameter values in HTML', () => {
      const evil = `"><script>alert(1)</script>`;
      const out = render(
        message({
          template: 'billing-downgraded',
          link: `https://app.example.com/billing?x=${evil}`,
          params: { fromPlan: evil, toPlan: '<img src=x onerror=alert(1)>' },
        }),
        { product: `<b>Evil</b> & "Co"` },
      );
      expect(out.html).not.toContain('<script>');
      expect(out.html).not.toContain('<img');
      expect(out.html).not.toContain('<b>Evil</b>');
      expect(out.html).toContain('&lt;script&gt;');
      expect(out.html).toContain(
        '&lt;b&gt;Evil&lt;/b&gt; &amp; &quot;Co&quot;',
      );
      // an attribute cannot be closed early
      expect(out.html).not.toMatch(/href="[^"]*"><script/);
    });

    it('escapeHtml covers the five characters', () => {
      expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
        '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
      );
    });

    it('refuses a link that is not http(s): no javascript: or data: URLs in a button', () => {
      for (const link of [
        'javascript:alert(1)',
        'data:text/html,x',
        '//evil.test/x',
        '',
      ]) {
        expect(() => render(message({ link }))).toThrow(/http/);
      }
    });

    it('keeps the subject on one line', () => {
      const out = render(
        message({
          template: 'billing-downgraded',
          link: 'https://a.io/billing',
          params: { fromPlan: 'A\r\nBcc: x@y.z', toPlan: 'B' },
        }),
      );
      expect(out.subject).not.toMatch(/[\r\n]/);
    });
  });

  describe('no tracking, no remote content', () => {
    it('has no images, scripts, iframes or external stylesheets; the only URLs are the link itself', () => {
      const out = render(message());
      expect(out.html).not.toMatch(
        /<img|<script|<iframe|<link |@import|url\(/i,
      );
      const urls = out.html.match(/https?:\/\/[^"'<\s]+/g) ?? [];
      expect(new Set(urls)).toEqual(new Set([escapeHtml(LINK)]));
    });
  });

  describe('test-mode redirect', () => {
    it('names the intended recipient in the subject and in a marked block at the top of the body', () => {
      const out = render(message({ locale: 'en' }), {
        product: 'SupportDesk AI',
        redirectedFrom: 'agent@acme.com',
      } as never);
      expect(out.subject).toBe(
        '[TEST for agent@acme.com] You are invited to join the team',
      );
      expect(out.text.split('\n')[0]).toContain('Test mode');
      expect(out.text.split('\n')[0]).toContain('agent@acme.com');
      expect(out.html).toContain('background:#fff4e5');
      expect(out.html.indexOf('Test mode')).toBeLessThan(
        out.html.indexOf('You have been invited'),
      );
    });

    it('escapes the intended recipient, and works in Urdu', () => {
      const out = render(message({ locale: 'ur' }), {
        product: 'SupportDesk AI',
        redirectedFrom: '"><b>x</b>@acme.com',
      } as never);
      expect(out.html).not.toContain('<b>x</b>');
      expect(out.html).toContain('ٹیسٹ موڈ');
    });

    it('is absent without a redirect', () => {
      const out = render(message());
      expect(out.subject).not.toContain('[TEST');
      expect(out.html).not.toContain('Test mode');
    });
  });
});

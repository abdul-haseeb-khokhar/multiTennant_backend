import { formatMessage } from './message-format';

describe('formatMessage', () => {
  it('replaces placeholders and leaves plain text alone', () => {
    expect(
      formatMessage(
        'Hello {name}, plan {plan}.',
        { name: 'Sara', plan: 'Pro' },
        'en',
      ),
    ).toBe('Hello Sara, plan Pro.');
    expect(formatMessage('no placeholders', {}, 'en')).toBe('no placeholders');
  });

  it('renders a missing value as empty rather than "undefined"', () => {
    expect(formatMessage('Hi {name}!', {}, 'en')).toBe('Hi !');
  });

  it('picks the plural form and fills #', () => {
    const text = 'ends in {days, plural, one {# day} other {# days}}';
    expect(formatMessage(text, { days: 1 }, 'en')).toBe('ends in 1 day');
    expect(formatMessage(text, { days: 3 }, 'en')).toBe('ends in 3 days');
    expect(formatMessage(text, { days: 0 }, 'en')).toBe('ends in 0 days');
  });

  it('supports exact matches and placeholders inside a plural option', () => {
    const text =
      '{n, plural, =0 {none of {plan}} one {# of {plan}} other {# of {plan}}}';
    expect(formatMessage(text, { n: 0, plan: 'Pro' }, 'en')).toBe(
      'none of Pro',
    );
    expect(formatMessage(text, { n: 5, plan: 'Pro' }, 'en')).toBe('5 of Pro');
  });

  it('works for Urdu text', () => {
    expect(
      formatMessage(
        '{days, plural, one {# دن} other {# دن}} باقی',
        { days: 2 },
        'ur',
      ),
    ).toBe('2 دن باقی');
  });

  it('keeps an unclosed brace as text instead of looping or throwing', () => {
    expect(formatMessage('broken {name', { name: 'x' }, 'en')).toBe(
      'broken {name',
    );
  });

  it('does not interpret values: braces in a value stay as they are', () => {
    expect(
      formatMessage('Hi {name}', { name: '{evil, plural, other {x}}' }, 'en'),
    ).toBe('Hi {evil, plural, other {x}}');
  });
});

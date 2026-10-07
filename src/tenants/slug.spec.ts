import { isReservedSlug, SLUG_PATTERN, slugify, withSuffix } from './slug';

describe('slug', () => {
  describe('slugify', () => {
    it.each([
      ['Acme Support', 'acme-support'],
      ['  ACME   Ltd.  ', 'acme-ltd'],
      ['Café Crème', 'cafe-creme'],
      ['a/b\\c', 'a-b-c'],
    ])('%j -> %j', (name, slug) => {
      expect(slugify(name)).toBe(slug);
    });

    it('falls back to "workspace" when nothing usable is left', () => {
      expect(slugify('!!!')).toBe('workspace');
      expect(slugify('ab')).toBe('workspace'); // too short for the pattern
      expect(slugify('مرحبا')).toBe('workspace');
    });

    it('never returns a reserved slug and always matches the pattern', () => {
      expect(slugify('Admin')).toBe('workspace');
      expect(slugify('x'.repeat(100))).toMatch(SLUG_PATTERN);
      expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(40);
    });
  });

  describe('SLUG_PATTERN', () => {
    it.each(['acme', 'a1b', 'my-company-2'])('accepts %s', (s) =>
      expect(SLUG_PATTERN.test(s)).toBe(true),
    );
    it.each(['ab', '-acme', 'acme-', 'Acme', 'a_b_c', 'a b c', 'x'.repeat(41)])(
      'rejects %s',
      (s) => expect(SLUG_PATTERN.test(s)).toBe(false),
    );
  });

  it('reserves route-like names', () => {
    expect(isReservedSlug('admin')).toBe(true);
    expect(isReservedSlug('api')).toBe(true);
    expect(isReservedSlug('acme')).toBe(false);
  });

  it('withSuffix stays within 40 characters and matches the pattern', () => {
    const slug = withSuffix('x'.repeat(40));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toMatch(SLUG_PATTERN);
    expect(withSuffix('acme')).toMatch(/^acme-[0-9a-f]{6}$/);
  });
});

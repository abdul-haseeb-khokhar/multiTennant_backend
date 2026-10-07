import { containsNullByte, NoNullBytesPipe } from './no-null-bytes.pipe';

describe('NoNullBytesPipe', () => {
  const pipe = new NoNullBytesPipe();

  it('passes ordinary input through untouched', () => {
    const body = { a: 'x', n: 1, nested: { list: ['y', { z: 'اردو' }] } };
    expect(pipe.transform(body)).toBe(body);
    expect(pipe.transform('plain')).toBe('plain');
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform(null)).toBeNull();
  });

  it.each([
    ['a string', 'a\u0000b'],
    ['a nested value', { a: { b: ['ok', 'x\u0000'] } }],
    ['an object key', { ['k\u0000']: 'v' }],
    ['a query array', { tag: ['ok', 'bad\u0000'] }],
  ])('rejects a NUL in %s with 400 and a validation detail', (_name, value) => {
    expect(() => pipe.transform(value)).toThrow(
      expect.objectContaining({
        status: 400,
        response: expect.objectContaining({
          message: [expect.stringContaining('NUL')],
        }),
      }),
    );
  });

  it('does not recurse forever on deep or cyclic input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(containsNullByte(cyclic)).toBe(false);
  });
});

import { StreamRegistry } from './stream-registry';

describe('StreamRegistry', () => {
  it('lets an owner open streams up to the cap', () => {
    const registry = new StreamRegistry();
    const closers = [jest.fn(), jest.fn(), jest.fn()];
    closers.forEach((close) => registry.register('u1', 3, close));
    expect(registry.count('u1')).toBe(3);
    closers.forEach((close) => expect(close).not.toHaveBeenCalled());
  });

  it('closes the OLDEST stream when a new one exceeds the cap, so a reload never locks the user out', () => {
    const registry = new StreamRegistry();
    const [a, b, c, d] = [jest.fn(), jest.fn(), jest.fn(), jest.fn()];
    registry.register('u1', 3, a);
    registry.register('u1', 3, b);
    registry.register('u1', 3, c);
    registry.register('u1', 3, d);
    expect(a).toHaveBeenCalledWith('limit');
    expect(b).not.toHaveBeenCalled();
    expect(registry.count('u1')).toBe(3);
  });

  it('counts per owner and forgets a stream that ended', () => {
    const registry = new StreamRegistry();
    const release = registry.register('u1', 2, jest.fn());
    registry.register('u2', 2, jest.fn());
    expect(registry.count('u1')).toBe(1);
    release();
    release();
    expect(registry.count('u1')).toBe(0);
    expect(registry.count('u2')).toBe(1);
  });

  it('survives a closer that throws', () => {
    const registry = new StreamRegistry();
    registry.register('u1', 1, () => {
      throw new Error('gone');
    });
    expect(() => registry.register('u1', 1, jest.fn())).not.toThrow();
  });
});

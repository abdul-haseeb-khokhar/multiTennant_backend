import { JsonLogger } from './json-logger';

describe('JsonLogger', () => {
  const logger = new JsonLogger();
  let out: jest.SpyInstance;
  let err: jest.SpyInstance;

  beforeEach(() => {
    out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    out.mockRestore();
    err.mockRestore();
  });

  const lastLine = (spy: jest.SpyInstance) =>
    JSON.parse(spy.mock.calls.at(-1)![0]);

  it('prints one JSON object per line with timestamp, level and context', () => {
    logger.log('hello', 'MyContext');
    expect(out.mock.calls[0][0].endsWith('\n')).toBe(true);
    expect(lastLine(out)).toMatchObject({
      level: 'log',
      context: 'MyContext',
      message: 'hello',
    });
    expect(new Date(lastLine(out).timestamp).toISOString()).toBe(
      lastLine(out).timestamp,
    );
  });

  it('merges an object message so requestId and tenantId become top-level fields', () => {
    logger.log(
      { message: 'request completed', requestId: 'r1', tenantId: 't1' },
      'HTTP',
    );
    expect(lastLine(out)).toMatchObject({
      context: 'HTTP',
      requestId: 'r1',
      tenantId: 't1',
    });
  });

  it('writes errors to stderr', () => {
    logger.error({ message: 'boom', stack: 'trace' }, 'Exception');
    expect(err).toHaveBeenCalledTimes(1);
    expect(out).not.toHaveBeenCalled();
    expect(lastLine(err)).toMatchObject({ level: 'error', message: 'boom' });
  });
});

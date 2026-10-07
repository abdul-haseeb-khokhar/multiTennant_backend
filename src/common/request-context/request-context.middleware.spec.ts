import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { requestContextMiddleware } from './request-context.middleware';

function run(
  headers: Record<string, string> = {},
  extra: Record<string, unknown> = {},
) {
  const req: any = {
    method: 'GET',
    originalUrl: '/v1/tenants/t1/users?email=a@b.co',
    header: (name: string) => headers[name.toLowerCase()],
    ...extra,
  };
  const res: any = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: jest.fn(),
  });
  const next = jest.fn();
  requestContextMiddleware(req, res, next);
  return { req, res, next };
}

describe('requestContextMiddleware', () => {
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });
  afterEach(() => log.mockRestore());

  it('generates an id, sets the response header and calls next', () => {
    const { req, res, next } = run();
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.id);
    expect(next).toHaveBeenCalled();
  });

  it('reuses a safe incoming id and replaces an unsafe one', () => {
    expect(run({ 'x-request-id': 'abc-123' }).req.id).toBe('abc-123');
    expect(run({ 'x-request-id': 'a b\nc' }).req.id).not.toBe('a b\nc');
    expect(run({ 'x-request-id': 'x'.repeat(200) }).req.id).not.toBe(
      'x'.repeat(200),
    );
  });

  it('logs one structured line on finish with the tenantId and without the query string', () => {
    const { req, res } = run({}, { user: { tenantId: 't1', userId: 'u1' } });
    res.statusCode = 403;
    res.emit('finish');

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toMatchObject({
      message: 'request completed',
      requestId: req.id,
      tenantId: 't1',
      userId: 'u1',
      method: 'GET',
      path: '/v1/tenants/t1/users',
      statusCode: 403,
    });
    expect(JSON.stringify(log.mock.calls[0][0])).not.toContain('a@b.co');
  });

  it('does not log health probes', () => {
    const { res } = run({}, { originalUrl: '/health/ready' });
    res.emit('finish');
    expect(log).not.toHaveBeenCalled();
  });
});

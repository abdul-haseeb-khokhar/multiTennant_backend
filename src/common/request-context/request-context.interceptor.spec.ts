import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { RequestContextInterceptor } from './request-context.interceptor';
import { currentRequestMeta } from './request-store';

describe('RequestContextInterceptor', () => {
  const interceptor = new RequestContextInterceptor();
  const context = (req: object, type = 'http') =>
    ({
      getType: () => type,
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  it('exposes request id, ip and user agent to code running inside the handler', async () => {
    let seen: unknown;
    const handler: CallHandler = {
      handle: () => {
        seen = currentRequestMeta();
        return of('done');
      },
    };
    const result = await lastValueFrom(
      interceptor.intercept(
        context({
          id: 'req-1',
          ip: '1.2.3.4',
          headers: { 'user-agent': 'jest' },
        }),
        handler,
      ),
    );
    expect(result).toBe('done');
    expect(seen).toEqual({
      requestId: 'req-1',
      ip: '1.2.3.4',
      userAgent: 'jest',
    });
  });

  it('leaves no context behind outside a request', () => {
    expect(currentRequestMeta()).toEqual({});
  });

  it('does nothing for non-http contexts', async () => {
    const handle = jest.fn().mockReturnValue(of(1));
    await lastValueFrom(interceptor.intercept(context({}, 'rpc'), { handle }));
    expect(handle).toHaveBeenCalled();
  });
});

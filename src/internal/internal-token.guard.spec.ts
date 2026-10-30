import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/errors/api.exception';
import { InternalTokenGuard } from './internal-token.guard';

const TOKEN = 'unit-test-internal-token-0123456789abcdef';

const context = (authorization?: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  }) as unknown as ExecutionContext;

const guard = (token: string | undefined) =>
  new InternalTokenGuard({
    get: (name: string) => (name === 'INTERNAL_API_TOKEN' ? token : undefined),
  } as unknown as ConfigService);

const status = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiException) return error.getStatus();
    throw error;
  }
  return 200;
};

describe('InternalTokenGuard', () => {
  it('lets the right bearer token through', () => {
    expect(guard(TOKEN).canActivate(context(`Bearer ${TOKEN}`))).toBe(true);
    expect(guard(TOKEN).canActivate(context(`bearer   ${TOKEN}  `))).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['the token without the scheme', TOKEN],
    ['another scheme', `Basic ${TOKEN}`],
    ['a wrong token', 'Bearer not-the-token'],
    ['a prefix of the token', `Bearer ${TOKEN.slice(0, -1)}`],
    ['the token with a suffix', `Bearer ${TOKEN}x`],
    ['two tokens', `Bearer ${TOKEN} ${TOKEN}`],
  ])('answers 401 for %s', (_name, header) => {
    expect(status(() => guard(TOKEN).canActivate(context(header)))).toBe(401);
  });

  it('answers 503 when the deployment has no INTERNAL_API_TOKEN, whatever is sent', () => {
    expect(
      status(() => guard(undefined).canActivate(context('Bearer x'))),
    ).toBe(503);
    expect(status(() => guard('').canActivate(context(undefined)))).toBe(503);
  });

  it('gives the same body for every kind of failure', () => {
    const bodies = [undefined, 'Bearer wrong', `Basic ${TOKEN}`].map(
      (header) => {
        try {
          guard(TOKEN).canActivate(context(header));
        } catch (error) {
          return (error as ApiException).getResponse();
        }
      },
    );
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });
});

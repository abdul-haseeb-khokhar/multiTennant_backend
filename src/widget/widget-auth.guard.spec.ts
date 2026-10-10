import { ExecutionContext } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { WidgetAuthGuard } from './widget-auth.guard';
import { WidgetTokenService } from './widget-token.service';

const claims = {
  tenantId: 'tenant-a',
  endCustomerId: 'ec-1',
  conversationId: 'conv-1',
  keyId: 'key-1',
  locale: 'en',
};

describe('WidgetAuthGuard', () => {
  let tokens: { verify: jest.Mock };
  let apiKeys: {
    findActiveWidgetKey: jest.Mock;
    originAllowed: jest.Mock;
    touch: jest.Mock;
  };
  let guard: WidgetAuthGuard;
  const headers: Record<string, string> = {};
  const setHeader = jest.fn();
  const vary = jest.fn();
  let request: { headers: Record<string, string>; widget?: unknown };

  const context = () =>
    ({
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader, vary }),
      }),
    }) as unknown as ExecutionContext;

  const codeOf = async () => {
    try {
      await guard.canActivate(context());
    } catch (error) {
      return (error as ApiException).code;
    }
    return null;
  };

  beforeEach(() => {
    jest.resetAllMocks();
    Object.keys(headers).forEach((key) => delete headers[key]);
    request = {
      headers: {
        authorization: 'Bearer the-token',
        origin: 'https://shop.example.com',
      },
    };
    tokens = { verify: jest.fn().mockReturnValue(claims) };
    apiKeys = {
      findActiveWidgetKey: jest
        .fn()
        .mockResolvedValue({ id: 'key-1', allowedOrigins: [] }),
      originAllowed: jest.fn().mockReturnValue(true),
      touch: jest.fn(),
    };
    guard = new WidgetAuthGuard(
      tokens as unknown as WidgetTokenService,
      apiKeys as never,
    );
  });

  it('lets a valid token from an allowed origin through and exposes the claims plus the origin', async () => {
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(request.widget).toEqual({
      ...claims,
      origin: 'https://shop.example.com',
    });
    expect(apiKeys.findActiveWidgetKey).toHaveBeenCalledWith(
      'tenant-a',
      'key-1',
    );
    expect(apiKeys.touch).toHaveBeenCalledWith('tenant-a', 'key-1');
    expect(setHeader).toHaveBeenCalledWith(
      'Access-Control-Allow-Origin',
      'https://shop.example.com',
    );
  });

  it('refuses a missing or non-bearer Authorization header', async () => {
    delete request.headers.authorization;
    expect(await codeOf()).toBe('UNAUTHORIZED');
    request.headers.authorization = 'Basic abc';
    expect(await codeOf()).toBe('UNAUTHORIZED');
    expect(tokens.verify).not.toHaveBeenCalled();
  });

  it('refuses when the token does not verify (staff, platform, expired, tampered)', async () => {
    tokens.verify.mockImplementation(() => {
      throw new ApiException(401, 'WIDGET_TOKEN_EXPIRED' as never, 'expired');
    });
    expect(await codeOf()).toBe('WIDGET_TOKEN_EXPIRED');
    expect(apiKeys.findActiveWidgetKey).not.toHaveBeenCalled();
  });

  it('refuses when the key of the session was revoked', async () => {
    apiKeys.findActiveWidgetKey.mockResolvedValue(null);
    expect(await codeOf()).toBe('WIDGET_KEY_INVALID');
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('refuses a missing Origin and an origin the key does not allow, and grants no CORS access', async () => {
    delete request.headers.origin;
    expect(await codeOf()).toBe('ORIGIN_NOT_ALLOWED');
    request.headers.origin = 'https://evil.example.com';
    apiKeys.originAllowed.mockReturnValue(false);
    expect(await codeOf()).toBe('ORIGIN_NOT_ALLOWED');
    expect(setHeader).not.toHaveBeenCalled();
    expect(request.widget).toBeUndefined();
  });

  it('looks the key up inside the tenant of the token, never anywhere else', async () => {
    tokens.verify.mockReturnValue({ ...claims, tenantId: 'tenant-b' });
    await guard.canActivate(context());
    expect(apiKeys.findActiveWidgetKey).toHaveBeenCalledWith(
      'tenant-b',
      'key-1',
    );
  });
});

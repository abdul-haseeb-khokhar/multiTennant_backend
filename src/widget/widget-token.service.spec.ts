import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { WidgetTokenService } from './widget-token.service';

const SECRET = 'a-secret-with-at-least-16-chars';
const claims = {
  tenantId: 'tenant-a',
  endCustomerId: 'ec-1',
  conversationId: 'conv-1',
  keyId: 'key-1',
  locale: 'ur',
};

function codeOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    return (error as ApiException).code;
  }
  return null;
}

describe('WidgetTokenService (D3)', () => {
  const jwt = new JwtService({});
  const config = { getOrThrow: () => SECRET } as unknown as ConfigService;
  const service = new WidgetTokenService(config);

  it('signs a token for 15 minutes with scope widget and the three claims of D3', () => {
    const { token, expiresAt } = service.sign(claims);
    const decoded = jwt.decode(token);
    expect(decoded).toMatchObject({ ...claims, scope: 'widget', sub: 'ec-1' });
    expect(decoded.exp - decoded.iat).toBe(15 * 60);
    expect(Math.abs(expiresAt.getTime() - Date.now() - 900_000)).toBeLessThan(
      2000,
    );
    expect(service.verify(token)).toMatchObject(claims);
  });

  it('is not signed with JWT_SECRET: a token signed with the staff secret is refused', () => {
    const staffLike = jwt.sign(
      { ...claims, scope: 'widget' },
      { secret: SECRET },
    );
    expect(codeOf(() => service.verify(staffLike))).toBe(
      ErrorCode.UNAUTHORIZED,
    );
  });

  it('refuses staff and platform tokens, even with a forged scope claim', () => {
    const staff = jwt.sign(
      { sub: 'u1', tenantId: 'tenant-a', role: 'owner', scope: 'tenant' },
      { secret: SECRET },
    );
    const platform = jwt.sign(
      { sub: 'admin-1', scope: 'platform' },
      { secret: SECRET },
    );
    expect(codeOf(() => service.verify(staff))).toBe(ErrorCode.UNAUTHORIZED);
    expect(codeOf(() => service.verify(platform))).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('refuses a widget token whose scope or claims were removed', () => {
    const derived = (service as unknown as { secret: string }).secret;
    const noScope = jwt.sign(claims, { secret: derived });
    const wrongScope = jwt.sign(
      { ...claims, scope: 'tenant' },
      { secret: derived },
    );
    const noConversation = jwt.sign(
      { ...claims, conversationId: undefined, scope: 'widget' },
      { secret: derived },
    );
    for (const token of [noScope, wrongScope, noConversation]) {
      expect(codeOf(() => service.verify(token))).toBe(ErrorCode.UNAUTHORIZED);
    }
  });

  it('tells an expired token apart so the widget can refresh', () => {
    const derived = (service as unknown as { secret: string }).secret;
    const expired = jwt.sign(
      { ...claims, scope: 'widget' },
      { secret: derived, expiresIn: -10 },
    );
    expect(codeOf(() => service.verify(expired))).toBe(
      ErrorCode.WIDGET_TOKEN_EXPIRED,
    );
  });

  it('refuses garbage and a tampered token', () => {
    const { token } = service.sign(claims);
    const [h, p, s] = token.split('.');
    const forged = `${h}.${Buffer.from(
      JSON.stringify({ ...claims, tenantId: 'tenant-b', scope: 'widget' }),
    ).toString('base64url')}.${s}`;
    expect(codeOf(() => service.verify(forged))).toBe(ErrorCode.UNAUTHORIZED);
    expect(codeOf(() => service.verify('not-a-jwt'))).toBe(
      ErrorCode.UNAUTHORIZED,
    );
    expect(codeOf(() => service.verify(`${h}.${p}.`))).toBe(
      ErrorCode.UNAUTHORIZED,
    );
  });
});

import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac } from 'node:crypto';
import { SessionTokenService } from './session-token.service';
import {
  SELECTION_TOKEN_TTL_SECONDS,
  WORKSPACE_SELECT_SCOPE,
  WorkspaceSelectionTokenService,
} from './workspace-selection-token.service';
import { WidgetTokenService } from '../widget/widget-token.service';

const SECRET = 'unit-test-secret-at-least-16-chars';
const config = (secret = SECRET) =>
  ({ getOrThrow: () => secret }) as unknown as ConfigService;

describe('WorkspaceSelectionTokenService', () => {
  const service = new WorkspaceSelectionTokenService(config());

  it('signs a token valid for 10 minutes that lists user ids and nothing else about the person', () => {
    const { token, expiresIn } = service.sign(['u1', 'u2']);
    expect(expiresIn).toBe(600);
    expect(SELECTION_TOKEN_TTL_SECONDS).toBe(600);

    const payload = new JwtService({}).decode(token) as Record<string, unknown>;
    expect(payload.scope).toBe(WORKSPACE_SELECT_SCOPE);
    expect(payload.userIds).toEqual(['u1', 'u2']);
    expect((payload.exp! as number) - (payload.iat as number)).toBe(600);
    // no email, no tenant, no name anywhere in the token
    expect(Object.keys(payload).sort()).toEqual(
      ['exp', 'iat', 'iatMs', 'jti', 'scope', 'userIds'].sort(),
    );
  });

  it('verifies what it signed and returns the claims, with the millisecond issue time', () => {
    const before = Date.now();
    const { token } = service.sign(['u1']);
    const claims = service.verify(token);
    expect(claims.userIds).toEqual(['u1']);
    expect(claims.iatMs).toBeGreaterThanOrEqual(before);
    expect(claims.iatMs).toBeLessThanOrEqual(Date.now());
    expect(claims.iat).toBeDefined();
  });

  it('two tokens for the same memberships differ (unique id)', () => {
    expect(service.sign(['u1']).token).not.toBe(service.sign(['u1']).token);
  });

  describe('is not interchangeable with any other token', () => {
    const jwtWith = (secret: string, claims: Record<string, unknown>) =>
      new JwtService({}).sign(claims, { secret, expiresIn: 600 });

    it('a staff token (signed with JWT_SECRET) is refused here, even with the right scope and claims', () => {
      const staff = jwtWith(SECRET, {
        scope: WORKSPACE_SELECT_SCOPE,
        userIds: ['u1'],
      });
      expect(() => service.verify(staff)).toThrow(
        expect.objectContaining({
          status: 401,
          response: expect.objectContaining({
            code: 'SELECTION_TOKEN_INVALID',
          }),
        }),
      );
    });

    it('a selection token is refused as a staff token (the staff secret is JWT_SECRET itself)', () => {
      const { token } = service.sign(['u1']);
      expect(() =>
        new JwtService({}).verify(token, { secret: SECRET }),
      ).toThrow('invalid signature');
    });

    it('a widget token and a selection token do not verify each other', () => {
      const widget = new WidgetTokenService(config());
      const { token: widgetToken } = widget.sign({
        tenantId: 't1',
        endCustomerId: 'e1',
        conversationId: 'c1',
        keyId: 'k1',
        locale: 'en',
      });
      expect(() => service.verify(widgetToken)).toThrow();
      const { token } = service.sign(['u1']);
      expect(() => widget.verify(token)).toThrow();
    });

    it('a session token from SessionTokenService is refused', () => {
      const session = new SessionTokenService(
        new JwtService({ secret: SECRET }),
      ).sign('u1', 't1', 'owner');
      expect(() => service.verify(session)).toThrow();
    });

    it('a token signed with the derived secret but another scope is refused', () => {
      const derived = createHmac('sha256', SECRET)
        .update('workspace-selection-token-v1')
        .digest('hex');
      const forged = jwtWith(derived, { scope: 'tenant', userIds: ['u1'] });
      expect(() => service.verify(forged)).toThrow();
    });

    it('another deployment (another JWT_SECRET) cannot forge or read tokens of this one', () => {
      const other = new WorkspaceSelectionTokenService(
        config('another-secret-of-16-chars!!'),
      );
      expect(() => service.verify(other.sign(['u1']).token)).toThrow();
    });
  });

  it.each([
    ['garbage', 'not-a-token'],
    ['empty', ''],
  ])('refuses %s with 401 SELECTION_TOKEN_INVALID', (_n, token) => {
    expect(() => service.verify(token)).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('refuses an expired token', () => {
    jest.useFakeTimers({ now: new Date('2026-10-13T00:00:00Z') });
    try {
      const { token } = service.sign(['u1']);
      jest.setSystemTime(new Date('2026-10-13T00:10:01Z'));
      expect(() => service.verify(token)).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'SELECTION_TOKEN_INVALID',
          }),
        }),
      );
      jest.setSystemTime(new Date('2026-10-13T00:09:59Z'));
      expect(service.verify(token).userIds).toEqual(['u1']);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['no user ids', { scope: WORKSPACE_SELECT_SCOPE, userIds: [] }],
    [
      'user ids of the wrong type',
      { scope: WORKSPACE_SELECT_SCOPE, userIds: [1, 2] },
    ],
    ['no user ids field', { scope: WORKSPACE_SELECT_SCOPE }],
  ])('refuses a correctly signed token with %s', (_n, claims) => {
    const derived = createHmac('sha256', SECRET)
      .update('workspace-selection-token-v1')
      .digest('hex');
    const token = new JwtService({}).sign(claims, {
      secret: derived,
      expiresIn: 600,
    });
    expect(() => service.verify(token)).toThrow();
  });
});

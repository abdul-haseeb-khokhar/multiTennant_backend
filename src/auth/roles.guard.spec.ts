import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Roles } from './roles';
import { RolesGuard } from './roles.guard';

class Handlers {
  @Roles('owner', 'admin')
  restricted() {}

  unannotated() {}
}

function contextFor(handler: () => void, user?: { role: string }) {
  return {
    getHandler: () => handler,
    getClass: () => Handlers,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const h = new Handlers();

  it.each(['owner', 'admin'])('lets %s through', (role) => {
    expect(guard.canActivate(contextFor(h.restricted, { role }))).toBe(true);
  });

  it('refuses an agent with 403 INSUFFICIENT_ROLE', () => {
    expect(() =>
      guard.canActivate(contextFor(h.restricted, { role: 'agent' })),
    ).toThrow(
      expect.objectContaining({
        status: 403,
        response: expect.objectContaining({ code: 'INSUFFICIENT_ROLE' }),
      }),
    );
  });

  it('refuses an unknown role and a missing user', () => {
    expect(() =>
      guard.canActivate(contextFor(h.restricted, { role: 'superuser' })),
    ).toThrow();
    expect(() =>
      guard.canActivate(contextFor(h.restricted, undefined)),
    ).toThrow();
  });

  it('fails closed: a handler without @Roles is refused for everyone', () => {
    expect(() =>
      guard.canActivate(contextFor(h.unannotated, { role: 'owner' })),
    ).toThrow(expect.objectContaining({ status: 403 }));
  });
});

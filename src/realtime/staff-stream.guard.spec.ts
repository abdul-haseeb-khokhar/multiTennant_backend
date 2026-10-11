import { ExecutionContext } from '@nestjs/common';
import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { StaffStreamGuard } from './staff-stream.guard';

function context(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('StaffStreamGuard', () => {
  let prisma: PrismaMock;
  let jwt: { canActivate: jest.Mock };
  let tickets: { redeem: jest.Mock };
  let guard: StaffStreamGuard;

  const issuedAt = new Date('2026-10-10T10:00:00.000Z');
  const request = (over: Record<string, unknown> = {}) => ({
    headers: {},
    query: {},
    params: { tenantId: 't1' },
    ...over,
  });

  beforeEach(() => {
    prisma = createPrismaMock();
    jwt = { canActivate: jest.fn().mockResolvedValue(true) };
    tickets = {
      redeem: jest.fn().mockResolvedValue({ userId: 'u1', issuedAt }),
    };
    prisma.tenantUser.findFirst.mockResolvedValue({
      role: 'agent',
      status: 'active',
      emailVerifiedAt: new Date('2026-01-01'),
      passwordChangedAt: null,
    });
    prisma.tenant.findUnique.mockResolvedValue({ status: 'active' });
    guard = new StaffStreamGuard(
      jwt as never,
      tickets as never,
      prisma as never,
    );
  });

  describe('with an Authorization header', () => {
    it('goes through the ordinary staff guard and never looks at a ticket', async () => {
      const ctx = context(
        request({
          headers: { authorization: 'Bearer abc' },
          query: { ticket: 'x' },
        }),
      );
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(jwt.canActivate).toHaveBeenCalledWith(ctx);
      expect(tickets.redeem).not.toHaveBeenCalled();
    });

    it('passes on a refusal of the staff guard (bad token, wrong tenant, suspended)', async () => {
      jwt.canActivate.mockRejectedValue(new Error('refused'));
      await expect(
        guard.canActivate(
          context(request({ headers: { authorization: 'Bearer bad' } })),
        ),
      ).rejects.toThrow('refused');
    });
  });

  describe('with a ticket', () => {
    it('accepts a valid single-use ticket and builds the user from the DATABASE (current role)', async () => {
      const req = request({ query: { ticket: 'tk' } });
      await expect(guard.canActivate(context(req))).resolves.toBe(true);
      expect(tickets.redeem).toHaveBeenCalledWith('tk', 't1');
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'u1', tenantId: 't1' } }),
      );
      expect((req as { user?: unknown }).user).toEqual({
        userId: 'u1',
        tenantId: 't1',
        role: 'agent',
        emailVerified: true,
      });
      expect(jwt.canActivate).not.toHaveBeenCalled();
    });

    it('refuses an unknown, used, expired or other-tenant ticket with a plain 401', async () => {
      tickets.redeem.mockResolvedValue(null);
      await expect(
        guard.canActivate(context(request({ query: { ticket: 'tk' } }))),
      ).rejects.toMatchObject({
        status: 401,
        response: { code: 'UNAUTHORIZED' },
      });
    });

    it('refuses a missing, empty, huge or non-string ticket without touching the database', async () => {
      for (const query of [
        {},
        { ticket: '' },
        { ticket: 'x'.repeat(201) },
        { ticket: ['a', 'b'] },
      ]) {
        await expect(
          guard.canActivate(context(request({ query }))),
        ).rejects.toMatchObject({
          status: 401,
        });
      }
      expect(tickets.redeem).not.toHaveBeenCalled();
    });

    it('NEVER takes the access token from the query string', async () => {
      for (const query of [
        { access_token: 'jwt' },
        { token: 'jwt' },
        { authorization: 'Bearer jwt' },
      ]) {
        await expect(
          guard.canActivate(context(request({ query }))),
        ).rejects.toMatchObject({
          status: 401,
        });
      }
      expect(jwt.canActivate).not.toHaveBeenCalled();
      expect(tickets.redeem).not.toHaveBeenCalled();
    });

    it('refuses a user who was disabled, deleted or lost a valid role since the ticket was issued', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      await expect(
        guard.canActivate(context(request({ query: { ticket: 'tk' } }))),
      ).rejects.toMatchObject({ status: 401 });
      prisma.tenantUser.findFirst.mockResolvedValue({
        role: 'agent',
        status: 'disabled',
        emailVerifiedAt: null,
        passwordChangedAt: null,
      });
      await expect(
        guard.canActivate(context(request({ query: { ticket: 'tk' } }))),
      ).rejects.toMatchObject({
        status: 401,
        response: { code: 'ACCOUNT_DISABLED' },
      });
      prisma.tenantUser.findFirst.mockResolvedValue({
        role: 'janitor',
        status: 'active',
        emailVerifiedAt: null,
        passwordChangedAt: null,
      });
      await expect(
        guard.canActivate(context(request({ query: { ticket: 'tk' } }))),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('refuses a ticket issued before the last password change', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue({
        role: 'agent',
        status: 'active',
        emailVerifiedAt: null,
        passwordChangedAt: new Date(issuedAt.getTime() + 1000),
      });
      await expect(
        guard.canActivate(context(request({ query: { ticket: 'tk' } }))),
      ).rejects.toMatchObject({ status: 401 });
    });

    it.each([
      ['suspended', 'TENANT_SUSPENDED'],
      ['closed', 'TENANT_CLOSED'],
    ])('refuses a %s tenant', async (status, code) => {
      prisma.tenant.findUnique.mockResolvedValue({ status });
      await expect(
        guard.canActivate(context(request({ query: { ticket: 'tk' } }))),
      ).rejects.toMatchObject({ status: 403, response: { code } });
    });
  });
});

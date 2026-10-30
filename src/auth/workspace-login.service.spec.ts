import * as bcrypt from 'bcrypt';
import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { PrismaService } from '../prisma/prisma.service';
import { LoginThrottleService } from './login-throttle.service';
import { SessionTokenService } from './session-token.service';
import {
  MAX_COMPARED_PASSWORDS,
  WorkspaceLoginService,
} from './workspace-login.service';
import { WorkspaceSelectionTokenService } from './workspace-selection-token.service';

jest.mock('bcrypt', () => {
  const actual = jest.requireActual('bcrypt');
  return { ...actual, compare: jest.fn(actual.compare) };
});

const IP = '203.0.113.7';

describe('WorkspaceLoginService (J2)', () => {
  let prisma: PrismaMock;
  let sessionTokens: { sign: jest.Mock };
  let selection: { sign: jest.Mock; verify: jest.Mock };
  let throttle: {
    assertAllowed: jest.Mock;
    recordFailure: jest.Mock;
    recordSuccess: jest.Mock;
  };
  let service: WorkspaceLoginService;
  let hashA: string;
  let hashB: string;

  const PASSWORD_A = 'password-for-a';
  const PASSWORD_B = 'password-for-b';

  const membership = (over: Record<string, unknown> = {}) => ({
    id: 'u1',
    tenantId: 't1',
    role: 'owner',
    status: 'active',
    passwordHash: hashA,
    passwordChangedAt: null,
    tokensValidAfter: null,
    tenant: { slug: 'acme', name: 'Acme', status: 'active' },
    ...over,
  });

  beforeAll(() => {
    hashA = bcrypt.hashSync(PASSWORD_A, 4);
    hashB = bcrypt.hashSync(PASSWORD_B, 4);
  });

  beforeEach(() => {
    prisma = createPrismaMock();
    sessionTokens = {
      sign: jest.fn((u: string, t: string) => `session:${u}:${t}`),
    };
    selection = {
      sign: jest.fn().mockReturnValue({ token: 'sel.token', expiresIn: 600 }),
      verify: jest.fn(),
    };
    throttle = {
      assertAllowed: jest.fn(),
      recordFailure: jest.fn(),
      recordSuccess: jest.fn(),
    };
    service = new WorkspaceLoginService(
      prisma as unknown as PrismaService,
      sessionTokens as unknown as SessionTokenService,
      selection as unknown as WorkspaceSelectionTokenService,
      throttle as unknown as LoginThrottleService,
    );
    (bcrypt.compare as unknown as jest.Mock).mockClear();
  });

  describe('loginByEmail', () => {
    const dto = { email: 'Person@Acme.com', password: PASSWORD_A };

    it('lists only the workspaces whose password matched, sorted by name, with the count of the others', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([
        membership({
          id: 'u2',
          tenantId: 't2',
          role: 'agent',
          tenant: { slug: 'zeta', name: 'Zeta', status: 'active' },
        }),
        membership({
          id: 'u3',
          tenantId: 't3',
          passwordHash: hashB,
          tenant: { slug: 'beta', name: 'Beta', status: 'active' },
        }),
        membership(),
      ]);
      const res = await service.loginByEmail(dto, IP);

      expect(res.workspaces).toEqual([
        {
          tenantId: 't1',
          slug: 'acme',
          name: 'Acme',
          role: 'owner',
          available: true,
        },
        {
          tenantId: 't2',
          slug: 'zeta',
          name: 'Zeta',
          role: 'agent',
          available: true,
        },
      ]);
      expect(res.unmatchedCount).toBe(1);
      expect(res.selectionToken).toBe('sel.token');
      expect(res.expiresIn).toBe(600);
      // the token proves exactly the matched memberships, by user id
      expect(selection.sign).toHaveBeenCalledWith(['u2', 'u1']);
      // two available workspaces: no shortcut, no access token
      expect(res).not.toHaveProperty('access_token');
      expect(sessionTokens.sign).not.toHaveBeenCalled();
    });

    it('a workspace of another password never appears in the answer, not even by name', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([
        membership(),
        membership({
          id: 'u9',
          tenantId: 't9',
          passwordHash: hashB,
          tenant: { slug: 'secret-co', name: 'Secret Co', status: 'active' },
        }),
      ]);
      const res = await service.loginByEmail(dto, IP);
      expect(JSON.stringify(res)).not.toContain('secret-co');
      expect(JSON.stringify(res)).not.toContain('Secret Co');
      expect(JSON.stringify(res)).not.toContain('t9');
      expect(selection.sign).toHaveBeenCalledWith(['u1']);
    });

    it('exactly one available workspace: also returns the access token and the workspace (skip the picker)', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([membership()]);
      const res = await service.loginByEmail(dto, IP);
      expect(res).toMatchObject({
        access_token: 'session:u1:t1',
        workspace: {
          tenantId: 't1',
          slug: 'acme',
          name: 'Acme',
          role: 'owner',
        },
        unmatchedCount: 0,
      });
      expect(sessionTokens.sign).toHaveBeenCalledWith('u1', 't1', 'owner');
    });

    it('one available among unavailable ones still counts as the one way in', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([
        membership(),
        membership({
          id: 'u2',
          tenantId: 't2',
          status: 'disabled',
          tenant: { slug: 'b', name: 'B', status: 'active' },
        }),
      ]);
      const res = await service.loginByEmail(dto, IP);
      expect(res.access_token).toBe('session:u1:t1');
      expect(res.workspaces).toHaveLength(2);
    });

    it.each([
      ['a disabled user', { status: 'disabled' }, 'ACCOUNT_DISABLED'],
      [
        'a suspended workspace',
        { tenant: { slug: 'acme', name: 'Acme', status: 'suspended' } },
        'TENANT_SUSPENDED',
      ],
      [
        'a closed workspace',
        { tenant: { slug: 'acme', name: 'Acme', status: 'closed' } },
        'TENANT_CLOSED',
      ],
    ])(
      '%s is listed as unavailable with a reason, and gets no access token',
      async (_name, over, reason) => {
        prisma.tenantUser.findMany.mockResolvedValue([membership(over)]);
        const res = await service.loginByEmail(dto, IP);
        expect(res.workspaces[0]).toMatchObject({ available: false, reason });
        expect(res).not.toHaveProperty('access_token');
        expect(sessionTokens.sign).not.toHaveBeenCalled();
        // the proof still lists it: selecting it later answers the same error as the slug login
        expect(selection.sign).toHaveBeenCalledWith(['u1']);
      },
    );

    it('a wrong password and an unknown email: the same generic 401, counted as failures, nothing revealed', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([membership()]);
      const wrong = service.loginByEmail({ ...dto, password: 'nope-nope' }, IP);
      await expect(wrong).rejects.toMatchObject({
        status: 401,
        response: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid credentials',
        },
      });

      prisma.tenantUser.findMany.mockResolvedValue([]);
      await expect(service.loginByEmail(dto, IP)).rejects.toMatchObject({
        status: 401,
        response: {
          code: 'INVALID_CREDENTIALS',
          message: 'Invalid credentials',
        },
      });
      expect(throttle.recordFailure).toHaveBeenCalledTimes(2);
      expect(throttle.recordFailure).toHaveBeenCalledWith(
        IP,
        'person@acme.com',
      );
      expect(selection.sign).not.toHaveBeenCalled();
    });

    it('asks the throttle first (with the normalised email) and does no work when it says no', async () => {
      throttle.assertAllowed.mockImplementation(() => {
        throw Object.assign(new Error('slow down'), { status: 429 });
      });
      await expect(service.loginByEmail(dto, IP)).rejects.toMatchObject({
        status: 429,
      });
      expect(throttle.assertAllowed).toHaveBeenCalledWith(
        IP,
        'person@acme.com',
      );
      expect(prisma.tenantUser.findMany).not.toHaveBeenCalled();
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('a correct password clears the failures of that email at that address', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([membership()]);
      await service.loginByEmail(dto, IP);
      expect(throttle.recordSuccess).toHaveBeenCalledWith(
        IP,
        'person@acme.com',
      );
      expect(throttle.recordFailure).not.toHaveBeenCalled();
    });

    it('looks the email up normalised, bounded, and selects only the columns a login needs', async () => {
      prisma.tenantUser.findMany.mockResolvedValue([membership()]);
      await service.loginByEmail(dto, IP);
      const query = prisma.tenantUser.findMany.mock.calls[0][0];
      expect(query.where).toEqual({ email: 'person@acme.com' });
      expect(query.take).toBe(100);
      expect(query.select).toBeDefined();
      expect(query.include).toBeUndefined();
    });

    describe('bcrypt cost', () => {
      const compares = () =>
        (bcrypt.compare as unknown as jest.Mock).mock.calls;

      it(`always runs exactly ${MAX_COMPARED_PASSWORDS} comparisons: for an unknown email, one account, or many`, async () => {
        prisma.tenantUser.findMany.mockResolvedValue([]);
        await service.loginByEmail(dto, IP).catch(() => undefined);
        expect(compares()).toHaveLength(MAX_COMPARED_PASSWORDS);

        (bcrypt.compare as unknown as jest.Mock).mockClear();
        prisma.tenantUser.findMany.mockResolvedValue([membership()]);
        await service.loginByEmail(dto, IP);
        expect(compares()).toHaveLength(MAX_COMPARED_PASSWORDS);

        (bcrypt.compare as unknown as jest.Mock).mockClear();
        prisma.tenantUser.findMany.mockResolvedValue(
          Array.from({ length: 40 }, (_, i) =>
            membership({
              id: `u${i}`,
              tenantId: `t${i}`,
              passwordHash: bcrypt.hashSync(`other-password-${i % 7}`, 4),
              tenant: { slug: `s${i}`, name: `W${i}`, status: 'active' },
            }),
          ),
        );
        await service.loginByEmail(dto, IP).catch(() => undefined);
        expect(compares()).toHaveLength(MAX_COMPARED_PASSWORDS);
      });

      it('workspaces that share a password share one comparison however many there are (a reset by email gives them one hash)', async () => {
        prisma.tenantUser.findMany.mockResolvedValue(
          Array.from({ length: 30 }, (_, i) =>
            membership({
              id: `u${i}`,
              tenantId: `t${i}`,
              tenant: {
                slug: `s${i}`,
                name: `W${String(i).padStart(2, '0')}`,
                status: 'active',
              },
            }),
          ),
        );
        const res = await service.loginByEmail(dto, IP);
        // thirty workspaces, one real comparison: all thirty are listed
        expect(res.workspaces).toHaveLength(30);
        expect(res.unmatchedCount).toBe(0);
        const real = compares().filter(([, hash]) => hash === hashA);
        expect(real).toHaveLength(1);
      });

      it('beyond the cap the remaining different passwords are not tried: they count as unmatched', async () => {
        const hashes = Array.from({ length: 5 }, (_, i) =>
          bcrypt.hashSync(`pw-${i}`, 4),
        );
        // newest first: hashes 0..4; the right one (hashA) is the OLDEST, 6th distinct hash
        prisma.tenantUser.findMany.mockResolvedValue([
          ...hashes.map((passwordHash, i) =>
            membership({
              id: `x${i}`,
              tenantId: `tx${i}`,
              passwordHash,
              tenant: { slug: `x${i}`, name: `X${i}`, status: 'active' },
            }),
          ),
          membership(),
        ]);
        await expect(service.loginByEmail(dto, IP)).rejects.toMatchObject({
          status: 401,
        });
      });

      it('the padding comparisons can never grant access, even to the password the dummy hash was made from', async () => {
        prisma.tenantUser.findMany.mockResolvedValue([
          membership({ passwordHash: hashB }),
        ]);
        await expect(
          service.loginByEmail({ ...dto, password: 'not-a-real-password' }, IP),
        ).rejects.toMatchObject({ status: 401 });
      });
    });
  });

  describe('selectWorkspace', () => {
    const dto = { selectionToken: 'sel.token', tenantId: 't1' };
    const claims = {
      userIds: ['u1', 'u2'],
      iat: 1_800_000_000,
      iatMs: 1_800_000_000_500,
    };

    beforeEach(() => {
      selection.verify.mockReturnValue(claims);
      prisma.tenantUser.findFirst.mockResolvedValue(membership());
    });

    it('opens the workspace: the lookup needs BOTH an id from the token and the asked tenant', async () => {
      const res = await service.selectWorkspace(dto);
      expect(prisma.tenantUser.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['u1', 'u2'] }, tenantId: 't1' },
        }),
      );
      expect(res).toEqual({
        access_token: 'session:u1:t1',
        workspace: {
          tenantId: 't1',
          slug: 'acme',
          name: 'Acme',
          role: 'owner',
        },
      });
    });

    it('a bad or expired token is 401 SELECTION_TOKEN_INVALID and nothing is read', async () => {
      selection.verify.mockImplementation(() => {
        throw Object.assign(new Error('bad'), { status: 401 });
      });
      await expect(service.selectWorkspace(dto)).rejects.toMatchObject({
        status: 401,
      });
      expect(prisma.tenantUser.findFirst).not.toHaveBeenCalled();
    });

    it('a workspace the token did not prove is 403 WORKSPACE_NOT_SELECTABLE (it cannot tell "not listed" from "does not exist")', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(null);
      await expect(
        service.selectWorkspace({ ...dto, tenantId: 'other-tenant' }),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'WORKSPACE_NOT_SELECTABLE' },
      });
      expect(sessionTokens.sign).not.toHaveBeenCalled();
    });

    it('re-checks the user: a disabled user gets 403 ACCOUNT_DISABLED', async () => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        membership({ status: 'disabled' }),
      );
      await expect(service.selectWorkspace(dto)).rejects.toMatchObject({
        status: 403,
        response: { code: 'ACCOUNT_DISABLED' },
      });
    });

    it.each([
      ['suspended', 'TENANT_SUSPENDED'],
      ['closed', 'TENANT_CLOSED'],
    ])('re-checks the workspace: %s gives 403 %s', async (status, code) => {
      prisma.tenantUser.findFirst.mockResolvedValue(
        membership({ tenant: { slug: 'acme', name: 'Acme', status } }),
      );
      await expect(service.selectWorkspace(dto)).rejects.toMatchObject({
        status: 403,
        response: { code },
      });
      expect(sessionTokens.sign).not.toHaveBeenCalled();
    });

    describe('J1: logout and password change after the token was issued', () => {
      it('a logout after the password was typed ends the selection (401 SELECTION_TOKEN_INVALID)', async () => {
        prisma.tenantUser.findFirst.mockResolvedValue(
          membership({ tokensValidAfter: new Date(claims.iatMs + 1000) }),
        );
        await expect(service.selectWorkspace(dto)).rejects.toMatchObject({
          status: 401,
          response: { code: 'SELECTION_TOKEN_INVALID' },
        });
        expect(sessionTokens.sign).not.toHaveBeenCalled();
      });

      it('so does a password change (a reset by email) after it', async () => {
        prisma.tenantUser.findFirst.mockResolvedValue(
          membership({ passwordChangedAt: new Date(claims.iatMs + 1) }),
        );
        await expect(service.selectWorkspace(dto)).rejects.toMatchObject({
          status: 401,
          response: { code: 'SELECTION_TOKEN_INVALID' },
        });
      });

      it('a logout or password change BEFORE the password was typed does not matter', async () => {
        prisma.tenantUser.findFirst.mockResolvedValue(
          membership({
            tokensValidAfter: new Date(claims.iatMs - 60_000),
            passwordChangedAt: new Date(claims.iatMs - 120_000),
          }),
        );
        await expect(service.selectWorkspace(dto)).resolves.toHaveProperty(
          'access_token',
        );
      });

      it('a logout in the very same second but before the token was issued does not matter (millisecond precision)', async () => {
        const sameSecondEarlier = new Date(claims.iatMs - 300);
        prisma.tenantUser.findFirst.mockResolvedValue(
          membership({ tokensValidAfter: sameSecondEarlier }),
        );
        await expect(service.selectWorkspace(dto)).resolves.toHaveProperty(
          'access_token',
        );
      });
    });

    it('can be used again for another listed workspace until it expires (switching)', async () => {
      await service.selectWorkspace(dto);
      prisma.tenantUser.findFirst.mockResolvedValue(
        membership({ id: 'u2', tenantId: 't2' }),
      );
      await expect(
        service.selectWorkspace({ ...dto, tenantId: 't2' }),
      ).resolves.toMatchObject({ access_token: 'session:u2:t2' });
    });
  });
});

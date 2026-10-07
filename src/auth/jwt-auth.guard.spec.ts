import { ExecutionContext } from '@nestjs/common';
import { createPrismaMock, PrismaMock } from '../../test/utils/prisma-mock';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let prisma: PrismaMock;
  let passportCanActivate: jest.SpyInstance;

  const contextFor = (request: Record<string, unknown>) =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    prisma = createPrismaMock();
    guard = new JwtAuthGuard(prisma as unknown as PrismaService);
    // The passport part (token verification) is covered by the strategy spec and the e2e tests.
    passportCanActivate = jest
      .spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype), 'canActivate')
      .mockResolvedValue(true);
  });

  afterEach(() => passportCanActivate.mockRestore());

  const request = (tenantParam?: string, tenantId = 'tenant-a') => ({
    params: tenantParam ? { tenantId: tenantParam } : {},
    user: { userId: 'u1', tenantId, role: 'owner' },
  });

  it('passes when the URL tenant equals the token tenant and the tenant is active', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ status: 'active' });
    await expect(
      guard.canActivate(contextFor(request('tenant-a'))),
    ).resolves.toBe(true);
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: 'tenant-a' },
      select: { status: true },
    });
  });

  it('allows a trial tenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ status: 'trial' });
    await expect(
      guard.canActivate(contextFor(request('tenant-a'))),
    ).resolves.toBe(true);
  });

  it('403 TENANT_MISMATCH when the URL names another tenant, before any database lookup', async () => {
    await expect(
      guard.canActivate(contextFor(request('tenant-b'))),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'TENANT_MISMATCH' },
    });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('checks the tenant status from the token even on routes without :tenantId', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ status: 'suspended' });
    await expect(
      guard.canActivate(contextFor(request(undefined))),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'TENANT_SUSPENDED' },
    });
  });

  it('403 TENANT_SUSPENDED for a suspended tenant', async () => {
    prisma.tenant.findUnique.mockResolvedValue({ status: 'suspended' });
    await expect(
      guard.canActivate(contextFor(request('tenant-a'))),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'TENANT_SUSPENDED' },
    });
  });

  it('401 when the tenant in the token no longer exists', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    await expect(
      guard.canActivate(contextFor(request('tenant-a'))),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('does nothing further when passport rejects the token', async () => {
    passportCanActivate.mockRejectedValue(new Error('Unauthorized'));
    await expect(
      guard.canActivate(contextFor(request('tenant-a'))),
    ).rejects.toThrow('Unauthorized');
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});

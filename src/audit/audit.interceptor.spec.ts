import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AUDIT_KEY } from './audit.decorator';
import { AuditInterceptor } from './audit.interceptor';

describe('AuditInterceptor', () => {
  let audit: { record: jest.Mock };
  let interceptor: AuditInterceptor;
  const handler = () => undefined;

  const context = (request: object) =>
    ({
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => request }),
    }) as unknown as ExecutionContext;
  const next = (result: unknown): CallHandler => ({ handle: () => of(result) });

  const request = {
    params: { tenantId: 'tenant-a', id: 'inv-1' },
    user: { userId: 'u1', tenantId: 'tenant-a', role: 'admin' },
  };

  beforeEach(() => {
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    interceptor = new AuditInterceptor(new Reflector(), audit as any);
    Reflect.defineMetadata(
      AUDIT_KEY,
      { action: 'invite.revoked', targetType: 'invite' },
      handler,
    );
  });

  it('records after the handler succeeds, with tenant and actor from the request and the target from the route', async () => {
    const result = { id: 'inv-1', email: 'a@b.co', tokenHash: 'h' };
    await expect(
      lastValueFrom(interceptor.intercept(context(request), next(result))),
    ).resolves.toBe(result);
    expect(audit.record).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      actor: { userId: 'u1', role: 'admin' },
      action: 'invite.revoked',
      targetType: 'invite',
      targetId: 'inv-1',
      before: undefined,
      after: result,
    });
  });

  it('can keep the result as the "before" state (deletes) or nothing at all', async () => {
    Reflect.defineMetadata(
      AUDIT_KEY,
      { action: 'x.deleted', snapshot: 'before' },
      handler,
    );
    await lastValueFrom(
      interceptor.intercept(context(request), next({ id: 'r' })),
    );
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: { id: 'r' }, after: undefined }),
    );

    Reflect.defineMetadata(
      AUDIT_KEY,
      { action: 'x', snapshot: 'none' },
      handler,
    );
    await lastValueFrom(
      interceptor.intercept(context(request), next({ id: 'r' })),
    );
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ before: undefined, after: undefined }),
    );
  });

  it('takes the target id from the result when the route has no :id', async () => {
    await lastValueFrom(
      interceptor.intercept(
        context({ ...request, params: { tenantId: 'tenant-a' } }),
        next({ id: 'new-1' }),
      ),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'new-1' }),
    );
  });

  it('records nothing when the handler fails', async () => {
    await expect(
      lastValueFrom(
        interceptor.intercept(context(request), {
          handle: () => throwError(() => new Error('boom')),
        }),
      ),
    ).rejects.toThrow('boom');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not fail the request when the entry cannot be written, but logs it', async () => {
    const error = jest
      .spyOn((interceptor as any).logger, 'error')
      .mockImplementation(() => undefined);
    audit.record.mockRejectedValue(new Error('db down'));
    await expect(
      lastValueFrom(interceptor.intercept(context(request), next({ id: 'r' }))),
    ).resolves.toEqual({ id: 'r' });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'invite.revoked' }),
    );
  });

  it('skips handlers without @Audit and requests without a tenant', async () => {
    Reflect.deleteMetadata(AUDIT_KEY, handler);
    await lastValueFrom(interceptor.intercept(context(request), next(1)));
    expect(audit.record).not.toHaveBeenCalled();

    Reflect.defineMetadata(AUDIT_KEY, { action: 'x' }, handler);
    await lastValueFrom(
      interceptor.intercept(context({ params: {} }), next(1)),
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});

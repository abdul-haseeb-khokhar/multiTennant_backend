import { JwtService } from '@nestjs/jwt';
import { SessionTokenService } from './session-token.service';

describe('SessionTokenService', () => {
  it('signs a tenant-scoped token with subject, tenant and role', () => {
    const jwt = {
      sign: jest.fn().mockReturnValue('jwt'),
    } as unknown as JwtService;
    expect(new SessionTokenService(jwt).sign('u1', 't1', 'agent')).toBe('jwt');
    expect(jwt.sign).toHaveBeenCalledWith({
      sub: 'u1',
      tenantId: 't1',
      role: 'agent',
      scope: 'tenant',
    });
  });
});

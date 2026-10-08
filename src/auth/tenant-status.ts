import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';

/**
 * Refuses a tenant that may not be used at all. `status` is the `tenants.status` mirror of the
 * subscription (suspended by a platform admin, or closed): 403 TENANT_SUSPENDED / TENANT_CLOSED.
 * Used by the staff guard, login and invite acceptance.
 */
export function assertTenantUsable(status: string): void {
  if (status === 'suspended') {
    throw new ApiException(
      HttpStatus.FORBIDDEN,
      ErrorCode.TENANT_SUSPENDED,
      'This tenant is suspended',
    );
  }
  if (status === 'closed') {
    throw new ApiException(
      HttpStatus.FORBIDDEN,
      ErrorCode.TENANT_CLOSED,
      'This account is closed',
    );
  }
}

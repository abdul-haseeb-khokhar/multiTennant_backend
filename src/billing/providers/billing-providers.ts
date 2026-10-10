import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../../common/errors/api.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { BillingProvider } from './billing-provider';
import { ManualProvider } from './manual.provider';

/**
 * Looks a provider up by the name stored on the subscription. Registering a new provider means
 * adding it to this constructor (and to `BillingCoreModule`); nothing else changes.
 */
@Injectable()
export class BillingProviders {
  private readonly byName = new Map<string, BillingProvider>();

  constructor(readonly manual: ManualProvider) {
    for (const provider of [manual]) {
      this.byName.set(provider.name, provider);
    }
  }

  get(name: string): BillingProvider {
    const provider = this.byName.get(name);
    if (!provider) {
      throw new ApiException(
        HttpStatus.NOT_IMPLEMENTED,
        ErrorCode.NOT_IMPLEMENTED,
        `Billing provider "${name}" is not available`,
      );
    }
    return provider;
  }
}

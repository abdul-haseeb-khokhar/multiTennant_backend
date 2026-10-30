import { Injectable, OnModuleInit } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { PhoneCustomersService } from '../end-customers/phone-customers.service';
import { EngineClient } from '../engine/engine-client';
import { MockEngineClient } from '../engine/mock-engine.client';
import type { EngineBackendPort } from '../engine/engine.types';
import { TenantStatusService } from '../tenant-status/tenant-status.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { InternalRequestsService } from './internal-requests.service';

/**
 * With the mock engine (`ENGINE_MODE=mock`) a simulated call asks the backend what the real engine
 * will ask over HTTP: whether the business may be served (status check), who the caller is (customer
 * upsert) and to save the request. This hands the mock the SAME services the internal routes run, so a
 * test or a manual run through the mock proves what the routes do. The real engine does not use this.
 */
@Injectable()
export class MockEngineBackendBridge implements OnModuleInit {
  constructor(
    private readonly engine: EngineClient,
    private readonly status: TenantStatusService,
    private readonly customers: PhoneCustomersService,
    private readonly requests: InternalRequestsService,
  ) {}

  onModuleInit() {
    if (!(this.engine instanceof MockEngineClient)) return;
    this.engine.setBackend(this.port());
  }

  port(): EngineBackendPort {
    return {
      tenantStatus: (tenantId, agentId) => this.status.check(tenantId, agentId),
      upsertCustomer: (tenantId, input) =>
        this.customers.upsertForCall(tenantId, input),
      createRequest: async (tenantId, input) => {
        try {
          const saved = await this.requests.create(tenantId, {
            ...input,
            reference: input.reference.toUpperCase(),
          } as CreateRequestDto);
          return {
            ok: true,
            id: saved.id,
            agentId: saved.agentId,
            reference: saved.reference,
            created: saved.created,
          };
        } catch (error) {
          if (isCode(error, ErrorCode.REQUEST_REFERENCE_TAKEN)) {
            return { ok: false, reason: 'reference_taken' };
          }
          throw error;
        }
      },
      updateRequest: (tenantId, reference, change) =>
        refused(() =>
          this.requests.updateDetails(
            tenantId,
            reference.toUpperCase(),
            change,
          ),
        ),
      withdrawRequest: (tenantId, reference, reason) =>
        refused(() =>
          this.requests.withdraw(tenantId, reference.toUpperCase(), { reason }),
        ),
    };
  }
}

function isCode(error: unknown, code: ErrorCode): boolean {
  return error instanceof ApiException && error.code === code;
}

/** Runs an engine write and turns "locked" and "not found" into the answers the engine reads. */
async function refused(
  run: () => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; reason: 'locked' | 'not_found' }> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    if (isCode(error, ErrorCode.REQUEST_LOCKED)) {
      return { ok: false, reason: 'locked' };
    }
    if (isCode(error, ErrorCode.REQUEST_NOT_FOUND)) {
      return { ok: false, reason: 'not_found' };
    }
    throw error;
  }
}

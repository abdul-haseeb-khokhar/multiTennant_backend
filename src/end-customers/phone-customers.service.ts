import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';

/** `external_id` of an end customer who reached us by telephone: `phone_<E.164>` (like `web_<visitorId>` for the widget). */
export const PHONE_EXTERNAL_ID_PREFIX = 'phone_';

/** International form: `+`, a non-zero first digit, 7 to 15 digits in all. */
export const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;

export function phoneExternalId(phone: string): string {
  return `${PHONE_EXTERNAL_ID_PREFIX}${phone}`;
}

/** The caller's number when the end customer came in by phone, else null. */
export function phoneOfExternalId(externalId: string): string | null {
  if (!externalId.startsWith(PHONE_EXTERNAL_ID_PREFIX)) return null;
  const phone = externalId.slice(PHONE_EXTERNAL_ID_PREFIX.length);
  return E164_PATTERN.test(phone) ? phone : null;
}

export interface PhoneCustomerInput {
  /** E.164, already validated. */
  phone: string;
  name?: string;
  locale?: string;
}

/**
 * Finds or creates the end customer of a caller by phone number (L4.3, M3.7: the backend creates end
 * customers; his B4 `PUT …/customers/by-phone`). The number is the customer's `external_id`
 * (`phone_+9230…`), unique per tenant, so someone who calls twice is one customer. Every query carries
 * the tenant. The newest details do NOT overwrite: the name and the locale are only filled in when the
 * customer has none yet (a staff member may have corrected them). The number is personal data (F1):
 * never logged, never put in an audit entry or a URL.
 */
@Injectable()
export class PhoneCustomersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * What the engine's route does: the tenant must exist and the agent (if one is named) must belong
   * to it (404 TENANT_NOT_FOUND / AGENT_NOT_FOUND), then the customer is upserted.
   */
  async upsertForCall(
    tenantId: string,
    input: PhoneCustomerInput & { agentId?: string },
  ) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.TENANT_NOT_FOUND,
        'Tenant not found',
      );
    }
    if (input.agentId !== undefined) {
      const agent = await this.prisma.agent.findFirst({
        where: { id: input.agentId, tenantId },
        select: { id: true },
      });
      if (!agent) {
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          ErrorCode.AGENT_NOT_FOUND,
          'Agent not found',
        );
      }
    }
    return this.upsert(tenantId, input);
  }

  async upsert(
    tenantId: string,
    input: PhoneCustomerInput,
  ): Promise<{ endCustomerId: string; created: boolean }> {
    const externalId = phoneExternalId(input.phone);
    const existing = await this.find(tenantId, externalId);
    if (existing) {
      await this.fillMissing(tenantId, existing.id, input);
      return { endCustomerId: existing.id, created: false };
    }
    try {
      const created = await this.prisma.endCustomer.create({
        data: {
          tenantId,
          externalId,
          name: input.name ?? null,
          locale: input.locale ?? null,
        },
        select: { id: true },
      });
      return { endCustomerId: created.id, created: true };
    } catch (error) {
      // A parallel call for the same number created it first: that customer is the one.
      if (!isPrismaError(error, 'P2002')) throw error;
      const winner = await this.find(tenantId, externalId);
      if (!winner) throw error;
      await this.fillMissing(tenantId, winner.id, input);
      return { endCustomerId: winner.id, created: false };
    }
  }

  private find(tenantId: string, externalId: string) {
    return this.prisma.endCustomer.findFirst({
      where: { tenantId, externalId },
      select: { id: true },
    });
  }

  private async fillMissing(
    tenantId: string,
    id: string,
    input: PhoneCustomerInput,
  ) {
    if (input.name) {
      await this.prisma.endCustomer.updateMany({
        where: { id, tenantId, name: null },
        data: { name: input.name },
      });
    }
    if (input.locale) {
      await this.prisma.endCustomer.updateMany({
        where: { id, tenantId, locale: null },
        data: { locale: input.locale },
      });
    }
  }
}

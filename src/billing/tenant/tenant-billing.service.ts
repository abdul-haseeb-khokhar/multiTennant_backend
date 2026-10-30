import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuthUser } from '../../auth/roles';
import { ApiException } from '../../common/errors/api.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { resolvePage, toPage } from '../../common/pagination/pagination';
import { PaginationQueryDto } from '../../common/pagination/pagination-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { OverageService } from '../overage.service';
import type { EffectiveSubscription } from '../subscriptions/effective-subscription';
import { SubscriptionService } from '../subscriptions/subscription.service';
import { UpdateBillingSettingsDto } from './dto/update-billing-settings.dto';
import {
  toAdminInvoiceView,
  toAdminSubscriptionSummary,
  toBillingEventView,
  toCallMinuteUsageView,
  toConversationUsageView,
  toInvoiceView,
  toSubscriptionSummary,
} from '../views';

/** Read side of billing: what a tenant's owner sees, and the fuller view a platform admin sees. */
@Injectable()
export class TenantBillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
    private readonly overage: OverageService,
  ) {}

  /** `GET /tenants/:tenantId/billing`: current plan, status, period, entitlements and invoices. */
  async getForTenant(tenantId: string, query: PaginationQueryDto) {
    const subscription = await this.subscriptions.getEffective(tenantId);
    if (!subscription) {
      throw this.noSubscription(tenantId);
    }
    const page = resolvePage(query);
    const [invoices, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { tenantId },
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.invoice.count({ where: { tenantId } }),
    ]);
    return {
      subscription: toSubscriptionSummary(subscription),
      usage: await this.usageView(subscription),
      invoices: toPage(invoices.map(toInvoiceView), total, page),
    };
  }

  /** `PATCH /tenants/:tenantId/billing/settings` (owner): the J6 overage switch. Answers with the new subscription summary. */
  async updateSettings(
    tenantId: string,
    actor: AuthUser,
    dto: UpdateBillingSettingsDto,
  ) {
    await this.subscriptions.setOverageEnabled(tenantId, dto.overageEnabled, {
      userId: actor.userId,
      role: actor.role,
    });
    const subscription = await this.subscriptions.getEffective(tenantId);
    if (!subscription) {
      throw this.noSubscription(tenantId);
    }
    return {
      subscription: toSubscriptionSummary(subscription),
      usage: await this.usageView(subscription),
    };
  }

  /** `GET /admin/tenants/:id/subscription`: subscription, invoices and the billing event log. */
  async getForAdmin(tenantId: string, query: PaginationQueryDto) {
    await this.assertTenantExists(tenantId);
    const subscription = await this.subscriptions.getEffective(tenantId);
    if (!subscription) {
      throw this.noSubscription(tenantId);
    }
    const page = resolvePage(query);
    const [invoices, invoiceTotal, events, eventTotal] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { tenantId },
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.invoice.count({ where: { tenantId } }),
      this.prisma.billingEvent.findMany({
        where: { tenantId },
        skip: page.skip,
        take: page.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.billingEvent.count({ where: { tenantId } }),
    ]);
    return {
      subscription: toAdminSubscriptionSummary(subscription),
      usage: await this.usageView(subscription),
      invoices: toPage(invoices.map(toAdminInvoiceView), invoiceTotal, page),
      events: toPage(events.map(toBillingEventView), eventTotal, page),
    };
  }

  private async usageView(subscription: EffectiveSubscription) {
    const [callMinutes, conversations] = await Promise.all([
      this.overage.callMinuteSummary(subscription),
      this.overage.conversationSummary(subscription),
    ]);
    return {
      callMinutes: toCallMinuteUsageView(callMinutes),
      conversations: toConversationUsageView(conversations),
    };
  }

  async assertTenantExists(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.TENANT_NOT_FOUND,
        `Tenant ${tenantId} not found`,
      );
    }
  }

  private noSubscription(tenantId: string) {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      ErrorCode.SUBSCRIPTION_NOT_FOUND,
      `Tenant ${tenantId} has no subscription`,
    );
  }
}

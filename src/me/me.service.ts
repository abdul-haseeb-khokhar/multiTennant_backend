import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthUser } from '../auth/roles';
import { SubscriptionService } from '../billing/subscriptions/subscription.service';
import { toSubscriptionSummary } from '../billing/views';
import { ApiException } from '../common/errors/api.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { isPrismaError } from '../common/errors/prisma-errors';
import { DEFAULT_LOCALE } from '../i18n/locales';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateMeDto } from './dto/update-me.dto';

/** The signed-in staff member's own profile (the tenant always comes from the verified token). */
@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionService,
  ) {}

  async get(actor: AuthUser) {
    const user = await this.prisma.tenantUser.findFirst({
      where: { id: actor.userId, tenantId: actor.tenantId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        emailVerifiedAt: true,
        locale: true,
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            plan: true,
            status: true,
            defaultLocale: true,
          },
        },
      },
    });
    if (!user) {
      throw new UnauthorizedException();
    }
    const { tenant, emailVerifiedAt, ...profile } = user;
    // Due plan transitions are applied on read, so the banner never shows a plan that has ended.
    const subscription = await this.subscriptions.getEffective(actor.tenantId);
    // For the bell: how many of MY notifications are unread (H5).
    const unreadNotifications = await this.prisma.notification.count({
      where: { tenantId: actor.tenantId, userId: actor.userId, readAt: null },
    });
    return {
      user: { ...profile, emailVerified: emailVerifiedAt !== null },
      tenant,
      subscription: subscription ? toSubscriptionSummary(subscription) : null,
      unreadNotifications,
      locale: user.locale ?? tenant.defaultLocale ?? DEFAULT_LOCALE,
    };
  }

  async update(actor: AuthUser, dto: UpdateMeDto) {
    try {
      await this.prisma.tenantUser.update({
        where: { id: actor.userId, tenantId: actor.tenantId },
        data: { name: dto.name, locale: dto.locale },
      });
    } catch (error) {
      if (isPrismaError(error, 'P2025')) {
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          ErrorCode.USER_NOT_FOUND,
          'User not found',
        );
      }
      throw error;
    }
    return this.get(actor);
  }
}

import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { QueryNotificationDto } from './dto/query-notification.dto';
import {
  MarkAllReadResult,
  Notification,
} from './entities/notification.entity';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('tenants/:tenantId/notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: 'My notifications, newest first (every role)',
    description:
      "Only the caller's own notifications (no role sees another person's). `?unread=true` returns the unread ones; `total` is then the unread count. The unread count is also in `GET /v1/me` (`unreadNotifications`). New ones arrive live as `notification.created` on the event stream.",
  })
  @ApiPaginatedResponse(Notification)
  findAll(
    @Param('tenantId') tenantId: string,
    @Query() query: QueryNotificationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.notifications.findAll(tenantId, user.userId, query);
  }

  // Declared before ':id/read' so "read-all" is never taken for an id.
  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: 'Mark all my notifications read (idempotent)',
  })
  @ApiOkResponse({ type: MarkAllReadResult })
  readAll(@Param('tenantId') tenantId: string, @CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(tenantId, user.userId);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @Roles('owner', 'admin', 'agent')
  @ApiOperation({
    summary: 'Mark one of my notifications read (idempotent)',
    description:
      "Reading one that is already read changes nothing. Someone else's notification answers 404 NOTIFICATION_NOT_FOUND.",
  })
  @ApiOkResponse({ type: Notification })
  @ApiNotFoundResponse({ description: 'NOTIFICATION_NOT_FOUND' })
  read(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.notifications.markRead(tenantId, user.userId, id);
  }
}

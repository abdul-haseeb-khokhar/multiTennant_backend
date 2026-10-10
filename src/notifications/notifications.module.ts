import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsCoreModule } from './notifications-core.module';

/** In-app notifications (H5): the API each staff member reads their own notifications through. */
@Module({
  imports: [AuthModule, NotificationsCoreModule],
  controllers: [NotificationsController],
  exports: [NotificationsCoreModule],
})
export class NotificationsModule {}

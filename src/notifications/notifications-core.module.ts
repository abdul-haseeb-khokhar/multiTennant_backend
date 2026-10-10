import { Module } from '@nestjs/common';
import { RealtimeCoreModule } from '../realtime/realtime-core.module';
import { HousekeepingService } from './housekeeping.service';
import { NotificationsService } from './notifications.service';

/**
 * The notification table service and the housekeeping purge, without controllers or authentication
 * imports, so the billing job can create reminders without a module cycle (the HTTP side is
 * `NotificationsModule`).
 */
@Module({
  imports: [RealtimeCoreModule],
  providers: [NotificationsService, HousekeepingService],
  exports: [NotificationsService, HousekeepingService],
})
export class NotificationsCoreModule {}

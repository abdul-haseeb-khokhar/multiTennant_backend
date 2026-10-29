import { Module } from '@nestjs/common';
import { NotificationsCoreModule } from '../notifications/notifications-core.module';
import { RealtimeCoreModule } from '../realtime/realtime-core.module';
import { PhoneCustomersService } from '../end-customers/phone-customers.service';
import { TenantStatusModule } from '../tenant-status/tenant-status.module';
import { InternalRequestsService } from './internal-requests.service';
import { MockEngineBackendBridge } from './mock-engine-backend.bridge';
import { RequestsLive } from './request-views';

/**
 * The request services other modules depend on (no controllers, no authentication imports, so the
 * event receiver can import it without a cycle): saving and correcting requests for the engine, the
 * customer upsert by phone, the live updates, and with the mock engine the bridge that lets a
 * simulated call use all of it. The HTTP side is `RequestsModule`.
 */
@Module({
  imports: [NotificationsCoreModule, RealtimeCoreModule, TenantStatusModule],
  providers: [
    InternalRequestsService,
    PhoneCustomersService,
    RequestsLive,
    MockEngineBackendBridge,
  ],
  exports: [InternalRequestsService, PhoneCustomersService, RequestsLive],
})
export class RequestsCoreModule {}

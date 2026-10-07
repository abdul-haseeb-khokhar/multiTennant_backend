import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditLogsController } from './audit-logs.controller';
import { AuditInterceptor } from './audit.interceptor';
import { AuditService } from './audit.service';

/** Global so any feature module can record entries without importing this one. */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AuditLogsController],
  providers: [AuditService, AuditInterceptor],
  exports: [AuditService],
})
export class AuditModule {}

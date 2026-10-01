import { Module } from '@nestjs/common';
import { TenantUsersService } from './tenant-users.service';
import { TenantUsersController } from './tenant-users.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [TenantUsersController],
  providers: [TenantUsersService],
  exports: [TenantUsersService]
})
export class TenantUsersModule {}

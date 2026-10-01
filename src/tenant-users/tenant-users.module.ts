import { Module } from '@nestjs/common';
import { TenantUsersService } from './tenant-users.service';
import { TenantUsersController } from './tenant-users.controller';

@Module({
  controllers: [TenantUsersController],
  providers: [TenantUsersService],
})
export class TenantUsersModule {}

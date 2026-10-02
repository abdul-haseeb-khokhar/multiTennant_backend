import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TenantsModule } from './tenants/tenants.module';
import { PrismaModule } from './prisma/prisma.module';
import { TenantUsersModule } from './tenant-users/tenant-users.module';
import { AuthModule } from './auth/auth.module';
import { EndCustomersModule } from './end-customers/end-customers.module';

@Module({
  imports: [TenantsModule, PrismaModule, TenantUsersModule, AuthModule, EndCustomersModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

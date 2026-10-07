import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { validateEnv } from './config/env.validation';
import { EndCustomersModule } from './end-customers/end-customers.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { TenantUsersModule } from './tenant-users/tenant-users.module';
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [
    // Loads `.env` into process.env (so Prisma sees DATABASE_URL too) and refuses to boot on a
    // missing or malformed variable such as JWT_SECRET.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    AuthModule,
    TenantsModule,
    TenantUsersModule,
    EndCustomersModule,
    HealthModule,
  ],
})
export class AppModule {}

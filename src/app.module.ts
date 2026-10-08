import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { RequestContextInterceptor } from './common/request-context/request-context.interceptor';
import { validateEnv } from './config/env.validation';
import { DataUseModule } from './data-use/data-use.module';
import { EndCustomersModule } from './end-customers/end-customers.module';
import { HealthModule } from './health/health.module';
import { I18nModule } from './i18n/i18n.module';
import { InvitesModule } from './invites/invites.module';
import { MailModule } from './mail/mail.module';
import { MeModule } from './me/me.module';
import { PrismaModule } from './prisma/prisma.module';
import { TenantUsersModule } from './tenant-users/tenant-users.module';
import { TenantsModule } from './tenants/tenants.module';

@Module({
  imports: [
    // Loads `.env` into process.env (so Prisma sees DATABASE_URL too) and refuses to boot on a
    // missing or malformed variable such as JWT_SECRET.
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    AuditModule,
    MailModule,
    AuthModule,
    TenantsModule,
    TenantUsersModule,
    InvitesModule,
    EndCustomersModule,
    BillingModule,
    DataUseModule,
    MeModule,
    I18nModule,
    HealthModule,
  ],
  providers: [
    // Gives the audit log the request id, IP and user agent without passing `req` around.
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
  ],
})
export class AppModule {}

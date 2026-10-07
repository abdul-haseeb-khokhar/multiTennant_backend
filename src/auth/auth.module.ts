import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { RateLimiter } from '../common/throttle/rate-limiter';
import { MailModule } from '../mail/mail.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailVerificationController } from './email-verification.controller';
import { EmailVerificationService } from './email-verification.service';
import { EmailVerifiedGuard } from './email-verified.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformJwtAuthGuard } from './platform-jwt-auth.guard';
import { PlatformJwtStrategy } from './platform-jwt.strategy';
import { RolesGuard } from './roles.guard';
import { SessionTokenService } from './session-token.service';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: config.get('JWT_EXPIRES_IN', '1d') as any,
        },
      }),
    }),
    MailModule,
  ],
  providers: [
    AuthService,
    PlatformAuthService,
    SessionTokenService,
    EmailVerificationService,
    PasswordResetService,
    RateLimiter,
    JwtStrategy,
    PlatformJwtStrategy,
    JwtAuthGuard,
    PlatformJwtAuthGuard,
    RolesGuard,
    EmailVerifiedGuard,
  ],
  controllers: [
    AuthController,
    PlatformAuthController,
    PasswordResetController,
    EmailVerificationController,
  ],
  exports: [
    JwtAuthGuard,
    PlatformJwtAuthGuard,
    RolesGuard,
    EmailVerifiedGuard,
    SessionTokenService,
    EmailVerificationService,
    PassportModule,
  ],
})
export class AuthModule {}

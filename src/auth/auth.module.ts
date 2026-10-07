import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformJwtAuthGuard } from './platform-jwt-auth.guard';
import { PlatformJwtStrategy } from './platform-jwt.strategy';
import { RolesGuard } from './roles.guard';

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
  ],
  providers: [
    AuthService,
    PlatformAuthService,
    JwtStrategy,
    PlatformJwtStrategy,
    JwtAuthGuard,
    PlatformJwtAuthGuard,
    RolesGuard,
  ],
  controllers: [AuthController, PlatformAuthController],
  exports: [JwtAuthGuard, PlatformJwtAuthGuard, RolesGuard, PassportModule],
})
export class AuthModule {}

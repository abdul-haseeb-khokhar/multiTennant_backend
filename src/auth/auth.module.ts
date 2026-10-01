import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { TenantUsersModule } from '../tenant-users/tenant-users.module';

@Module({
  imports: [
    TenantUsersModule, PassportModule, JwtModule.register({
      secret:process.env.JWT_SECRET,
      signOptions: {expiresIn: (process.env.JWT_EXPIRES_IN ?? '1d') as any},
    }),
  ],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [JwtAuthGuard]
})
export class AuthModule {}

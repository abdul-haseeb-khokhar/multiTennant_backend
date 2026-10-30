import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPlatformAdmin } from './current-platform-admin.decorator';
import { PlatformJwtAuthGuard } from './platform-jwt-auth.guard';
import type { PlatformUser } from './platform-jwt.strategy';
import { PlatformLoginDto } from './dto/platform-login.dto';
import { AccessToken } from './entities/access-token.entity';
import { PlatformAuthService } from './platform-auth.service';

@ApiTags('platform-admin')
@Controller('admin/auth')
export class PlatformAuthController {
  constructor(private readonly platformAuthService: PlatformAuthService) {}

  @Post('login')
  @ApiOperation({
    summary: 'Platform-admin login (our own staff, not tenant users)',
  })
  @ApiCreatedResponse({ type: AccessToken })
  login(@Body() dto: PlatformLoginDto) {
    return this.platformAuthService.login(dto);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(PlatformJwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Log out of every session of this platform admin',
    description:
      'Every platform token issued before now stops working, on every device (J1).',
  })
  @ApiNoContentResponse()
  async logout(@CurrentPlatformAdmin() admin: PlatformUser) {
    await this.platformAuthService.logout(admin.adminId);
  }
}

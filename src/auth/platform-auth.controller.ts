import { Body, Controller, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
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
}

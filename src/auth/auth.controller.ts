import { Body, Controller, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { AccessToken } from './entities/access-token.entity';
import { SignupResponse } from './entities/signup-response.entity';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @ApiOperation({ summary: 'Staff login with tenant slug, email and password' })
  @ApiCreatedResponse({ type: AccessToken })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('signup')
  @ApiOperation({ summary: 'Create a tenant and its owner account' })
  @ApiCreatedResponse({ type: SignupResponse })
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }
}

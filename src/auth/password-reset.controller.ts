import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
} from './dto/password-reset.dto';
import { PasswordResetService } from './password-reset.service';

class PasswordResetRequested {
  @ApiPropertyOptional({
    description:
      'Only with MAIL_MODE=link (development): the reset link, so it can be passed on by hand.',
  })
  link?: string;
}

@ApiTags('auth')
@Controller('auth/password-reset')
export class PasswordResetController {
  constructor(private readonly passwordResetService: PasswordResetService) {}

  @Post('request')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Ask for a password-reset email',
    description:
      'Always answers 202, whether or not the account exists. Limited per IP (429) and per email.',
  })
  @ApiAcceptedResponse({ type: PasswordResetRequested })
  request(@Body() dto: PasswordResetRequestDto, @Ip() ip: string) {
    return this.passwordResetService.request(dto, ip);
  }

  @Post('confirm')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Set a new password with the emailed token',
    description:
      'The token is single use and valid for one hour. Tokens issued before this call stop working.',
  })
  @ApiNoContentResponse()
  async confirm(@Body() dto: PasswordResetConfirmDto) {
    await this.passwordResetService.confirm(dto);
  }
}

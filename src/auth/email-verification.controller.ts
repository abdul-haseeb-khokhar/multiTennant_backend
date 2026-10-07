import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from './current-user.decorator';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { EmailVerificationService } from './email-verification.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { Roles } from './roles';
import type { AuthUser } from './roles';
import { RolesGuard } from './roles.guard';

class VerificationSent {
  @ApiPropertyOptional({
    description:
      'Only with MAIL_MODE=link (development): the verification link.',
  })
  link?: string;
}

@ApiTags('auth')
@Controller('auth/verify-email')
export class EmailVerificationController {
  constructor(
    private readonly emailVerificationService: EmailVerificationService,
  ) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: 'Confirm an email address with the emailed token' })
  @ApiNoContentResponse()
  async verify(@Body() dto: VerifyEmailDto) {
    await this.emailVerificationService.verify(dto.token);
  }

  @Post('resend')
  @HttpCode(202)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'admin', 'agent')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Send a new verification email to the signed-in user',
    description: 'Does nothing when the address is already verified.',
  })
  @ApiAcceptedResponse({ type: VerificationSent })
  resend(@CurrentUser() actor: AuthUser) {
    return this.emailVerificationService.resend(actor);
  }
}

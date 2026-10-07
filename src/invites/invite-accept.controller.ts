import { Body, Controller, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AcceptInviteDto } from '../auth/dto/accept-invite.dto';
import { AcceptInviteResponse } from './entities/staff-invite.entity';
import { InvitesService } from './invites.service';

@ApiTags('auth')
@Controller('auth/invites')
export class InviteAcceptController {
  constructor(private readonly invitesService: InvitesService) {}

  @Post('accept')
  @ApiOperation({
    summary: 'Accept an invitation: choose a password and sign in',
    description:
      'Public. The token comes from the emailed link, is single use and valid for seven days. The new user is created with the invited role and a verified email.',
  })
  @ApiCreatedResponse({ type: AcceptInviteResponse })
  accept(@Body() dto: AcceptInviteDto) {
    return this.invitesService.accept(dto);
  }
}

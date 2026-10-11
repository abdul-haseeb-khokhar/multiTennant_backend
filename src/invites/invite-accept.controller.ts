import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AcceptInviteDto } from '../auth/dto/accept-invite.dto';
import { PreviewInviteQueryDto } from './dto/preview-invite.dto';
import {
  AcceptInviteResponse,
  InvitePreview,
} from './entities/staff-invite.entity';
import { InvitesService } from './invites.service';

@ApiTags('auth')
@Controller('auth/invites')
export class InviteAcceptController {
  constructor(private readonly invitesService: InvitesService) {}

  @Get('preview')
  @ApiOperation({
    summary: 'What an invitation is for (public, rate limited)',
    description:
      'For the accept page: the workspace name, the role, the invited address and the expiry. An unknown, expired, used or revoked token (or a suspended workspace) all answer 400 INVITE_INVALID, so nothing leaks about which tokens exist. Limited to 30 requests per minute per IP address (429 with Retry-After).',
  })
  @ApiOkResponse({ type: InvitePreview })
  @ApiBadRequestResponse({ description: 'INVITE_INVALID' })
  @ApiTooManyRequestsResponse({ description: 'TOO_MANY_REQUESTS' })
  preview(@Query() query: PreviewInviteQueryDto, @Req() request: Request) {
    return this.invitesService.preview(query.token, request.ip ?? 'unknown');
  }

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

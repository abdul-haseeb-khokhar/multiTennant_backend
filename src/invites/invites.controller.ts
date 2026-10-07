import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Audit } from '../audit/audit.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { CreateInviteDto } from './dto/create-invite.dto';
import { QueryInviteDto } from './dto/query-invite.dto';
import { StaffInvite } from './entities/staff-invite.entity';
import { InvitesService } from './invites.service';

@ApiTags('invites')
@ApiBearerAuth()
@Controller('tenants/:tenantId/invites')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  @Post()
  @UseGuards(EmailVerifiedGuard)
  @Roles('owner', 'admin')
  @ApiOperation({
    summary: 'Invite a staff member by email (owner/admin)',
    description:
      'An admin may invite admin or agent; only an owner may invite an owner. The caller must have a verified email (403 EMAIL_NOT_VERIFIED). Re-inviting the same address replaces the pending invite.',
  })
  @ApiCreatedResponse({ type: StaffInvite })
  create(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateInviteDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.invitesService.create(tenantId, dto, actor);
  }

  @Get()
  @Roles('owner', 'admin')
  @ApiOperation({ summary: 'List pending invites (owner/admin)' })
  @ApiPaginatedResponse(StaffInvite)
  findAll(@Param('tenantId') tenantId: string, @Query() query: QueryInviteDto) {
    return this.invitesService.findAll(tenantId, query);
  }

  @Delete(':id')
  @Roles('owner', 'admin')
  @Audit('invite.revoked', { targetType: 'invite' })
  @ApiOperation({
    summary:
      'Revoke a pending invite (owner/admin; only an owner for an owner invite)',
  })
  @ApiOkResponse({ type: StaffInvite })
  revoke(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.invitesService.revoke(tenantId, id, actor);
  }
}

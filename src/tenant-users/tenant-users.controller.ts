import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles';
import type { AuthUser } from '../auth/roles';
import { RolesGuard } from '../auth/roles.guard';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { QueryTenantUserDto } from './dto/query-tenant-user.dto';
import { UpdateTenantUserDto } from './dto/update-tenant-user.dto';
import { TenantUser } from './entities/tenant-user.entity';
import { TenantUsersService } from './tenant-users.service';

@ApiTags('users')
@ApiBearerAuth()
@Controller('tenants/:tenantId/users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantUsersController {
  constructor(private readonly tenantUsersService: TenantUsersService) {}

  @Get()
  @Roles('owner', 'admin', 'agent')
  @ApiPaginatedResponse(TenantUser)
  @ApiOperation({
    summary: 'List the team (every role)',
    description:
      '`passwordChangedAt` and `emailVerifiedAt` are left out of the answer for the `agent` role: only owners and admins see them.',
  })
  findAll(
    @Param('tenantId') tenantId: string,
    @Query() query: QueryTenantUserDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tenantUsersService.findAll(tenantId, query, actor);
  }

  @Get(':id')
  @Roles('owner', 'admin', 'agent')
  @ApiOkResponse({ type: TenantUser })
  @ApiOperation({
    summary: 'One team member (every role)',
    description:
      'Same fields as the list: `passwordChangedAt` and `emailVerifiedAt` only for owners and admins.',
  })
  findOne(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tenantUsersService.findOne(tenantId, id, actor);
  }

  @Patch(':id')
  @Roles('owner', 'admin')
  @ApiOperation({
    summary:
      'Change email, role or status (owner/admin; only an owner can touch an owner)',
  })
  @ApiOkResponse({ type: TenantUser })
  update(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTenantUserDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tenantUsersService.update(tenantId, id, dto, actor);
  }

  @Delete(':id')
  @Roles('owner', 'admin')
  @ApiOkResponse({ type: TenantUser })
  remove(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.tenantUsersService.remove(tenantId, id, actor);
  }
}

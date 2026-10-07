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
  findAll(
    @Param('tenantId') tenantId: string,
    @Query() query: QueryTenantUserDto,
  ) {
    return this.tenantUsersService.findAll(tenantId, query);
  }

  @Get(':id')
  @Roles('owner', 'admin', 'agent')
  @ApiOkResponse({ type: TenantUser })
  findOne(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.tenantUsersService.findOne(tenantId, id);
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
